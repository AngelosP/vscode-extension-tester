import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TestRunResult } from '../../src/types.js';
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
              { keyword: 'When ', text: 'I execute command "test"', status: 'passed', durationMs: 50 },
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

    it('should create a report.md file', () => {
      const reportPath = writeReportFile(makeRunResult(), tmpDir);

      expect(fs.existsSync(reportPath)).toBe(true);
      expect(reportPath).toContain('report.md');

      const content = fs.readFileSync(reportPath, 'utf-8');
      expect(content).toContain('# Test Results');
      expect(content).toContain('Test Feature');
      expect(content).toContain('Passing scenario');
      expect(content).toContain('Failing scenario');
    });

    it('should include pass/fail icons in markdown', () => {
      const reportPath = writeReportFile(makeRunResult(), tmpDir);
      const content = fs.readFileSync(reportPath, 'utf-8');

      // Check for emoji pass/fail indicators
      expect(content).toContain('✅');
      expect(content).toContain('❌');
    });

    it('should include error details in markdown', () => {
      const reportPath = writeReportFile(makeRunResult(), tmpDir);
      const content = fs.readFileSync(reportPath, 'utf-8');

      expect(content).toContain('Notification not found');
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
      writeRunArtifacts(makeRunResult(), tmpDir, 'test-run', [], '');

      const runDir = path.join(tmpDir, 'tests', 'vscode-extension-tester', 'runs', 'test-run');
      const json = JSON.parse(fs.readFileSync(path.join(runDir, 'results.json'), 'utf-8'));
      expect(json.totalPassed).toBe(1);
      expect(json.totalFailed).toBe(1);
      expect(json.runId).toBe('test-run');
    });

    it('should write console.log with output', () => {
      writeRunArtifacts(makeRunResult(), tmpDir, 'log-run', [], 'test console output');

      const runDir = path.join(tmpDir, 'tests', 'vscode-extension-tester', 'runs', 'log-run');
      expect(fs.existsSync(path.join(runDir, 'console.log'))).toBe(true);
      const content = fs.readFileSync(path.join(runDir, 'console.log'), 'utf-8');
      expect(content).toContain('test console output');
    });

    it('should include screenshots in results.json if present', () => {
      const runDir = path.join(tmpDir, 'tests', 'vscode-extension-tester', 'runs', 'screenshots-run');
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, '1-screenshot.png'), '', 'utf-8');

      writeRunArtifacts(makeRunResult(), tmpDir, 'screenshots-run', [], '');

      const json = JSON.parse(fs.readFileSync(path.join(runDir, 'results.json'), 'utf-8'));
      expect(json.screenshots).toHaveLength(1);
      expect(json.screenshots[0]).toContain('1-screenshot.png');
    });
  });
});
