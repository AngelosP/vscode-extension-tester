Feature: Create Azure Functions Project
  As a developer
  I want to create Azure Functions projects with different configurations
  So that I can verify the extension works for all supported languages

  Background:
    Given VS Code is running with extension "./azure-functions.vsix"
    And debug capture is enabled
    And recording is enabled as "gif"

  Scenario Outline: Create project with different languages
    When I execute command "azureFunctions.createNewProject"
    And I select "<language>" from the QuickPick
    And I select "<template>" from the QuickPick
    And I type "<functionName>" into the InputBox
    Then I should see notification "Project created"
    And the output channel "Azure Functions" should contain "Created <functionName>"

    Examples:
      | language   | template        | functionName  |
      | JavaScript | HTTP trigger    | myHttpFunc    |
      | Python     | Timer trigger   | myTimerFunc   |
      | C#         | Blob trigger    | myBlobFunc    |

  Scenario: Create project with connection string
    When I execute command "azureFunctions.createNewProject"
    And I select "JavaScript" from the QuickPick
    And I select "Azure Cosmos DB trigger" from the QuickPick
    And I type "myCosmosFunc" into the InputBox
    And I type "${TEST_CONN_STRING}" into the InputBox
    Then I should see notification "Project created"

  Scenario: Cancel project creation
    When I execute command "azureFunctions.createNewProject"
    And I execute command "workbench.action.closeQuickOpen"
    And I wait 2 seconds
    Then I should see notification "Project creation cancelled"
