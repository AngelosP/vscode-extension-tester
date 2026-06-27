import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TestRunResult, FeatureResult, ScenarioResult, StepResult, RunMetadata, StepArtifact, IterationResult, LiveStepArtifacts } from '../types.js';

/**
 * Print test results to console with colors, or as JSON/HTML.
 */
export function printResults(result: TestRunResult, format: 'console' | 'json' | 'html'): void {
  switch (format) {
    case 'json':
      console.log(JSON.stringify(result, null, 2));
      break;
    case 'html':
      console.log(generateHtml(result));
      break;
    case 'console':
    default:
      printConsole(result);
      break;
  }
}

function printConsole(result: TestRunResult): void {
  console.log('');

  for (const feature of result.features) {
    console.log(`Feature: ${feature.name}`);
    for (const scenario of feature.scenarios) {
      const icon = scenario.status === 'passed' ? '\u2713' : scenario.status === 'failed' ? '\u2717' : '-';
      console.log(`  ${icon} Scenario: ${scenario.name} (${scenario.durationMs}ms)`);

      for (const step of scenario.steps) {
        const stepIcon = step.status === 'passed' ? '\u2713' : step.status === 'failed' ? '\u2717' : '-';
        console.log(`    ${stepIcon} ${step.keyword}${step.text}`);
        if (step.error) {
          console.log(`      Error: ${step.error.message}`);
        }
        for (const warning of step.artifacts?.warnings ?? []) {
          console.log(`      Warning: ${warning}`);
        }
      }
    }
    console.log('');
  }

  // Summary
  const total = result.totalPassed + result.totalFailed + result.totalSkipped;
  if (result.totalFailed === 0) {
    console.log(`All ${total} scenarios passed (${result.durationMs}ms)`);
  } else {
    console.log(`${result.totalFailed} of ${total} scenarios failed (${result.durationMs}ms)`);
  }
  console.log('');
}

function generateHtml(result: TestRunResult): string {
  return `<!DOCTYPE html>
<html><head><title>Test Results</title>
<style>
  body { font-family: sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; }
  .passed { color: green; } .failed { color: red; } .skipped { color: gray; }
  pre { background: #f5f5f5; padding: 10px; overflow-x: auto; }
</style></head><body>
<h1>Test Results</h1>
<p>${result.totalPassed} passed, ${result.totalFailed} failed, ${result.totalSkipped} skipped (${result.durationMs}ms)</p>
${result.features.map((f) => `
<h2>${esc(f.name)}</h2>
${f.scenarios.map((s) => `
<h3 class="${s.status}">${s.status === 'passed' ? '\u2713' : '\u2717'} ${esc(s.name)}</h3>
<ul>${s.steps.map((st) => `<li class="${st.status}">${esc(st.keyword)}${esc(st.text)}${st.error ? `<pre>${esc(st.error.message)}</pre>` : ''}</li>`).join('')}</ul>
`).join('')}
`).join('')}
</body></html>`;
}

/**
 * Write a Markdown report file and return its path.
 * Uses a timestamped filename so that previous reports are not overwritten.
 */
export function writeReportFile(result: TestRunResult, extensionPath: string, metadata?: RunMetadata): string {
  const dir = path.resolve(extensionPath, 'tests', 'vscode-extension-tester', 'results');
  fs.mkdirSync(dir, { recursive: true });

  const suffix = metadata ? `-${toFileTimestamp(metadata.timestamp)}` : '';
  const reportPath = path.join(dir, `report${suffix}.md`);
  const md = generateMarkdown(result, metadata);
  fs.writeFileSync(reportPath, md, 'utf-8');
  return reportPath;
}

/** Convert an ISO timestamp to a filesystem-safe string: YYYYMMDD-HHmmss. */
export function toFileTimestamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace('T', '-').replace(/\..*$/, '').slice(0, 15);
}

