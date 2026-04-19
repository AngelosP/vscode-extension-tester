# Architecture

This document describes the high-level architecture of `vscode-ext-test`.

## Overview

The system has two halves that communicate over a WebSocket JSON-RPC channel:

1. **CLI** (`packages/cli`) - runs on the user's machine, orchestrates tests, and hosts the AI agent.
2. **Controller Extension** (`packages/controller-extension`) - runs inside the VS Code Extension Host, exposing remote-control capabilities.

```
┌─────────────────────────────────────────────────────────────────────┐
│  User Machine                                                       │
│                                                                     │
│  ┌──────────────────────────┐      ┌──────────────────────────────┐ │
│  │  CLI  (Node.js)          │      │  VS Code  (Dev Host)         │ │
│  │                          │      │                              │ │
│  │  ┌───────────────────┐   │      │  ┌────────────────────────┐  │ │
│  │  │ Gherkin Parser    │   │      │  │ Controller Extension   │  │ │
│  │  └───────┬───────────┘   │      │  │                        │  │ │
│  │          │               │ WS   │  │  WebSocket Server      │  │ │
│  │  ┌───────▼───────────┐   │◄────►│  │  Command Executor      │  │ │
│  │  │ Test Runner       │   │ JSON │  │  UI Interceptor        │  │ │
│  │  └───────┬───────────┘   │ RPC  │  │  State Reader          │  │ │
│  │          │               │      │  │  Output Monitor        │  │ │
│  │  ┌───────▼───────────┐   │      │  │  Auth Handler          │  │ │
│  │  │ AI Agent Loop     │   │      │  └────────────────────────┘  │ │
│  │  │  • LLM calls      │   │      │                              │ │
│  │  │  • 20 tools       │   │      └──────────────────────────────┘ │
│  │  │  • Memory         │   │                                       │
│  │  └───────────────────┘   │      ┌──────────────────────────────┐ │
│  │                          │      │  FlaUI Bridge  (.NET, opt.)  │ │
│  └──────────────────────────┘      └──────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

## Package Structure

```
vscode-extension-tester/
├── packages/
│   ├── cli/                    # The CLI tool (npm: vscode-ext-test)
│   │   ├── bin/                #   Entry point
│   │   └── src/
│   │       ├── cli.ts          #   Command registration (commander.js)
│   │       ├── agent/          #   AI agent subsystem
│   │       │   ├── agent-loop.ts   # Observe → think → act loop
│   │       │   ├── llm.ts         # GitHub Models API + model cascade
│   │       │   ├── tools.ts       # 20 tool definitions + dispatch
│   │       │   ├── memory.ts      # Per-extension persistent memory
│   │       │   └── env.ts         # .env file parser
│   │       ├── commands/       #   CLI command implementations
│   │       │   ├── run.ts         # Execute .feature tests
│   │       │   ├── tests-add.ts   # AI-powered test generation
│   │       │   ├── init.ts        # Project scaffolding
│   │       │   ├── install.ts     # Controller extension installer
│   │       │   └── uninstall.ts   # Controller extension removal
│   │       ├── runner/         #   Test execution engine
│   │       │   ├── test-runner.ts     # Gherkin step → controller dispatch
│   │       │   ├── controller-client.ts  # WebSocket JSON-RPC client
│   │       │   ├── gherkin-parser.ts     # .feature file parser
│   │       │   ├── native-ui-client.ts   # FlaUI bridge client
│   │       │   └── cdp-client.ts         # Chrome DevTools Protocol client
│   │       ├── modes/          #   Execution modes
│   │       │   ├── dev-mode.ts    # Attach to running Dev Host
│   │       │   └── ci-mode.ts     # Launch isolated VS Code instance
│   │       └── utils/
│   │           └── reporter.ts    # Test result formatting
│   └── controller-extension/   # VS Code extension (runs in Dev Host)
│       └── src/
│           ├── extension.ts        # Activation + WS server bootstrap
│           ├── ws-server.ts        # WebSocket JSON-RPC server
│           ├── command-executor.ts # Execute VS Code commands
│           ├── ui-interceptor.ts   # Intercept QuickPick/InputBox/Dialog
│           ├── state-reader.ts     # Read editor/terminal/notification state
│           ├── output-monitor.ts   # Capture output channel content
│           ├── auth-handler.ts     # Handle authentication flows
│           └── debug-config-provider.ts  # Debug launch config
├── dotnet/                     # FlaUI native UI bridge (optional, Windows)
│   ├── Program.cs              #   .NET host entry point
│   ├── FlaUIBridge.cs          #   FlaUI automation wrapper
│   └── FlaUIBridge.csproj      #   .NET 8 project
├── features/                   # Gherkin test conventions + examples
│   ├── README.md
│   └── examples/
│       ├── basic-extension.feature
│       ├── auth-flow.feature
│       └── complex-workflow.feature
└── tests/                      # Integration/e2e tests for this project
```

## Key Subsystems

### 1. CLI & Commands (`packages/cli/src/commands/`)

The CLI is built with [Commander.js](https://github.com/tj/commander.js). Each command is a standalone module:

- **`run`** - The main test executor. Parses `.feature` files, connects to the controller, and dispatches steps. Supports two modes:
  - *Dev mode* (`--attach-devhost`): Connects to a Dev Host that's already running.
  - *CI mode*: Downloads VS Code via `@vscode/test-electron`, launches it with the controller extension, runs tests, and exits.
- **`tests add`** - The AI-powered test generation command. Analyzes the extension's source code, builds a system prompt, and runs the agent loop to generate `.feature` files. If previous failures exist (`.agent-resume.json`), it self-heals.
- **`init`** - Scaffolds a new test project: installs the controller extension, creates a `.feature` template, and wires up `launch.json` / `tasks.json`.

### 2. AI Agent (`packages/cli/src/agent/`)

The agent follows an **observe → think → act** loop:

1. The system prompt describes the extension under test and available tools.
2. The LLM (via GitHub Models) decides which tool to call.
3. The tool executes (e.g., running a VS Code command, reading a file).
4. The result is fed back to the LLM.
5. Repeat until the agent calls `done` or exhausts the iteration budget.

**Model cascade** (`llm.ts`): Probes GitHub Models for availability and falls back through a priority list. Supports function calling.

**Tools** (`tools.ts`): 20 tools spanning VS Code control, filesystem, git, test execution, and memory. Each tool is a JSON schema definition + an executor function.

**Memory** (`memory.ts`): Writes/reads markdown files in `.agent-memory/` scoped to the extension under test. Lets the agent accumulate knowledge across sessions (e.g., "this extension uses tree views", "command X requires auth first").

### 3. Test Runner (`packages/cli/src/runner/`)

Bridges Gherkin semantics to controller calls:

- **`gherkin-parser.ts`** - Parses `.feature` files into structured `ParsedFeature` / `ParsedScenario` / `ParsedStep` objects.
- **`test-runner.ts`** - Iterates scenarios and steps, dispatching each step to the controller. Handles Background steps, step timeouts, and `.env` variable interpolation (`${VAR}`).
- **`controller-client.ts`** - WebSocket client implementing a simple JSON-RPC protocol. Sends requests (method + params) and awaits responses.
- **`cdp-client.ts`** - Chrome DevTools Protocol client for deeper browser-level introspection (screenshot capture, DOM access).
- **`native-ui-client.ts`** - Client for the FlaUI .NET bridge, used for OS-level dialog automation (file pickers, message boxes).

### 4. Controller Extension (`packages/controller-extension/src/`)

Runs inside the VS Code Extension Host. Activated when `VSCODE_EXT_TESTER_PORT` is set in the environment.

- **`ws-server.ts`** - Listens on the configured port, accepts one client, and dispatches JSON-RPC requests to handlers.
- **`command-executor.ts`** - Calls `vscode.commands.executeCommand()` for any registered command.
- **`ui-interceptor.ts`** - Monkey-patches `vscode.window.showQuickPick`, `showInputBox`, and `showInformationMessage` (and variants) to queue UI events and allow programmatic responses from the CLI.
- **`state-reader.ts`** - Reads the current editor, visible text editors, terminals, and workspace state.
- **`output-monitor.ts`** - Patches `vscode.window.createOutputChannel` at load time to capture all output channel content for later retrieval.
- **`auth-handler.ts`** - Handles `vscode.authentication` session flows.

### 5. FlaUI Bridge (`dotnet/`)

An optional .NET 8 process that uses [FlaUI](https://github.com/FlaUI/FlaUI) to automate native Windows UI elements that can't be reached through the VS Code API (e.g., OS file dialogs, system message boxes). Communicates with the CLI over stdin/stdout.

## Communication Protocol

The CLI and controller extension communicate over WebSocket using a minimal JSON-RPC-like protocol:

```
CLI → Controller:  { "id": 1, "method": "executeCommand", "params": { "commandId": "workbench.action.openSettings" } }
Controller → CLI:  { "id": 1, "result": null }
```

```
CLI → Controller:  { "id": 2, "method": "getState", "params": {} }
Controller → CLI:  { "id": 2, "result": { "activeEditor": "README.md", "terminals": [...], ... } }
```

Events (notifications, QuickPick appearances) are pushed from the controller without a request ID.

## Data Flow: Running a Test

```
.feature file
    │
    ▼
