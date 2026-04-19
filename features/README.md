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
  runs/                         # Artifacts (gitignored)
    default/
      smoke-test/
        report.md
        results.json
```

The reserved folder name `default` is used when no `--reuse-named-profile`, `--reuse-or-create-named-profile`, or `--clone-named-profile` flag is passed.

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
| `When I execute command "<commandId>"` | Run a VS Code command (Ctrl+Shift+P) |
| `When I select "<label>" from the QuickPick` | Choose an item from the QuickPick |
| `When I type "<text>" into the InputBox` | Type into the InputBox |
| `When I click "<button>" on the dialog` | Click a dialog button |
| `When I sign in with Microsoft as "<user>"` | Handle full Microsoft auth flow |
| `When I open file "<path>"` | Open a file in the editor |
| `When I run "<command>" in the terminal` | Run a terminal command |
| `When I wait <N> seconds` | Wait for a specified duration |

### Assertions (Then)

| Step | Description |
|------|-------------|
| `Then I should see notification "<text>"` | Assert a notification appeared |
| `Then the editor should contain "<text>"` | Assert editor content |
| `Then the output channel "<name>" should contain "<text>"` | Assert output channel content |
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