function generateMarkdown(result: TestRunResult, metadataOrScreenshots?: RunMetadata | string[], screenshots?: string[], runDirRel?: string, artifacts?: SerializableArtifact[]): string {
  // Overload: legacy callers pass (result, screenshots?, runDirRel?)
  let metadata: RunMetadata | undefined;
  if (Array.isArray(metadataOrScreenshots)) {
    screenshots = metadataOrScreenshots;
    metadata = undefined;
  } else {
    metadata = metadataOrScreenshots;
  }

  const total = result.totalPassed + result.totalFailed + result.totalSkipped;
  const status = result.totalFailed === 0 ? 'All Passed' : `${result.totalFailed} Failed`;
  const lines: string[] = [
    `# Test Results - ${status}`,
    '',
    `${result.totalPassed} passed, ${result.totalFailed} failed, ${result.totalSkipped} skipped (${result.durationMs}ms)`,
    '',
  ];

  if (metadata) {
    lines.push(
      '## Run Information', '',
      `| Field | Value |`,
      `|-------|-------|`,
      `| **Generated** | ${metadata.timestamp} |`,
      `| **Command** | \`${metadata.cliCommand}\` |`,
      `| **Entry point** | ${metadata.entryPoint} |`,
      `| **Working directory** | \`${metadata.cwd}\` |`,
    );
    const opts = metadata.options;
    const optsKeys = Object.keys(opts).filter(k => opts[k] !== undefined && opts[k] !== false && opts[k] !== '');
    if (optsKeys.length > 0) {
      lines.push(`| **Effective options** | ${optsKeys.map(k => `\`${k}=${String(opts[k])}\``).join(', ')} |`);
    }
    lines.push('');
  }

  for (const feature of result.features) {
    lines.push(`## ${feature.name}`, '');
    for (const scenario of feature.scenarios) {
      const icon = scenario.status === 'passed' ? '\u2705' : scenario.status === 'failed' ? '\u274c' : '\u23ed\ufe0f';
      lines.push(`${icon} **${scenario.name}** (${scenario.durationMs}ms)`, '');
      for (const step of scenario.steps) {
        const sIcon = step.status === 'passed' ? '\u2705' : step.status === 'failed' ? '\u274c' : '\u23ed\ufe0f';
        lines.push(`- ${sIcon} ${step.keyword}${step.text}`);
        if (step.error) {
          lines.push(`  > ${step.error.message}`);
        }
        for (const warning of step.artifacts?.warnings ?? []) {
          lines.push(`  > Warning: ${warning}`);
        }
      }
      lines.push('');
    }
  }

  // List screenshots
  if (screenshots && screenshots.length > 0) {
    lines.push('## Screenshots', '');
    lines.push('**IMPORTANT: Use `view_image` on each screenshot to verify the test actually passed.**');
    lines.push(`Screenshots are in \`${runDirRel ?? 'the run directory'}\`:`, '');
    for (const s of screenshots) {
      const imgPath = runDirRel ? `${runDirRel}/${s}` : s;
      lines.push(`- \`${imgPath}\``);
    }
    lines.push('');
  }

  const nonScreenshotArtifacts = (artifacts ?? []).filter((artifact) => !isScreenshotKind(artifact.kind));
  if (nonScreenshotArtifacts.length > 0) {
    lines.push('## Artifacts', '');
    for (const artifact of nonScreenshotArtifacts) {
      const label = artifact.label ?? artifact.name ?? artifact.kind;
      const source = artifact.source ? ` (${artifact.source})` : '';
      const iteration = artifact.iteration ? ` [${artifact.iteration.label}]` : '';
      lines.push(`- ${label}${source}${iteration}: \`${artifact.path ?? artifact.message ?? ''}\``);
    }
    lines.push('');
  }

  lines.push('---', `*Generated at ${new Date().toISOString()}*`, '');
  return lines.join('\n');
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Write run artifacts (results.json, report.md, console.log) into the run directory.
 */
export function writeRunArtifacts(
  result: TestRunResult,
  cwd: string,
  runId: string,
  featureFiles: string[],
  consoleOutput: string,
  metadata?: RunMetadata,
): void {
  const runDir = path.join(cwd, 'tests', 'vscode-extension-tester', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });

  const artifacts = collectSerializableArtifacts(result, cwd);
  const topLevelScreenshots = fs.readdirSync(runDir)
    .filter(f => f.endsWith('.png'))
    .map((fileName) => path.join(path.relative(cwd, runDir), fileName));
  const screenshots = Array.from(new Set([
    ...artifacts
      .filter((artifact) => isScreenshotKind(artifact.kind) && artifact.path)
      .map((artifact) => artifact.path!),
    ...topLevelScreenshots,
  ])).sort();
  const serializableResult = normalizeResultForSerialization(result, cwd);

  // results.json - include screenshot paths and run metadata
  const resultsWithScreenshots = {
    ...serializableResult,
    runId,
    runDir: path.relative(cwd, runDir),
    screenshots,
    artifacts,
    ...(metadata ? { metadata } : {}),
  };
  fs.writeFileSync(
    path.join(runDir, 'results.json'),
    JSON.stringify(resultsWithScreenshots, null, 2),
    'utf-8',
  );

  // report.md - include screenshot listing and metadata
  const md = generateMarkdown(result, metadata, screenshots, path.relative(cwd, runDir), artifacts);
  fs.writeFileSync(path.join(runDir, 'report.md'), md, 'utf-8');

  // console.log - structured output log split by scenario/step
  const consoleLog = generateConsoleLog(result);
  if (consoleLog || consoleOutput) {
    const combined = [consoleLog, consoleOutput].filter(Boolean).join('\n\n');
    fs.writeFileSync(path.join(runDir, 'console.log'), combined, 'utf-8');
  }
}

