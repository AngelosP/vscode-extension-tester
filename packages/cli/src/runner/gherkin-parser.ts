import * as fs from 'node:fs';
import {
  GherkinClassicTokenMatcher,
  Parser,
  AstBuilder,
} from '@cucumber/gherkin';
import { IdGenerator } from '@cucumber/messages';
import type * as messages from '@cucumber/messages';

export interface ParsedFeature {
  readonly name: string;
  readonly description: string;
  readonly tags: string[];
  readonly backgroundSteps: ParsedStep[];
  readonly scenarios: ParsedScenario[];
  readonly uri: string;
}

export interface ParsedScenario {
  readonly name: string;
  readonly tags: string[];
  readonly steps: ParsedStep[];
}

export interface ParsedStep {
  readonly keyword: string;
  readonly text: string;
  readonly dataTable?: string[][];
  readonly docString?: string;
}

/**
 * Parses Gherkin .feature files using @cucumber/gherkin.
 */
export class GherkinParser {
  private parser: Parser<messages.GherkinDocument>;

  constructor() {
    const idGenerator = IdGenerator.uuid();
    const builder = new AstBuilder(idGenerator);
    const tokenMatcher = new GherkinClassicTokenMatcher();
    this.parser = new Parser(builder, tokenMatcher);
  }

  async parseFile(filePath: string): Promise<ParsedFeature> {
    const content = fs.readFileSync(filePath, 'utf-8');
    return this.parse(content, filePath);
  }

  parseStep(content: string, uri: string = '<inline-step>'): ParsedStep {
    const steps = this.parseSteps(content, uri);
    if (steps.length !== 1) {
      throw new Error(`Expected exactly one Gherkin step in ${uri}, found ${steps.length}`);
    }
    return steps[0];
  }

  parseSteps(content: string, uri: string = '<inline-steps>'): ParsedStep[] {
    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error(`No Gherkin steps found in ${uri}`);
    }

    if (/^\s*Feature:/m.test(trimmed)) {
      return this.extractInlineScenarioSteps(this.parse(trimmed, uri), uri);
    }

    if (/^\s*Scenario(?: Outline)?:/m.test(trimmed)) {
      return this.extractInlineScenarioSteps(this.parse(`Feature: Inline\n${trimmed}`, uri), uri);
    }

    const lines = trimmed.split(/\r?\n/);
    const firstStepLine = lines.findIndex((line) => line.trim().length > 0);
    if (firstStepLine < 0) {
      throw new Error(`No Gherkin steps found in ${uri}`);
    }

    const first = lines[firstStepLine].trim();
    const hasKeyword = /^(?:Given|When|Then|And|But)\b/.test(first);
    const stepLines = [...lines];
    if (!hasKeyword) {
      stepLines[firstStepLine] = `When ${first}`;
    }

    const indented = stepLines.map((line) => line.trim() ? `    ${line}` : '').join('\n');
    const feature = this.parse(`Feature: Inline\n  Scenario: Live\n${indented}\n`, uri);
    return this.extractInlineScenarioSteps(feature, uri);
  }

  parse(content: string, uri: string = '<inline>'): ParsedFeature {
    const gherkinDoc = this.parser.parse(content);
    if (!gherkinDoc.feature) {
      throw new Error(`No feature found in ${uri}`);
    }

    const feature = gherkinDoc.feature;
    const tags = (feature.tags ?? []).map((t) => t.name ?? '');

    let backgroundSteps: ParsedStep[] = [];
    const scenarios: ParsedScenario[] = [];

    for (const child of feature.children ?? []) {
      if (child.background) {
        backgroundSteps = this.extractSteps(child.background.steps ?? []);
      }
      if (child.scenario) {
        const scenario = child.scenario;
        const scenarioTags = (scenario.tags ?? []).map((t) => t.name ?? '');

        if (scenario.examples && scenario.examples.length > 0) {
          scenarios.push(...this.expandScenarioOutline(scenario));
        } else {
          scenarios.push({
            name: scenario.name ?? '',
            tags: scenarioTags,
            steps: this.extractSteps(scenario.steps ?? []),
          });
        }
      }
    }

    return { name: feature.name ?? '', description: feature.description?.trim() ?? '', tags, backgroundSteps, scenarios, uri };
  }

  private extractInlineScenarioSteps(feature: ParsedFeature, uri: string): ParsedStep[] {
    if (feature.scenarios.length > 1) {
      throw new Error(`Inline Gherkin scripts must contain exactly one scenario in ${uri}; found ${feature.scenarios.length}`);
    }
    const scenario = feature.scenarios[0];
    if (!scenario) {
      throw new Error(`No scenario found in ${uri}`);
    }
    return [...feature.backgroundSteps, ...scenario.steps];
  }

  private expandScenarioOutline(scenario: messages.Scenario): ParsedScenario[] {
    const result: ParsedScenario[] = [];
    const scenarioTags = (scenario.tags ?? []).map((t) => t.name ?? '');
    const templateSteps = this.extractSteps(scenario.steps ?? []);

    for (const examples of scenario.examples ?? []) {
      const headerRow = examples.tableHeader;
      if (!headerRow?.cells) continue;
      const headers = headerRow.cells.map((c) => c.value ?? '');

      for (const bodyRow of examples.tableBody ?? []) {
        const values = (bodyRow.cells ?? []).map((c) => c.value ?? '');
        const subs = new Map<string, string>();
        for (let i = 0; i < headers.length; i++) {
          subs.set(headers[i], values[i] ?? '');
        }

        const expandedSteps = templateSteps.map((step) => ({
          ...step,
          text: this.substituteVars(step.text, subs),
        }));

        result.push({
          name: `${scenario.name ?? ''} (${values.join(', ')})`,
          tags: [...scenarioTags, ...(examples.tags ?? []).map((t) => t.name ?? '')],
          steps: expandedSteps,
        });
      }
    }
    return result;
  }

  private extractSteps(steps: readonly messages.Step[]): ParsedStep[] {
    return steps.map((step) => {
      const parsed: ParsedStep = { keyword: step.keyword ?? '', text: step.text ?? '' };
      if (step.dataTable) {
        return { ...parsed, dataTable: (step.dataTable.rows ?? []).map((row) => (row.cells ?? []).map((c) => c.value ?? '')) };
      }
      if (step.docString) {
        return { ...parsed, docString: step.docString.content ?? '' };
      }
      return parsed;
    });
  }

  private substituteVars(text: string, vars: Map<string, string>): string {
    let result = text;
    for (const [key, value] of vars) {
      result = result.replaceAll(`<${key}>`, value);
    }
    return result;
  }
}
