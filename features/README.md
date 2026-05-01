# Writing Test Features

## Overview

Tests are written as [Gherkin](https://cucumber.io/docs/gherkin/) `.feature` files - an industry-standard BDD format that reads like plain English.

## Directory Convention

Feature files live under `tests/vscode-extension-tester/e2e/<profile>/<test-id>/`:

```
tests/vscode-extension-tester/
  e2e/
    default/                    # Features that run without a named profile
      smoke-test/
        extension.feature
      open-panel/
        panel.feature
    sql-authenticated-profile/  # Features that require a pre-authenticated profile
      sql-auth/
        connection.feature
  runs/                         # Artifacts (gitignored, timestamped)
    default/
      smoke-test/
        20260419-213200/
          report.md
          results.json
  .vscode-ext-test/
    live/                       # Live step artifacts from vscode-ext-test live/tests add
      2026-04-19T21-32-00-000Z/
        live-steps/
        final/
```

The reserved folder name `default` is used when no `--reuse-named-profile`, `--reuse-or-create-named-profile`, or `--clone-named-profile` flag is passed.

Live authoring sessions keep one VS Code window open and write per-step screenshots, output-channel deltas, copied host logs, and `step-result.json` manifests under `.vscode-ext-test/live/<timestamp>/`. Screenshot artifacts include the intended Dev Host process id, captured window process id, title, bounds, and capture method; use that metadata with the PNG to catch wrong-window or stale-window captures. Screenshot capture warnings are copied into step artifacts and reports. This is what `vscode-ext-test live` and `vscode-ext-test tests add --live-mode auto` use while probing steps before committing a full `.feature` file. Live launch/auto sessions accept the same named profile flags as normal runs; auto attach only attaches to an existing Dev Host when the detected user-data directory matches the requested profile.

## Running Tests

### Default launch mode (recommended)

The CLI downloads and launches an isolated VS Code instance automatically:

```bash
# Run all features under e2e/default/ directly
vscode-ext-test run --features tests/vscode-extension-tester/e2e

# Run a specific test ID
vscode-ext-test run --test-id smoke-test

# Run with a named profile
vscode-ext-test run --test-id sql-auth --reuse-named-profile sql-authenticated-profile
```

### Attach mode

Connect to an already-running Dev Host (e.g. launched via F5):

```bash
vscode-ext-test run --attach-devhost --test-id smoke-test
```

## Available Steps

### Setup (Given)

| Step | Description |
|------|-------------|
| `Given the extension is in a clean state` | Reset UI: close all editors, dismiss notifications, clear output channels |
| `Given a file "<path>" exists` | Create an empty file for test setup |
| `Given a file "<path>" exists with content "<text>"` | Create a file with content |
| `Given I capture the output channel "<name>"` | Declare an output channel to capture |

### Actions (When)

| Step | Description |
|------|-------------|
| `When I execute command "<commandId>"` | Run a VS Code command (waits for completion) |
| `When I execute command "<commandId>" with args '<json>'` | Run a VS Code command with arguments (JSON array, e.g. `'["arg1","arg2"]'`) |
| `When I start command "<commandId>"` | Start a VS Code command without waiting (use for commands that show QuickInput) |
| `When I start command "<commandId>" with args '<json>'` | Start a VS Code command with arguments without waiting |
| `When I add folder "<path>" to the workspace` | Add a folder to the workspace without reloading |
| `When I inspect the QuickInput` | Print the current QuickInput title, value, validation, and items |
| `When I select QuickInput item "<label>"` | Choose an item from the captured QuickInput model or visible workbench widget |
| `When I select "<label>" from the QuickInput` | Choose an item from the captured QuickInput model or visible workbench widget |
| `When I select "<label>" from the QuickPick` | Compatibility alias for choosing an item from the QuickPick |
| `When I enter "<text>" in the QuickInput` | Enter and accept QuickInput text after validation clears |
| `When I type "<text>" into the InputBox` | Compatibility alias for entering text in the InputBox |
| `When I click "<action>" on notification "<text>"` | Click/resolve a captured notification action |
| `When I click "<button>" on the dialog` | Click a dialog button |
| `When I type "<text>"` | Type text into the focused editor/input using real input with fallback |
| `When I press "<key>"` | Press a key or combo such as Enter, Escape, Ctrl+S, Shift+Tab |
| `When I click the element "<name>"` | Click an element by accessible name/text |
| `When I right click the element "<name>"` | Right-click an element by accessible name/text |
| `When I middle click the element "<name>"` | Middle-click an element by accessible name/text |
| `When I double click the element "<name>"` | Double-click an element by accessible name/text |
| `When I click "<sel>" in the webview` | Click a webview element by CSS selector |
| `When I right click "<sel>" in the webview` | Right-click a webview element by CSS selector |
| `When I middle click "<sel>" in the webview` | Middle-click a webview element by CSS selector |
| `When I double click "<sel>" in the webview` | Double-click a webview element by CSS selector |
| `When I click the webview element "<text>"` | Click a webview control by visible text, aria-label, title, or role text |
| `When I evaluate "<js>" in the webview for <N> seconds` | Run diagnostic JavaScript in a webview with an explicit timeout budget |
| `When I list the webviews` | Log open webview titles, probed DOM titles, URLs, and bounded visible text evidence |
| `When I move the mouse to <x>, <y>` | Move the OS cursor to coordinates; live sessions use Dev Host window/screenshot-relative coordinates, normal batch runs use absolute screen coordinates |
| `When I click` | Click at the current mouse position |
| `When I right click` | Right-click at the current mouse position |
| `When I middle click` | Middle-click at the current mouse position |
| `When I double click` | Double-click at the current mouse position |
| `When I click at <x>, <y>` | Click coordinates; live sessions use Dev Host window/screenshot-relative coordinates, normal batch runs use absolute screen coordinates |
| `When I right click at <x>, <y>` | Right-click coordinates; live sessions use Dev Host window/screenshot-relative coordinates, normal batch runs use absolute screen coordinates |
| `When I middle click at <x>, <y>` | Middle-click coordinates; live sessions use Dev Host window/screenshot-relative coordinates, normal batch runs use absolute screen coordinates |
| `When I double click at <x>, <y>` | Double-click coordinates; live sessions use Dev Host window/screenshot-relative coordinates, normal batch runs use absolute screen coordinates |
| `When I select "<label>" from the popup menu` | Select from an already-open context/dropdown menu |
| `When I sign in with Microsoft as "<user>"` | Handle full Microsoft auth flow |
| `When I open file "<path>"` | Open a file in the editor |
| `When I run "<command>" in the terminal` | Run a terminal command |
| `When I wait <N> seconds` | Wait for a specified duration |
| `When I capture the output channel "<name>"` | Start capturing a specific output channel (allow-list mode) |
| `When I stop capturing the output channel "<name>"` | Stop capturing a specific output channel |
| `When I set setting "<key>" to "<value>"` | Set any VS Code or extension setting. Values are JSON-parsed: `"true"` → boolean, `"42"` → number, `"null"` → reset to default. Defaults to user/global scope. |
| `When I resize the (window\|Dev Host) to <width>x<height>` | Resize the Dev Host window (also accepts `<width> by <height>`) |
| `When I move the (window\|Dev Host) to <x>, <y>` | Move the Dev Host window (negative coords OK) |

### Input Targeting Guidance

Prefer commands and QuickInput inspection/selection/text steps first; they use captured extension-host state when available and the visible workbench widget as a fallback. Use stable webview CSS selectors next, then webview visible-text clicks when selectors are unavailable, then accessible-name clicks for workbench/native UI. Use raw mouse coordinates
only when no command, selector, visible text, or accessible name can target the UI. In live
sessions, raw coordinates are relative to the full Dev Host window/screenshot,
including title bar and borders; in normal batch runs, they are absolute screen
coordinates. Stabilize the Dev Host window with resize/move steps first. To use a context menu,
right-click to open it, then select the item with the popup menu step.
Prefer QuickInput, progress, and notification wait/assertion steps over fixed waits.

`vscode-ext-test install-into-project` also installs these instructions into downstream repos
as `.github/skills/e2e-test-extension/SKILL.md`. Rerun `install-into-project` after upgrading the
CLI to refresh that generated skill file; `repo-knowledge.md` is preserved.

### Assertions (Then)

| Step | Description |
|------|-------------|
| `Then I should see notification "<text>"` | Assert a notification appeared |
| `Then I should not see notification "<text>"` | Assert a notification did not appear |
| `Then I wait for QuickInput item "<label>"` | Wait for a QuickInput item to be present |
| `Then I wait for QuickInput title "<text>"` | Wait for a QuickInput title |
| `Then I wait for QuickInput value "<value>"` | Wait for the current QuickInput value |
| `Then the QuickInput should contain item "<label>"` | Assert the active QuickInput has an item |
| `Then the QuickInput title should contain "<text>"` | Assert QuickInput title text |
| `Then the QuickInput value should be "<value>"` | Assert QuickInput value |
| `Then I wait for progress "<title>" to start` | Wait for tracked progress to become active |
| `Then I wait for progress "<title>" to complete` | Wait for tracked progress to complete |
| `Then progress "<title>" should be active` | Assert tracked progress is active |
| `Then progress "<title>" should be completed` | Assert tracked progress completed |
| `Then the editor should contain "<text>"` | Assert editor content |
| `Then the output channel "<name>" should contain "<text>"` | Assert output channel content |
| `Then the output channel "<name>" should not contain "<text>"` | Assert output channel does NOT contain text |
| `Then the output channel "<name>" should have been captured` | Assert that any content was captured for the channel |
| `Then the webview should contain "<text>"` | Assert visible webview text and record bounded webview evidence in `results.json` and `report.md` |
| `Then the webview "<title>" should contain "<text>"` | Assert a specific webview and record target-attributed text evidence |
| `Then element "<sel>" should have text "<text>"` | Assert selector text in a webview and record bounded text evidence |
| `Then element "<sel>" should have text "<text>" in the webview` | Assert selector text in a webview and record selector-scoped evidence |
| `Then element "<sel>" should have text "<text>" in the webview "<title>"` | Assert selector text in a specific webview and record target-attributed evidence |
| `Then setting "<key>" should be "<value>"` | Assert a VS Code setting has the expected value (JSON-parsed comparison) |
| `Then the status bar should show "<text>"` | Assert status bar text |

## Variables

Use `${ENV_VAR}` syntax to reference environment variables or test data:

```gherkin
When I sign in with Microsoft as "${AZURE_TEST_USER}"
And I type "${TEST_CONN_STRING}" into the InputBox
```

Set these as environment variables before running tests, or pass them via the `testData` parameter.

## Scenario Outlines

Use `Scenario Outline` with `Examples` tables for parameterized tests:

```gherkin
Scenario Outline: Create project with <language>
  When I execute command "createProject"
  And I select "<language>" from the QuickPick
  Then I should see notification "Created with <language>"

  Examples:
    | language   |
    | JavaScript |
    | Python     |
    | C#         |
```

## Running Tests

See the [Directory Convention](#directory-convention) section above for examples.
