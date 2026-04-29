Feature: Create Azure Functions Project
  As a developer
  I want to create Azure Functions projects with different configurations
  So that I can verify the extension works for all supported languages

  Background:
    Given VS Code is running with extension "./azure-functions.vsix"
    And debug capture is enabled
    And recording is enabled as "gif"

  Scenario Outline: Create project with different languages
    When I start command "azureFunctions.createNewProject"
    Then I wait for QuickInput item "<language>"
    When I select QuickInput item "<language>"
    Then I wait for QuickInput item "<template>"
    When I select QuickInput item "<template>"
    Then I wait for QuickInput title "Function"
    When I enter "<functionName>" in the QuickInput
    Then I should see notification "Project created"
    And the output channel "Azure Functions" should contain "Created <functionName>"

    Examples:
      | language   | template        | functionName  |
      | JavaScript | HTTP trigger    | myHttpFunc    |
      | Python     | Timer trigger   | myTimerFunc   |
      | C#         | Blob trigger    | myBlobFunc    |

  Scenario: Create project with connection string
    When I start command "azureFunctions.createNewProject"
    Then I wait for QuickInput item "JavaScript"
    When I select QuickInput item "JavaScript"
    Then I wait for QuickInput item "Azure Cosmos DB trigger"
    When I select QuickInput item "Azure Cosmos DB trigger"
    Then I wait for QuickInput title "Function"
    When I enter "myCosmosFunc" in the QuickInput
    Then I wait for QuickInput title "Connection"
    When I enter "${TEST_CONN_STRING}" in the QuickInput
    Then I should see notification "Project created"

  Scenario: Cancel project creation
    When I start command "azureFunctions.createNewProject"
    Then I wait for QuickInput item "JavaScript"
    And I execute command "workbench.action.closeQuickOpen"
    Then I should see notification "Project creation cancelled"
