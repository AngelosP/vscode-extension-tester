import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TestRunResult, RunMetadata } from '../../src/types.js';
import { printResults, writeReportFile, writeRunArtifacts } from '../../src/utils/reporter.js';

function makeRunResult(overrides: Partial<TestRunResult> = {}): TestRunResult {
  return {
    features: [
      {
        name: 'Test Feature',
        description: 'A test feature',
        scenarios: [
          {
            name: 'Passing scenario',
            status: 'passed',
            steps: [
              { keyword: 'Given ', text: 'the VS Code is in a clean state', status: 'passed', durationMs: 100 },
              {
                keyword: 'Then ', text: 'the webview should contain "Dashboard"', status: 'passed', durationMs: 50,
                artifacts: {
                  screenshots: [],
                  logs: [{
                    kind: 'webview-evidence',
                    label: 'Webview text assertion',
                    webviewEvidence: {
                      kind: 'webview-body',
                      expectedText: 'Dashboard',
                      matched: true,
                      targetCount: 1,
                      textSample: 'Welcome Dashboard Ready',
                      textLength: 23,
                      truncated: false,
                      matchContext: 'Welcome Dashboard Ready',
                      targets: [{
                        title: 'Dashboard',
                        url: 'vscode-webview://dashboard',
                        probedTitle: 'Dashboard',
                        matched: true,
                        textSample: 'Welcome Dashboard Ready',
                        textLength: 23,
                        truncated: false,
                      }],
                    },
                  }],
                  warnings: [],
                },
              },
            ],
            durationMs: 150,
            tags: [],
          },
          {
            name: 'Failing scenario',
            status: 'failed',
            steps: [
              { keyword: 'Given ', text: 'the VS Code is in a clean state', status: 'passed', durationMs: 100 },
              {
                keyword: 'Then ', text: 'I should see notification "missing"', status: 'failed', durationMs: 5000,
                error: { message: 'Notification not found' },
                artifacts: {
                  screenshots: [{
                    kind: 'failure-screenshot',
                    path: 'C:/test/workspace/tests/vscode-extension-tester/runs/default/failure.png',
                    label: 'failure',
                    capture: {
                      devHostPid: 1234,
                      windowProcessId: 2345,
                      windowTitle: 'Failure - Extension Development Host',
                      windowBounds: { x: 10, y: 20, width: 800, height: 600 },
                      captureMethod: 'CopyFromScreen',
                    },
                  }],
                  logs: [],
                  warnings: ['Could not capture failure screenshot: GDI+ failed'],
                },
              },
            ],
            durationMs: 5100,
            tags: ['@smoke'],
          },
        ],
        passed: 1,
        failed: 1,
        skipped: 0,
        durationMs: 5250,
      },
    ],
    totalPassed: 1,
    totalFailed: 1,
    totalSkipped: 0,
    durationMs: 5250,
    ...overrides,
  };
}

const testMetadata: RunMetadata = {
  timestamp: '2026-04-19T12:30:00.000Z',
  cliCommand: 'node vscode-ext-test.js run --extension-path .',
  entryPoint: 'vscode-ext-test run',
  cwd: '/test/workspace',
  options: { extensionPath: '.', reporter: 'console', timeout: 30000 },
};

