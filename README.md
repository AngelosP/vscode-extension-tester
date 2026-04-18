# vscode-ext-test

E2E test VS Code extensions as if a real user was operating them — with an autonomous AI agent.

## Quick Start

```bash
# Install globally
npm link  # from packages/cli/

# Set up a project
cd your-extension/
vscode-ext-test init          # installs controller, scaffolds configs
vscode-ext-test tests add "describe what to test"  # AI writes tests
```

## Commands

| Command | What it does |
|---------|-------------|
| `init` | Installs controller extension, scaffolds `.feature` file + launch.json + tasks.json |
| `run` | Executes `.feature` tests (dev mode or CI mode) |
| `tests add [context...]` | AI agent analyzes codebase, writes tests, explores live extension, self-heals failures |
| `install` | Installs controller extension + checks prerequisites (gh, git, code) |
| `uninstall` | Removes controller extension |

## Architecture

```
CLI (vscode-ext-test)          Controller Extension (in Dev Host)
┌─────────────────────┐        ┌──────────────────────────────┐
│ Agent Loop           │◄──────►│ WebSocket Server (port 9788) │
│  - LLM (Copilot)    │  WS    │  - Execute commands          │
│  - 20 tools          │  JSON  │  - Intercept UI (QuickPick)  │
│  - Memory system     │  RPC   │  - Read state/notifications  │
│  - Git analysis      │        │  - List commands             │
└─────────────────────┘        └──────────────────────────────┘
```

## Next Steps (TODO)

### Immediate — Test the full flow
1. **Restart VS Code** so the updated controller extension loads
2. **Open kusto-workbench**: `cd C:\Users\angelpe\source\my-tools\vscode-kusto-workbench`
3. **Start Dev Host**: Press F5 (use any extensionHost launch config)
4. **Run**: `vscode-ext-test tests add "test the open walkthroughs command"`
5. **Debug any issues** — the agent should connect to Dev Host, explore, write tests, and run them

### Short-term — Fix & Polish
- [ ] Test `tests add` end-to-end with a real Dev Host session
- [ ] Test the resume flow: if tests fail, run `tests add` again — it should find `.agent-resume.json` and auto-fix
- [ ] Add `tests fix [context...]` command (similar to resume but explicit)
- [ ] Verify `.env` file values flow into `.feature` step text via `${VARIABLE}`
- [ ] Handle edge case: agent tries to run a command that opens a file picker → hangs → needs timeout
- [ ] Update the bundled `.vsix` in `packages/cli/assets/` after controller changes: `cd packages/controller-extension && npm run package && cp *.vsix ../cli/assets/controller-extension.vsix`

### Medium-term — Robustness
- [ ] Add step timeout per-tool-call (if a command hangs, fail gracefully instead of blocking the agent)
- [ ] Add `--verbose` flag for agent loop to show full LLM reasoning
- [ ] Add token usage summary at end of agent run
- [ ] Improve model cascade — update model list as new models become available on GitHub Models
- [ ] Handle rate limiting gracefully (retry with backoff)
- [ ] Test CI mode (`vscode-ext-test run --ci`) in a GitHub Actions workflow

### Long-term — Features
- [ ] Screen recording with ffmpeg (on-failure capture)
- [ ] FlaUI/.NET integration for OS-level dialog automation (the `dotnet/` bridge is already built)
- [ ] MCP server mode for Copilot CLI integration
- [ ] Parallel test execution (multiple scenarios simultaneously)
- [ ] Test coverage reporting (which commands are tested vs untested)

## Build

```bash
# From repo root
npx turbo build --force

# Rebuild + deploy controller extension to VS Code
cd packages/controller-extension
npm run bundle
cp dist/extension.js "$HOME/.vscode/extensions/vscode-extension-tester.vscode-extension-tester-controller-0.1.0/dist/extension.js"
```

## Key Files

```
packages/cli/src/
  cli.ts                    — Command registration
  agent/
    llm.ts                  — GitHub Models API + model cascade
    env.ts                  — .env parser
    memory.ts               — Per-extension memory system
    tools.ts                — 20 agent tools (VS Code control, files, git, etc.)
    agent-loop.ts           — Core observe→think→act loop
  commands/
    tests-add.ts            — The hero command
    run.ts / init.ts / install.ts / uninstall.ts
  runner/
    test-runner.ts          — Step dispatcher (Gherkin → controller calls)
    controller-client.ts    — WebSocket JSON-RPC client
    gherkin-parser.ts       — Cucumber/Gherkin parser

packages/controller-extension/src/
  extension.ts              — Dual-mode activation (Dev Host → WS server, Main → debug config)
  ws-server.ts              — JSON-RPC dispatch (15 methods)
  debug-config-provider.ts  — Zero-config CDP injection
```

## Critical Knowledge (don't forget!)

- **Windows**: Use `code.cmd` not `code` for CLI commands
- **Extension ID**: `vscode-extension-tester.vscode-extension-tester-controller` (publisher.name)
- **Dev Host detection**: Check `VSCODE_EXT_TESTER_PORT` env var, NOT process argv
- **WebSocket polling**: In `--wait-for-devhost`, poll WS directly instead of scanning processes
- **preLaunchTask**: `endsPattern` must match BEFORE debug session launches
