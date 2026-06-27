import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IterationResult } from '../../src/types.js';
import { assertJsonArtifactValue, buildPerfSummary, strictJsonExpression } from '../../src/utils/perf-summary.js';

describe('perf-summary utilities', () => {
  it('rejects null, undefined, and non-JSON values', () => {
    expect(() => assertJsonArtifactValue(null, 'artifact')).toThrow('returned null');
    expect(() => assertJsonArtifactValue(undefined, 'artifact')).toThrow('returned undefined');
    expect(() => assertJsonArtifactValue({ fn: () => undefined }, 'artifact')).toThrow('non-JSON-serializable');
    expect(() => assertJsonArtifactValue({ value: Number.NaN }, 'artifact')).toThrow('non-finite number');
  });

  it('wraps expressions in an async strict JSON validator', () => {
    const expression = strictJsonExpression('window.__perf.snapshot()');

    expect(expression).toContain('async ()');
    expect(expression).toContain('await (window.__perf.snapshot())');
    expect(expression).toContain('__vscodeExtTestJsonArtifactError');
  });

  it('aggregates measured JSON artifacts and excludes warmups', () => {
    const iterations: IterationResult[] = [
      makeIteration('warmup', 1, 999),
      makeIteration('measured', 1, 100),
      makeIteration('measured', 2, 300),
      makeIteration('measured', 3, 500),
    ];

    const summary = buildPerfSummary(iterations);

    expect(summary.warmupIterations).toBe(1);
    expect(summary.measuredIterations).toBe(3);
    expect(summary.artifacts).toHaveLength(1);
    expect(summary.artifacts[0].stats['measures.openToReadyMs']).toEqual({
      count: 3,
      min: 100,
      median: 300,
      p95: 480,
      max: 500,
      mean: 300,
    });
  });

  it('keeps same-named artifacts separate by scenario', () => {
    const iterations: IterationResult[] = [
      makeIteration('measured', 1, 100, 'Open Small'),
      makeIteration('measured', 1, 900, 'Open Large'),
      makeIteration('measured', 2, 200, 'Open Small'),
      makeIteration('measured', 2, 1000, 'Open Large'),
    ];

    const summary = buildPerfSummary(iterations);

    expect(summary.artifacts).toHaveLength(2);
    const small = summary.artifacts.find((artifact) => artifact.scenario === 'Open Small');
    const large = summary.artifacts.find((artifact) => artifact.scenario === 'Open Large');
    expect(small?.stats['measures.openToReadyMs'].mean).toBe(150);
    expect(large?.stats['measures.openToReadyMs'].mean).toBe(950);
  });
});

function makeIteration(phase: 'warmup' | 'measured', index: number, value: number, scenarioName = 'Scenario'): IterationResult {
  const label = `${phase}-${index}`;
  return {
    phase,
    index,
    label,
    features: [{
      name: 'Feature',
      description: '',
      scenarios: [{
        name: scenarioName,
        status: 'passed',
        durationMs: 1,
        tags: [],
        steps: [{
          keyword: 'Then ',
          text: 'I collect JSON artifact',
          status: 'passed',
          durationMs: 1,
          artifacts: {
            screenshots: [],
            logs: [{
              kind: 'json',
              name: 'webview-perf',
              source: 'webview',
              path: makeDataUrl(value),
              iteration: { phase, index, label },
            }],
            warnings: [],
          },
        }],
      }],
      passed: 1,
      failed: 0,
      skipped: 0,
      durationMs: 1,
    }],
    totalPassed: 1,
    totalFailed: 0,
    totalSkipped: 0,
    durationMs: 1,
  };
}

function makeDataUrl(value: number): string {
  const tempPath = path.join(os.tmpdir(), `vscode-ext-test-perf-${value}.json`);
  fs.writeFileSync(tempPath, JSON.stringify({ measures: { openToReadyMs: value } }), 'utf-8');
  return tempPath;
}