/**
 * Generate a structured console log with output split by scenario and step.
 */
function generateConsoleLog(result: TestRunResult): string {
  const lines: string[] = [];

  for (const feature of result.features) {
    lines.push(`═══ Feature: ${feature.name} ═══`);
    lines.push('');

    for (const scenario of feature.scenarios) {
      lines.push(`  ─── Scenario: ${scenario.name} (${scenario.status}) ───`);

      for (const step of scenario.steps) {
        const icon = step.status === 'passed' ? '✓' : step.status === 'failed' ? '✗' : '○';
        lines.push(`    ${icon} ${step.keyword}${step.text} (${step.durationMs}ms)`);

        if (step.outputLog) {
          for (const line of step.outputLog.split('\n')) {
            lines.push(`      │ ${line}`);
          }
        }

        if (step.error) {
          lines.push(`      ✗ ERROR: ${step.error.message}`);
        }

        for (const warning of step.artifacts?.warnings ?? []) {
          lines.push(`      ⚠ WARNING: ${warning}`);
        }
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

interface SerializableArtifact {
  readonly kind: StepArtifact['kind'];
  readonly path?: string;
  readonly name?: string;
  readonly source?: StepArtifact['source'];
  readonly iteration?: StepArtifact['iteration'];
  readonly label?: string;
  readonly message?: string;
}

function collectSerializableArtifacts(result: TestRunResult, cwd: string): SerializableArtifact[] {
  const artifacts: StepArtifact[] = [...(result.artifacts ?? [])];
  for (const feature of result.features) {
    for (const scenario of feature.scenarios) {
      for (const step of scenario.steps) {
        artifacts.push(...(step.artifacts?.screenshots ?? []));
        artifacts.push(...(step.artifacts?.logs ?? []));
      }
    }
  }

  const seen = new Set<string>();
  const serialized: SerializableArtifact[] = [];
  for (const artifact of artifacts) {
    const normalized = normalizeStepArtifact(artifact, cwd);
    const item: SerializableArtifact = {
      kind: normalized.kind,
      path: normalized.path,
      name: normalized.name,
      source: normalized.source,
      iteration: normalized.iteration,
      label: normalized.label,
      message: normalized.message,
    };
    const key = `${item.kind}\0${item.path ?? ''}\0${item.name ?? ''}\0${item.message ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    serialized.push(item);
  }
  return serialized;
}

function normalizeArtifactPath(filePath: string | undefined, cwd: string): string | undefined {
  if (!filePath) return undefined;
  if (!path.isAbsolute(filePath)) return filePath;
  return path.relative(cwd, filePath);
}

function normalizeResultForSerialization(result: TestRunResult, cwd: string): TestRunResult {
  return {
    ...result,
    features: result.features.map((feature) => ({
      ...feature,
      scenarios: feature.scenarios.map((scenario) => ({
        ...scenario,
        steps: scenario.steps.map((step) => ({
          ...step,
          artifacts: normalizeLiveStepArtifacts(step.artifacts, cwd),
        })),
      })),
    })),
    iterations: result.iterations?.map((iteration) => normalizeIterationResult(iteration, cwd)),
    artifacts: result.artifacts?.map((artifact) => normalizeStepArtifact(artifact, cwd)),
  };
}

function normalizeIterationResult(iteration: IterationResult, cwd: string): IterationResult {
  return {
    ...normalizeResultForSerialization(iteration, cwd),
    phase: iteration.phase,
    index: iteration.index,
    label: iteration.label,
    artifactsDir: normalizeArtifactPath(iteration.artifactsDir, cwd),
  };
}

function normalizeLiveStepArtifacts(artifacts: LiveStepArtifacts | undefined, cwd: string): LiveStepArtifacts | undefined {
  if (!artifacts) return undefined;
  return {
    ...artifacts,
    screenshots: artifacts.screenshots.map((artifact) => normalizeStepArtifact(artifact, cwd)),
    logs: artifacts.logs.map((artifact) => normalizeStepArtifact(artifact, cwd)),
    manifestPath: normalizeArtifactPath(artifacts.manifestPath, cwd),
  };
}

function normalizeStepArtifact(artifact: StepArtifact, cwd: string): StepArtifact {
  return {
    ...artifact,
    path: normalizeArtifactPath(artifact.path, cwd),
    iteration: artifact.iteration
      ? { ...artifact.iteration, artifactsDir: normalizeArtifactPath(artifact.iteration.artifactsDir, cwd) }
      : undefined,
  };
}

function isScreenshotKind(kind: StepArtifact['kind']): boolean {
  return kind === 'screenshot' || kind === 'failure-screenshot' || kind === 'final-screenshot';
}
