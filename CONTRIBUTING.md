# Contributing

## Prerequisites

> **Note:** This project has only been tested on Windows. It may work on macOS/Linux but that is unverified.

- **Windows 10/11**
- **Node.js** >= 20
- **npm** >= 10
- **VS Code** - latest stable
- **GitHub CLI** (`gh`) - for LLM authentication (`gh auth login`)
- **.NET 8 SDK** (optional) - only if working on the FlaUI bridge (Windows-only)

## Setup

```bash
# Clone the repo
git clone https://github.com/<org>/vscode-extension-tester.git
cd vscode-extension-tester

# Install dependencies (all workspaces)
npm install

# Build everything
npx turbo build
```

## Project Layout

This is an npm workspaces monorepo managed by [Turborepo](https://turbo.build):

| Package | Path | Description |
|---------|------|-------------|
| `vscode-ext-test` | `packages/cli` | CLI tool - agent, test runner, commands |
| `vscode-extension-tester-controller` | `packages/controller-extension` | VS Code extension - WS server, UI interception |
| FlaUI Bridge | `dotnet/` | .NET native UI automation (optional) |

See [ARCHITECTURE.md](ARCHITECTURE.md) for a detailed subsystem breakdown.

## Building

```bash
# Build all packages
npx turbo build

# Force rebuild (ignore cache)
npx turbo build --force

# Build a single package
cd packages/cli && npm run build
cd packages/controller-extension && npm run build
```

## Packaging the Controller Extension

After making changes to the controller extension:

```bash
cd packages/controller-extension
npm run package                          # creates .vsix
cp *.vsix ../cli/assets/controller-extension.vsix  # update bundled asset
code --install-extension ../cli/assets/controller-extension.vsix --force
```

## Running Locally

### Dev Mode (attach to a Dev Host)

1. Open the target extension project in VS Code.
2. Press **F5** to launch the Extension Development Host.
3. In a terminal:
   ```bash
   node packages/cli/bin/vscode-ext-test.js run \
     --attach-devhost \
     --extension-path packages/controller-extension \
     --features tests/vscode-extension-tester/e2e
   ```

### AI Test Generation

```bash
cd your-extension/
vscode-ext-test tests add "describe what to test"
```

Requires a GitHub token with Models access. Authenticate with `gh auth login`.

By default, `tests add` uses a live Gherkin session while exploring. It attaches
to an existing Dev Host when possible and otherwise launches one. Use
`--live-mode attach`, `--live-mode launch`, or `--live-mode off` to make that
choice explicit.

### Live JSONL Stepping

```bash
node packages/cli/bin/vscode-ext-test.js live --mode auto
```

The `live` command writes only JSONL protocol messages to stdout and routes logs
to stderr. Keep that boundary intact when changing launch/session code.

## Code Style

- **TypeScript** with strict mode (`tsconfig.base.json`).
- **ES Modules** - all packages use `"type": "module"` and `.js` extensions in imports.
- No linter is enforced yet. Keep code consistent with surrounding files.

## Adding a New CLI Command

1. Create `packages/cli/src/commands/your-command.ts` exporting an async action function.
2. Register it in `packages/cli/src/cli.ts` using Commander's `.command()` API.
3. Rebuild: `npx turbo build`.

## Adding a New Agent Tool

1. Add the tool's JSON schema definition to the `TOOL_DEFINITIONS` array in `packages/cli/src/agent/tools.ts`.
2. Add the executor case in `executeToolCall()` in the same file.
3. If the tool requires controller-side support, add a handler method in the appropriate controller module (`command-executor.ts`, `state-reader.ts`, etc.) and wire it in `ws-server.ts`.
4. For live Gherkin tools, prefer reusing `LiveTestSession` and `TestRunner.runSingleStep()` rather than adding controller-side Gherkin logic.

## Adding a Controller RPC Method

1. Add the handler in the appropriate module under `packages/controller-extension/src/`.
2. Register it in `ws-server.ts`'s method dispatch.
3. Add the corresponding client-side call in `packages/cli/src/runner/controller-client.ts`.

## Writing Tests

Tests are Gherkin `.feature` files. See [features/README.md](features/README.md) for conventions and [features/examples/](features/examples/) for samples.

## Commit Messages

Use clear, imperative commit messages:

```
Add screenshot tool to agent
Fix QuickPick interception race condition
Update model cascade priority list
```

## Pull Requests

- Keep PRs focused - one feature or fix per PR.
- Include a brief description of what changed and why.
- Make sure `npx turbo build` passes before submitting.
