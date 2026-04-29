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
    When I start command "myExtension.createFile"
    Then I wait for QuickInput title "File"
    When I enter "test.txt" in the QuickInput
    Then I should see notification "File created: test.txt"
    When I start command "myExtension.openFile"
    Then I wait for QuickInput item "test.txt"
    When I select QuickInput item "test.txt"
    Then the editor should contain "// New file"
