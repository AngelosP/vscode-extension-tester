import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TestRunResult, FeatureResult, ScenarioResult, StepResult, RunMetadata, StepArtifact } from '../types.js';

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

function generateMarkdown(result: TestRunResult, metadataOrScreenshots?: RunMetadata | string[], screenshots?: string[], runDirRel?: string): string {
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
        for (const screenshot of step.artifacts?.screenshots ?? []) {
          lines.push(...formatScreenshotArtifactMarkdown(screenshot, runDirRel));
        }
        for (const log of step.artifacts?.logs ?? []) {
          lines.push(...formatLogArtifactMarkdown(log, runDirRel));
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

  lines.push('---', `*Generated at ${new Date().toISOString()}*`, '');
  return lines.join('\n');
}

function formatScreenshotArtifactMarkdown(artifact: StepArtifact, runDirRel?: string): string[] {
  const lines: string[] = [];
  const label = artifact.label ? ` (${escapeMarkdownText(artifact.label)})` : '';
  const displayPath = artifact.path ? formatArtifactPath(artifact.path, runDirRel) : undefined;
  if (displayPath) {
    lines.push(`  > Screenshot${label}: \`${displayPath}\``);
  } else if (artifact.capture) {
    lines.push(`  > Screenshot${label}`);
  }

  const metadata = formatCaptureMetadata(artifact);
  if (metadata) lines.push(`  > Capture metadata: ${metadata}`);
  return lines;
}

function formatLogArtifactMarkdown(artifact: StepArtifact, runDirRel?: string): string[] {
  if (artifact.kind === 'webview-evidence' && artifact.webviewEvidence) {
    return formatWebviewEvidenceMarkdown(artifact);
  }
  if (artifact.path && artifact.label) {
    return [`  > Log (${escapeMarkdownText(artifact.label)}): \`${formatArtifactPath(artifact.path, runDirRel)}\``];
  }
  return [];
}

function formatWebviewEvidenceMarkdown(artifact: StepArtifact): string[] {
  const evidence = artifact.webviewEvidence;
  if (!evidence) return [];
  const lines: string[] = [];
  const label = artifact.label ? ` (${escapeMarkdownText(artifact.label)})` : '';
  const status = evidence.matched === true ? 'matched' : evidence.matched === false ? 'not matched' : 'captured';
  const scope = evidence.selector ? ` selector \`${escapeMarkdownText(evidence.selector)}\`` : '';
  const filter = evidence.titleFilter ? ` in webview "${escapeMarkdownText(evidence.titleFilter)}"` : '';
  const expected = evidence.expectedText !== undefined ? ` expected "${escapeMarkdownText(evidence.expectedText)}"` : '';
  lines.push(`  > Webview evidence${label}: ${status}${scope}${filter}${expected}; targets ${evidence.targetCount}`);
  if (evidence.message) lines.push(`  > Evidence note: ${escapeMarkdownText(evidence.message)}`);

  for (const target of evidence.targets.slice(0, 5)) {
    const title = target.title || '(untitled)';
    const probed = target.probedTitle ? `; probed "${escapeMarkdownText(target.probedTitle)}"` : '';
    const matched = target.matched === true ? '; matched' : target.matched === false ? '; not matched' : '';
    const length = typeof target.textLength === 'number' ? `; text ${target.textLength} chars${target.truncated ? ' (sample truncated)' : ''}` : '';
    const error = target.error ? `; error "${escapeMarkdownText(target.error)}"` : '';
    lines.push(`  > Target: "${escapeMarkdownText(title)}"${probed}; url ${escapeMarkdownText(target.url)}${matched}${length}${error}`);
    const sample = target.matchContext || target.textSample;
    if (sample) lines.push(...formatEvidenceTextBlock(target.matchContext ? 'Match context' : 'Text sample', sample));
  }

  if (evidence.targets.length > 5) {
    lines.push(`  > ${evidence.targets.length - 5} additional webview target(s) omitted from report output.`);
  }
  if (evidence.matchContext) {
    lines.push(...formatEvidenceTextBlock('Combined match context', evidence.matchContext));
  } else if (evidence.textSample && evidence.targets.length === 0) {
    lines.push(...formatEvidenceTextBlock('Text sample', evidence.textSample));
  }
  return lines;
}

function formatEvidenceTextBlock(label: string, text: string): string[] {
  const safe = text.replace(/```/g, "'''");
  const lines = [`  > ${label}:`, '  > ```text'];
  for (const line of safe.split('\n')) lines.push(`  > ${line}`);
  lines.push('  > ```');
  return lines;
}

function formatCaptureMetadata(artifact: StepArtifact): string | undefined {
  const capture = artifact.capture;
  if (!capture) return undefined;
  const fields: string[] = [];
  if (typeof capture.devHostPid === 'number') fields.push(`Dev Host PID ${capture.devHostPid}`);
  if (typeof capture.windowProcessId === 'number') fields.push(`window PID ${capture.windowProcessId}`);
  if (capture.windowTitle !== undefined) fields.push(`title "${escapeMarkdownText(capture.windowTitle)}"`);
  if (capture.windowBounds) {
    const { x, y, width, height } = capture.windowBounds;
    fields.push(`bounds ${x},${y} ${width}x${height}`);
  }
  if (capture.captureMethod) fields.push(`method ${escapeMarkdownText(capture.captureMethod)}`);
  return fields.length > 0 ? fields.join('; ') : undefined;
}

function formatArtifactPath(artifactPath: string, runDirRel?: string): string {
  const normalized = artifactPath.replace(/\\/g, '/');
  if (!runDirRel) return normalized;
  const normalizedRunDir = runDirRel.replace(/\\/g, '/');
  if (normalized === normalizedRunDir || normalized.startsWith(`${normalizedRunDir}/`)) return normalized;
  const marker = `/${normalizedRunDir}/`;
  const index = normalized.toLowerCase().indexOf(marker.toLowerCase());
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function escapeMarkdownText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\|/g, '\\|');
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

  // Find screenshot files already in the run dir
  const screenshots = fs.readdirSync(runDir).filter(f => f.endsWith('.png')).sort();

  // results.json - include screenshot paths and run metadata
  const resultsWithScreenshots = {
    ...result,
    runId,
    runDir: path.relative(cwd, runDir),
    screenshots: screenshots.map(f => path.join(path.relative(cwd, runDir), f)),
    ...(metadata ? { metadata } : {}),
  };
  fs.writeFileSync(
    path.join(runDir, 'results.json'),
    JSON.stringify(resultsWithScreenshots, null, 2),
    'utf-8',
  );

  // report.md - include screenshot listing and metadata
  const md = generateMarkdown(result, metadata, screenshots, path.relative(cwd, runDir));
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
