Feature: Settings manipulation

  Scenario: Set and verify a numeric setting
    Given the extension is in a clean state
    When I set setting "editor.fontSize" to "20"
    Then setting "editor.fontSize" should be "20"

  Scenario: Set and verify a boolean setting
    When I set setting "editor.minimap.enabled" to "false"
    Then setting "editor.minimap.enabled" should be "false"

  Scenario: Set and verify a string setting
    When I set setting "editor.wordWrap" to "on"
    Then setting "editor.wordWrap" should be "on"

  Scenario: Set an extension-contributed setting
    When I set setting "extensionTester.controllerPort" to "9999"
    Then setting "extensionTester.controllerPort" should be "9999"

  Scenario: Reset a setting to default with null
    When I set setting "editor.fontSize" to "14"
    Then setting "editor.fontSize" should be "14"
    When I set setting "editor.fontSize" to "null"
