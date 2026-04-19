import { describe, it, expect } from 'vitest';
import { GherkinParser } from '../../src/runner/gherkin-parser.js';

describe('GherkinParser', () => {
  let parser: GherkinParser;

  beforeEach(() => {
    parser = new GherkinParser();
  });

  describe('parse()', () => {
    it('should parse a simple feature with one scenario', () => {
      const content = `
Feature: Simple test
  Scenario: Do something
    Given the VS Code is in a clean state
    When I execute command "workbench.action.openSettings"
    Then I should see notification "Settings opened"
`;
      const result = parser.parse(content);

      expect(result.name).toBe('Simple test');
      expect(result.scenarios).toHaveLength(1);
      expect(result.scenarios[0].name).toBe('Do something');
      expect(result.scenarios[0].steps).toHaveLength(3);
    });

    it('should parse feature-level tags', () => {
      const content = `
@smoke @critical
Feature: Tagged feature
  Scenario: Test
    Given the VS Code is in a clean state
`;
      const result = parser.parse(content);

      expect(result.tags).toContain('@smoke');
      expect(result.tags).toContain('@critical');
    });

    it('should parse scenario-level tags', () => {
      const content = `
Feature: Scenario tags
  @slow
  Scenario: Slow test
    Given I wait 5 seconds
`;
      const result = parser.parse(content);

      expect(result.scenarios[0].tags).toContain('@slow');
    });

    it('should parse background steps', () => {
      const content = `
Feature: With background
  Background:
    Given the VS Code is in a clean state
    And I execute command "workbench.action.openSettings"

  Scenario: Test
    When I type "editor.fontSize"
    Then the editor should contain "fontSize"
`;
      const result = parser.parse(content);

      expect(result.backgroundSteps).toHaveLength(2);
      expect(result.backgroundSteps[0].keyword.trim()).toBe('Given');
      expect(result.backgroundSteps[1].keyword.trim()).toBe('And');
      expect(result.scenarios[0].steps).toHaveLength(2);
    });

    it('should parse feature description', () => {
      const content = `
Feature: Described feature
  This is a multi-line
  description of the feature.

  Scenario: Test
    Given the VS Code is in a clean state
`;
      const result = parser.parse(content);

      expect(result.description).toContain('multi-line');
    });

    it('should parse multiple scenarios', () => {
      const content = `
Feature: Multiple scenarios
  Scenario: First
    Given the VS Code is in a clean state

  Scenario: Second
    Given I wait 1 second

  Scenario: Third
    Given I type "hello"
`;
      const result = parser.parse(content);

      expect(result.scenarios).toHaveLength(3);
      expect(result.scenarios[0].name).toBe('First');
      expect(result.scenarios[1].name).toBe('Second');
      expect(result.scenarios[2].name).toBe('Third');
    });

    it('should parse data tables', () => {
      const content = `
Feature: Data tables
  Scenario: With table
    Given the following files exist:
      | path        | content    |
      | test.txt    | hello      |
      | readme.md   | world      |
`;
      const result = parser.parse(content);

      const step = result.scenarios[0].steps[0];
      expect(step.dataTable).toBeDefined();
      expect(step.dataTable).toHaveLength(3); // header + 2 rows
      expect(step.dataTable![0]).toEqual(['path', 'content']);
      expect(step.dataTable![1]).toEqual(['test.txt', 'hello']);
    });

    it('should parse doc strings', () => {
      const content = `
Feature: Doc strings
  Scenario: With doc string
    Given a file "config.json" with content:
      """
      {
        "key": "value"
      }
      """
`;
      const result = parser.parse(content);

      const step = result.scenarios[0].steps[0];
      expect(step.docString).toBeDefined();
      expect(step.docString).toContain('"key": "value"');
    });

    it('should expand Scenario Outline with Examples', () => {
      const content = `
Feature: Scenario outlines
  Scenario Outline: Test <action>
    Given I execute command "<command>"

    Examples:
      | action  | command                      |
      | open    | workbench.action.openFile    |
      | close   | workbench.action.closeEditor |
`;
      const result = parser.parse(content);

      expect(result.scenarios).toHaveLength(2);
      expect(result.scenarios[0].name).toContain('open');
      expect(result.scenarios[0].steps[0].text).toContain('workbench.action.openFile');
      expect(result.scenarios[1].name).toContain('close');
      expect(result.scenarios[1].steps[0].text).toContain('workbench.action.closeEditor');
    });

    it('should handle Scenario Outline with multiple Examples tables', () => {
      const content = `
Feature: Multi-example outline
  Scenario Outline: Test <action>
    Given I execute command "<command>"

    @fast
    Examples: Quick actions
      | action | command                       |
      | copy   | editor.action.clipboardCopyAction |

    @slow
    Examples: Slow actions
      | action | command                    |
      | build  | workbench.action.tasks.build |
`;
      const result = parser.parse(content);

      expect(result.scenarios).toHaveLength(2);
      expect(result.scenarios[0].tags).toContain('@fast');
      expect(result.scenarios[1].tags).toContain('@slow');
    });

    it('should preserve step keywords (Given, When, Then, And, But)', () => {
      const content = `
Feature: Keywords
  Scenario: All keywords
    Given the VS Code is in a clean state
    And I execute command "test"
    When I type "hello"
    Then I should see notification "hi"
    But I should not see notification "error"
`;
      const result = parser.parse(content);
      const steps = result.scenarios[0].steps;

      expect(steps[0].keyword.trim()).toBe('Given');
      expect(steps[1].keyword.trim()).toBe('And');
      expect(steps[2].keyword.trim()).toBe('When');
      expect(steps[3].keyword.trim()).toBe('Then');
      expect(steps[4].keyword.trim()).toBe('But');
    });

    it('should throw when no feature is found', () => {
      expect(() => parser.parse('This is not gherkin')).toThrow();
    });

    it('should set the uri from the parameter', () => {
      const content = `
Feature: URI test
  Scenario: Test
    Given the VS Code is in a clean state
`;
      const result = parser.parse(content, 'test/my-file.feature');
      expect(result.uri).toBe('test/my-file.feature');
    });

    it('should use default uri when not provided', () => {
      const content = `
Feature: Default URI
  Scenario: Test
    Given the VS Code is in a clean state
`;
      const result = parser.parse(content);
      expect(result.uri).toBe('<inline>');
    });

    it('should handle empty scenario', () => {
      const content = `
Feature: Empty scenario
  Scenario: No steps
`;
      const result = parser.parse(content);

      expect(result.scenarios).toHaveLength(1);
      expect(result.scenarios[0].steps).toHaveLength(0);
    });
  });
});
