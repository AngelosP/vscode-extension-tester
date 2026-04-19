Feature: Output channel capture

  Scenario: Controller startup logs are readable
    Then the output channel "Extension Tester Controller" should contain "WebSocket server started"