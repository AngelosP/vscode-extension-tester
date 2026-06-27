import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IterationResult, RunMetadata, StepArtifact } from '../types.js';

export interface JsonArtifactRecord {
  readonly name: string;
  readonly path: string;
  readonly source?: StepArtifact['source'];
  readonly iteration?: {
    readonly phase: 'warmup' | 'measured';
    readonly index: number;
    readonly label: string;
  };
  readonly feature?: string;
  readonly scenario?: string;
  readonly value: unknown;
}

export interface NumericStats {
  readonly count: number;
  readonly min: number;
  readonly median: number;
  readonly p95: number;
  readonly max: number;
  readonly mean: number;
}

export interface PerfArtifactSummary {
  readonly name: string;
  readonly source?: StepArtifact['source'];
  readonly feature?: string;
  readonly scenario?: string;
  readonly stats: Record<string, NumericStats>;
  readonly raw: JsonArtifactRecord[];
}

export interface PerfSummary {
  readonly generatedAt: string;
  readonly metadata?: RunMetadata;
  readonly measuredIterations: number;
  readonly warmupIterations: number;
  readonly artifacts: PerfArtifactSummary[];
}

export function assertJsonArtifactValue(value: unknown, description: string): unknown {
  if (isJsonArtifactError(value)) {
    throw new Error(`${description} expression failed: ${value.__vscodeExtTestJsonArtifactError}`);
  }
  if (value === undefined || value === null) {
    throw new Error(`${description} returned ${value === null ? 'null' : 'undefined'}; expected a JSON-serializable value.`);
  }

  const invalid = findInvalidJsonValue(value);
  if (invalid) {
    throw new Error(`${description} returned a non-JSON-serializable value at ${invalid.path}: ${invalid.reason}.`);
  }

  try {
    JSON.stringify(value);
  } catch (err) {
    throw new Error(`${description} could not be serialized as JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return value;
}

export function strictJsonExpression(expression: string): string {
  return `(async () => {
    try {
      const __value = await (${expression});
      if (__value === null) throw new Error('$ is null');
      const __seen = new WeakSet();
      function __validate(value, path) {
        if (value === undefined) throw new Error(path + ' is undefined');
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(path + ' is a non-finite number');
        if (typeof value === 'function') throw new Error(path + ' is a function');
        if (typeof value === 'symbol') throw new Error(path + ' is a symbol');
        if (typeof value === 'bigint') throw new Error(path + ' is a bigint');
        if (typeof value !== 'object' || value === null) return;
        if (__seen.has(value)) throw new Error(path + ' contains a circular reference');
        __seen.add(value);
        if (Array.isArray(value)) {
          for (let i = 0; i < value.length; i++) __validate(value[i], path + '[' + i + ']');
        } else {
          for (const key of Object.keys(value)) __validate(value[key], path + '.' + key);
        }
        __seen.delete(value);
      }
      __validate(__value, '$');
      return __value;
    } catch (__err) {
      return { __vscodeExtTestJsonArtifactError: __err && __err.message ? String(__err.message) : String(__err) };
    }
  })()`;
}

function isJsonArtifactError(value: unknown): value is { __vscodeExtTestJsonArtifactError: string } {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as { __vscodeExtTestJsonArtifactError?: unknown }).__vscodeExtTestJsonArtifactError === 'string'
  );
}

export function collectJsonArtifactRecords(iterations: IterationResult[]): JsonArtifactRecord[] {
  const records: JsonArtifactRecord[] = [];
  for (const iteration of iterations) {
    for (const feature of iteration.features) {
      for (const scenario of feature.scenarios) {
        for (const step of scenario.steps) {
          for (const artifact of [...(step.artifacts?.logs ?? []), ...(step.artifacts?.screenshots ?? [])]) {
            if (artifact.kind !== 'json' || !artifact.path) continue;
            if (!fs.existsSync(artifact.path)) continue;
            const value = JSON.parse(fs.readFileSync(artifact.path, 'utf-8')) as unknown;
            records.push({
              name: artifact.name ?? artifact.label ?? path.basename(artifact.path, '.json'),
              path: artifact.path,
              source: artifact.source,
              iteration: {
                phase: iteration.phase,
                index: iteration.index,
                label: iteration.label,
              },
              feature: stripIterationPrefix(feature.name),
              scenario: stripIterationPrefix(scenario.name),
              value,
            });
          }
        }
      }
    }
  }
  return records;
}

export function buildPerfSummary(iterations: IterationResult[], metadata?: RunMetadata): PerfSummary {
  const records = collectJsonArtifactRecords(iterations).filter((record) => record.iteration?.phase === 'measured');
  const groups = new Map<string, JsonArtifactRecord[]>();
  for (const record of records) {
    const key = `${record.name}\0${record.source ?? ''}\0${record.feature ?? ''}\0${record.scenario ?? ''}`;
    const current = groups.get(key) ?? [];
    current.push(record);
    groups.set(key, current);
  }

  const artifacts: PerfArtifactSummary[] = [];
  for (const group of groups.values()) {
    const numericValues = new Map<string, number[]>();
    for (const record of group) {
      collectNumericFields(record.value, '', numericValues);
    }
    const stats: Record<string, NumericStats> = {};
    for (const [field, values] of numericValues.entries()) {
      stats[field] = summarizeNumbers(values);
    }
    artifacts.push({
      name: group[0].name,
      source: group[0].source,
      feature: group[0].feature,
      scenario: group[0].scenario,
      stats,
      raw: group,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    metadata,
    measuredIterations: iterations.filter((iteration) => iteration.phase === 'measured').length,
    warmupIterations: iterations.filter((iteration) => iteration.phase === 'warmup').length,
    artifacts: artifacts.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export function writePerfSummary(runDir: string, summary: PerfSummary): { jsonPath: string; markdownPath: string } {
  fs.mkdirSync(runDir, { recursive: true });
  const jsonPath = path.join(runDir, 'perf-summary.json');
  const markdownPath = path.join(runDir, 'perf-summary.md');
  fs.writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(markdownPath, generatePerfMarkdown(summary), 'utf-8');
  return { jsonPath, markdownPath };
}

function generatePerfMarkdown(summary: PerfSummary): string {
  const lines: string[] = [
    '# Performance Summary',
    '',
    `Generated: ${summary.generatedAt}`,
    `Measured iterations: ${summary.measuredIterations}`,
    `Warmup iterations: ${summary.warmupIterations}`,
    '',
  ];

  if (summary.artifacts.length === 0) {
    lines.push('No measured JSON artifacts were collected.', '');
    return lines.join('\n');
  }

  for (const artifact of summary.artifacts) {
    lines.push(`## ${artifact.name}`, '');
    if (artifact.feature || artifact.scenario) {
      lines.push(`Scope: ${[artifact.feature, artifact.scenario].filter(Boolean).join(' / ')}`, '');
    }
    const fields = Object.keys(artifact.stats).sort();
    if (fields.length === 0) {
      lines.push('No numeric fields found.', '');
      continue;
    }
    lines.push('| Field | Count | Min | Median | P95 | Max | Mean |');
    lines.push('|-------|------:|----:|-------:|----:|----:|-----:|');
    for (const field of fields) {
      const stats = artifact.stats[field];
      lines.push(`| \`${field}\` | ${stats.count} | ${formatNumber(stats.min)} | ${formatNumber(stats.median)} | ${formatNumber(stats.p95)} | ${formatNumber(stats.max)} | ${formatNumber(stats.mean)} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function collectNumericFields(value: unknown, prefix: string, output: Map<string, number[]>): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const key = prefix || '$';
    const values = output.get(key) ?? [];
    values.push(value);
    output.set(key, values);
    return;
  }
  if (!value || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      collectNumericFields(value[index], `${prefix}[${index}]`, output);
    }
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = prefix ? `${prefix}.${key}` : key;
    collectNumericFields(child, childPath, output);
  }
}

function summarizeNumbers(values: number[]): NumericStats {
  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0];
  const rank = (sorted.length - 1) * p;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function findInvalidJsonValue(value: unknown, pathName = '$', seen = new WeakSet<object>()): { path: string; reason: string } | undefined {
  if (value === undefined) return { path: pathName, reason: 'undefined' };
  const valueType = typeof value;
  if (valueType === 'number' && !Number.isFinite(value)) return { path: pathName, reason: 'non-finite number' };
  if (valueType === 'function' || valueType === 'symbol' || valueType === 'bigint') return { path: pathName, reason: valueType };
  if (value === null || valueType !== 'object') return undefined;
  const objectValue = value as Record<string, unknown>;
  if (seen.has(objectValue)) return { path: pathName, reason: 'circular reference' };
  seen.add(objectValue);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const invalid = findInvalidJsonValue(value[index], `${pathName}[${index}]`, seen);
      if (invalid) return invalid;
    }
  } else {
    for (const [key, child] of Object.entries(objectValue)) {
      const invalid = findInvalidJsonValue(child, `${pathName}.${key}`, seen);
      if (invalid) return invalid;
    }
  }
  seen.delete(objectValue);
  return undefined;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/\.00$/, '');
}

function stripIterationPrefix(value: string): string {
  return value.replace(/^\[(?:warmup|iteration)-\d+\]\s+/, '');
}