describe('reporter', () => {
  describe('printResults() console format', () => {
    it('should not throw for console format', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(() => printResults(makeRunResult(), 'console')).not.toThrow();
      spy.mockRestore();
    });

    it('should log scenario names and statuses', () => {
      const logs: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
        logs.push(args.join(' '));
      });

      printResults(makeRunResult(), 'console');

      const output = logs.join('\n');
      expect(output).toContain('Passing scenario');
      expect(output).toContain('Failing scenario');
      expect(output).toContain('Test Feature');

      spy.mockRestore();
    });

    it('should show error messages for failed steps', () => {
      const logs: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
        logs.push(args.join(' '));
      });

      printResults(makeRunResult(), 'console');

      const output = logs.join('\n');
      expect(output).toContain('Notification not found');

      spy.mockRestore();
    });

    it('should show artifact warnings for affected steps', () => {
      const logs: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
        logs.push(args.join(' '));
      });

      printResults(makeRunResult(), 'console');

      expect(logs.join('\n')).toContain('Could not capture failure screenshot');
      spy.mockRestore();
    });

    it('should show summary line', () => {
      const logs: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
        logs.push(args.join(' '));
      });

      printResults(makeRunResult(), 'console');

      const output = logs.join('\n');
      expect(output).toContain('1 of 2 scenarios failed');

      spy.mockRestore();
    });

    it('should show all passed message when no failures', () => {
      const logs: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
        logs.push(args.join(' '));
      });

      printResults(makeRunResult({ totalFailed: 0, totalPassed: 2 }), 'console');

      const output = logs.join('\n');
      expect(output).toContain('All 2 scenarios passed');

      spy.mockRestore();
    });
  });

  describe('printResults() JSON format', () => {
    it('should output valid JSON', () => {
      const logs: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
        logs.push(args.join(' '));
      });

      printResults(makeRunResult(), 'json');

      const output = logs.join('\n');
      const parsed = JSON.parse(output);
      expect(parsed.totalPassed).toBe(1);
      expect(parsed.totalFailed).toBe(1);
      expect(parsed.features).toHaveLength(1);

      spy.mockRestore();
    });
  });

  describe('printResults() HTML format', () => {
    it('should output valid HTML', () => {
      const logs: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
        logs.push(args.join(' '));
      });

      printResults(makeRunResult(), 'html');

      const output = logs.join('\n');
      expect(output).toContain('<!DOCTYPE html>');
      expect(output).toContain('<html>');
      expect(output).toContain('Test Feature');
      expect(output).toContain('1 passed');
      expect(output).toContain('1 failed');

      spy.mockRestore();
    });

    it('should escape HTML entities', () => {
      const logs: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
        logs.push(args.join(' '));
      });

      const result = makeRunResult();
      result.features[0].scenarios[0].steps[0] = {
        keyword: 'Given ',
        text: 'a file <script>alert("xss")</script>',
        status: 'passed',
        durationMs: 10,
      };

      printResults(result, 'html');

      const output = logs.join('\n');
      expect(output).not.toContain('<script>');
      expect(output).toContain('&lt;script&gt;');

      spy.mockRestore();
    });
  });

  describe('writeReportFile()', () => {
    const tmpDir = path.join(process.cwd(), '__test_reporter_tmp__');

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should create a timestamped report.md file', () => {
      const reportPath = writeReportFile(makeRunResult(), tmpDir, testMetadata);

      expect(fs.existsSync(reportPath)).toBe(true);
      expect(reportPath).toContain('report-20260419-123000.md');

      const content = fs.readFileSync(reportPath, 'utf-8');
      expect(content).toContain('# Test Results');
      expect(content).toContain('Test Feature');
      expect(content).toContain('Passing scenario');
      expect(content).toContain('Failing scenario');
    });

    it('should fall back to report.md when no metadata is provided', () => {
      const reportPath = writeReportFile(makeRunResult(), tmpDir);

      expect(fs.existsSync(reportPath)).toBe(true);
      expect(path.basename(reportPath)).toBe('report.md');
    });

    it('should include pass/fail icons in markdown', () => {
      const reportPath = writeReportFile(makeRunResult(), tmpDir, testMetadata);
      const content = fs.readFileSync(reportPath, 'utf-8');

      // Check for emoji pass/fail indicators
      expect(content).toContain('✅');
      expect(content).toContain('❌');
    });

    it('should include error details in markdown', () => {
      const reportPath = writeReportFile(makeRunResult(), tmpDir, testMetadata);
      const content = fs.readFileSync(reportPath, 'utf-8');

      expect(content).toContain('Notification not found');
    });

    it('should include artifact warnings in markdown', () => {
      const reportPath = writeReportFile(makeRunResult(), tmpDir, testMetadata);
      const content = fs.readFileSync(reportPath, 'utf-8');

      expect(content).toContain('Warning: Could not capture failure screenshot');
    });

    it('should include screenshot capture metadata in markdown', () => {
      const reportPath = writeReportFile(makeRunResult(), tmpDir, testMetadata);
      const content = fs.readFileSync(reportPath, 'utf-8');

      expect(content).toContain('Screenshot (failure):');
      expect(content).toContain('Capture metadata: Dev Host PID 1234; window PID 2345');
      expect(content).toContain('title "Failure - Extension Development Host"');
      expect(content).toContain('bounds 10,20 800x600');
      expect(content).toContain('method CopyFromScreen');
    });

    it('should include webview text evidence in markdown', () => {
      const reportPath = writeReportFile(makeRunResult(), tmpDir, testMetadata);
      const content = fs.readFileSync(reportPath, 'utf-8');

      expect(content).toContain('Webview evidence (Webview text assertion): matched expected "Dashboard"; targets 1');
      expect(content).toContain('Target: "Dashboard"; probed "Dashboard"; url vscode-webview://dashboard; matched; text 23 chars');
      expect(content).toContain('Combined match context:');
      expect(content).toContain('Welcome Dashboard Ready');
    });

    it('should include run metadata in markdown', () => {
      const reportPath = writeReportFile(makeRunResult(), tmpDir, testMetadata);
      const content = fs.readFileSync(reportPath, 'utf-8');

      expect(content).toContain('## Run Information');
      expect(content).toContain('vscode-ext-test run');
      expect(content).toContain('2026-04-19T12:30:00.000Z');
      expect(content).toContain('/test/workspace');
      expect(content).toContain('node vscode-ext-test.js run --extension-path .');
    });
  });

  describe('writeRunArtifacts()', () => {
    const tmpDir = path.join(process.cwd(), '__test_artifacts_tmp__');

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should create results.json and report.md', () => {
      writeRunArtifacts(makeRunResult(), tmpDir, 'latest', ['test.feature'], 'console output');

      const runDir = path.join(tmpDir, 'tests', 'vscode-extension-tester', 'runs', 'latest');
      expect(fs.existsSync(path.join(runDir, 'results.json'))).toBe(true);
      expect(fs.existsSync(path.join(runDir, 'report.md'))).toBe(true);
    });

    it('should write valid JSON in results.json', () => {
      writeRunArtifacts(makeRunResult(), tmpDir, 'test-run', [], '', testMetadata);

      const runDir = path.join(tmpDir, 'tests', 'vscode-extension-tester', 'runs', 'test-run');
      const json = JSON.parse(fs.readFileSync(path.join(runDir, 'results.json'), 'utf-8'));
      expect(json.totalPassed).toBe(1);
      expect(json.totalFailed).toBe(1);
      expect(json.runId).toBe('test-run');
      expect(json.metadata).toBeDefined();
      expect(json.metadata.cliCommand).toBe('node vscode-ext-test.js run --extension-path .');
    });

    it('should write console.log with output', () => {
      writeRunArtifacts(makeRunResult(), tmpDir, 'log-run', [], 'test console output');

      const runDir = path.join(tmpDir, 'tests', 'vscode-extension-tester', 'runs', 'log-run');
      expect(fs.existsSync(path.join(runDir, 'console.log'))).toBe(true);
      const content = fs.readFileSync(path.join(runDir, 'console.log'), 'utf-8');
      expect(content).toContain('test console output');
      expect(content).toContain('WARNING: Could not capture failure screenshot');
    });

    it('should include screenshots in results.json if present', () => {
      const runDir = path.join(tmpDir, 'tests', 'vscode-extension-tester', 'runs', 'screenshots-run');
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, '1-screenshot.png'), '', 'utf-8');

      writeRunArtifacts(makeRunResult(), tmpDir, 'screenshots-run', [], '');

      const json = JSON.parse(fs.readFileSync(path.join(runDir, 'results.json'), 'utf-8'));
      expect(json.screenshots).toHaveLength(1);
      expect(typeof json.screenshots[0]).toBe('string');
      expect(json.screenshots[0]).toContain('1-screenshot.png');
      expect(json.features[0].scenarios[1].steps[1].artifacts.screenshots[0].capture).toMatchObject({
        devHostPid: 1234,
        windowProcessId: 2345,
        captureMethod: 'CopyFromScreen',
      });
      expect(json.features[0].scenarios[0].steps[1].artifacts.logs[0].webviewEvidence).toMatchObject({
        kind: 'webview-body',
        matched: true,
        expectedText: 'Dashboard',
      });
    });

    it('should include metadata in run report.md', () => {
      writeRunArtifacts(makeRunResult(), tmpDir, 'meta-run', ['test.feature'], '', testMetadata);

      const runDir = path.join(tmpDir, 'tests', 'vscode-extension-tester', 'runs', 'meta-run');
      const content = fs.readFileSync(path.join(runDir, 'report.md'), 'utf-8');
      expect(content).toContain('## Run Information');
      expect(content).toContain('vscode-ext-test run');
      expect(content).toContain('Capture metadata: Dev Host PID 1234; window PID 2345');
    });
  });
});
