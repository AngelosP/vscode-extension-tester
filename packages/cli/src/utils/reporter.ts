import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TestRunResult, FeatureResult, ScenarioResult, StepResult } from '../types.js';

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
 */
export function writeReportFile(result: TestRunResult, extensionPath: string): string {
  const dir = path.resolve(extensionPath, 'tests', 'vscode-extension-tester', 'results');
  fs.mkdirSync(dir, { recursive: true });

  const reportPath = path.join(dir, 'report.md');
  const md = generateMarkdown(result);
  fs.writeFileSync(reportPath, md, 'utf-8');
  return reportPath;
}

function generateMarkdown(result: TestRunResult, screenshots?: string[], runDirRel?: string): string {
  const total = result.totalPassed + result.totalFailed + result.totalSkipped;
  const status = result.totalFailed === 0 ? 'All Passed' : `${result.totalFailed} Failed`;
  const lines: string[] = [
    `# Test Results - ${status}`,
    '',
    `${result.totalPassed} passed, ${result.totalFailed} failed, ${result.totalSkipped} skipped (${result.durationMs}ms)`,
    '',
  ];

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
): void {
  const runDir = path.join(cwd, 'tests', 'vscode-extension-tester', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });

  // Find screenshot files already in the run dir
  const screenshots = fs.readdirSync(runDir).filter(f => f.endsWith('.png')).sort();

  // results.json - include screenshot paths
  const resultsWithScreenshots = {
    ...result,
    runId,
    runDir: path.relative(cwd, runDir),
    screenshots: screenshots.map(f => path.join(path.relative(cwd, runDir), f)),
  };
  fs.writeFileSync(
    path.join(runDir, 'results.json'),
    JSON.stringify(resultsWithScreenshots, null, 2),
    'utf-8',
  );

  // report.md - include screenshot listing
  const md = generateMarkdown(result, screenshots, path.relative(cwd, runDir));
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
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