Gherkin Parser ─────► ParsedFeature[]
    │
    ▼
Test Runner
    │
    ├─ For each Scenario:
    │   ├─ For each Step:
    │   │   ├─ Interpolate ${ENV_VARS}
    │   │   ├─ Map step text → controller method
    │   │   ├─ Send JSON-RPC over WebSocket ──────► Controller Extension
    │   │   ├─ Wait for response ◄─────────────────┘
    │   │   └─ Record StepResult (pass/fail/skip)
    │   └─ Record ScenarioResult
    │
    ▼
Reporter ─────► console / JSON / HTML output
```

## Data Flow: AI Test Generation (`tests add`)

```
User: vscode-ext-test tests add "test the walkthroughs"
    │
    ▼
Analyze extension source code (package.json, src/*.ts)
    │
    ▼
Build system prompt with extension knowledge
    │
    ▼
Agent Loop (observe → think → act):
    │
    ├─ LLM decides: "list commands to find walkthrough-related ones"
    │   └─ Tool: list_commands → controller → response
    │
    ├─ LLM decides: "execute the walkthrough command"
    │   └─ Tool: execute_command → controller → response
    │
    ├─ LLM decides: "check state to see what opened"
    │   └─ Tool: get_state → controller → response
    │
    ├─ LLM decides: "write the .feature file"
    │   └─ Tool: write_feature_file → filesystem
    │
    ├─ LLM decides: "run the tests to verify"
    │   └─ Tool: run_feature → test runner → controller → results
    │
    └─ LLM decides: "done"
        └─ Tool: done → exit loop
    │
    ▼
.feature file written, results reported
```
