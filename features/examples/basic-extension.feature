Feature: Basic Extension Testing
  As a developer
  I want to verify my extension's commands work
  So that I can ship with confidence

  Background:
    Given VS Code is running with extension "./my-extension.vsix"

  Scenario: Hello World command shows notification
    When I execute command "myExtension.helloWorld"
    Then I should see notification "Hello World!"

  Scenario: Multiple commands execute in sequence
    When I execute command "myExtension.createFile"
    And I type "test.txt" into the InputBox
    Then I should see notification "File created: test.txt"
    When I execute command "myExtension.openFile"
    And I select "test.txt" from the QuickPick
    Then the editor should contain "// New file"
