@native @windows
Feature: Native File Open Dialog
  Verify that the FlaUI bridge can interact with the OS-level File Open dialog
  triggered by VS Code's built-in "Open File" command.

  Background:
    Given the extension is in a clean state

  Scenario: Open a file via native File Open dialog
    Given a temp file "native-dialog-test.txt" exists with content "Hello from native dialog test"
    When I start command "workbench.action.files.openFile"
    And I wait 3 seconds
    And I open the file "${TEMP}\native-dialog-test.txt"
    And I wait 3 seconds
    Then the editor should contain "Hello from native dialog test"

  Scenario: Cancel the native File Open dialog
    When I start command "workbench.action.files.openFile"
    And I wait 3 seconds
    And I cancel the Open dialog
    Then I should not see notification "error"
