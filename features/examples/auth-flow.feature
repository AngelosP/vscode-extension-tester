Feature: Azure Sign-In Flow
  As a developer using an Azure extension
  I want to verify the sign-in flow works end-to-end
  So that users can authenticate successfully

  Background:
    Given VS Code is running with extension "ms-vscode.azure-account"
    And recording is enabled as "mp4"
    And debug capture is enabled

  Scenario: User signs in with Microsoft account
    When I execute command "azure-account.login"
    And I sign in with Microsoft as "${AZURE_TEST_USER}"
    Then I should see notification "Successfully signed in"
    And the output channel "Azure" should contain "Logged in"

  Scenario: User signs out
    Given I sign in with Microsoft as "${AZURE_TEST_USER}"
    When I execute command "azure-account.logout"
    Then I should see notification "Signed out"
