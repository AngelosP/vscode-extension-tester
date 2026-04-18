# Writing Test Features

## Overview

Tests are written as [Gherkin](https://cucumber.io/docs/gherkin/) `.feature` files — an industry-standard BDD format that reads like plain English.

## Available Steps

### Setup (Given)

| Step | Description |
|------|-------------|
| `Given VS Code is running with extension "<path-or-id>"` | Launch VS Code with the specified extension |
| `Given VS Code is running version "<version>"` | Use a specific VS Code version |
| `Given extension "<id>" is installed from "<source>"` | Install an additional extension |
| `Given recording is enabled as "<format>"` | Enable recording (mp4 / gif) |
| `Given debug capture is enabled` | Enable debug capture |

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

### Via Copilot CLI (natural language)

```
copilot "Test the Hello World extension by running its helloWorld command and verifying the notification appears"
```

### Via MCP tool call

```json
{
  "tool": "run_feature",
  "arguments": {
    "content": "features/examples/basic-extension.feature",
    "testData": { "AZURE_TEST_USER": "user@example.com" }
  }
}
```
