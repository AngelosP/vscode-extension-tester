import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  FeatureResult,
  LiveScriptResult,
  LiveSessionOptions,
  LiveSessionSummary,
  LiveStepResult,
  StepArtifact,
  TestRunResult,
  VSCodeState,
} from '../types.js';
import type { ParsedStep } from './gherkin-parser.js';
import { GherkinParser } from './gherkin-parser.js';
import { TestRunner } from './test-runner.js';
import type { ControllerClient } from './controller-client.js';
import { createLaunchDevHostSession, type LaunchDevHostSession } from '../modes/ci-mode.js';
import { attachDevHostSession, type AttachDevHostSession, runFeatures } from '../modes/dev-mode.js';
import { detectDevHost } from '../utils/dev-host-detector.js';
import { buildExtension } from '../build.js';

export type LiveDevHostSession = LaunchDevHostSession | AttachDevHostSession;

export class LiveTestSession {
  private readonly parser = new GherkinParser();
  private readonly sessionId = randomUUID();
  private readonly startedAt = new Date();
  private lifecycle?: LiveDevHostSession;
  private runner?: TestRunner;
  private queue: Promise<void> = Promise.resolve();
  private stepsRun = 0;
  private failedSteps = 0;
  private closed = false;
  private finalScreenshot?: StepArtifact;

  readonly artifactsDir: string;

  constructor(private readonly options: LiveSessionOptions) {
    this.artifactsDir = options.artifactsDir ?? path.resolve(
      options.runOptions.extensionPath,
      '.vscode-ext-test',
      'live',
      timestampForPath(this.startedAt),
    );
    fs.mkdirSync(this.artifactsDir, { recursive: true });
  }

  static async start(options: LiveSessionOptions): Promise<LiveTestSession> {
    const session = new LiveTestSession(options);
    await session.start();
    return session;
  }

  get client(): ControllerClient {
    if (!this.lifecycle) throw new Error('Live session has not started');
    return this.lifecycle.client;
  }

  get mode(): 'launch' | 'attach' {
    if (!this.lifecycle) throw new Error('Live session has not started');
    return this.lifecycle.mode;
  }

  async start(): Promise<LiveSessionSummary> {
    if (this.lifecycle) return this.getSummary();
    if (this.options.build ?? this.options.runOptions.build) {
      buildExtension(path.resolve(this.options.runOptions.extensionPath), { stdio: 'pipe-to-stderr' });
    }

    const runOptions = { ...this.options.runOptions, build: this.options.build ?? this.options.runOptions.build };
    const requestedMode = this.options.mode;
    let lifecycle: LiveDevHostSession;

    if (requestedMode === 'attach') {
      lifecycle = await attachDevHostSession(runOptions);
    } else if (requestedMode === 'launch') {
      lifecycle = await createLaunchDevHostSession(runOptions);
    } else {
      const devHost = await detectDevHost(runOptions.extensionPath);
      if (devHost) {
        try {
          lifecycle = await attachDevHostSession(runOptions);
        } catch (err) {
          this.log(`Could not attach to existing Dev Host, launching a new one: ${errorMessage(err)}`);
          lifecycle = await createLaunchDevHostSession(runOptions);
        }
      } else {
        lifecycle = await createLaunchDevHostSession(runOptions);
      }
    }

    this.lifecycle = lifecycle;
    this.runner = new TestRunner(
      lifecycle.client,
      {},
      this.artifactsDir,
      lifecycle.userDataDir,
      lifecycle.cdpPort,
      lifecycle.targetPid,
      { coordinateOrigin: 'devHostWindow', stepTimeoutMs: runOptions.timeout },
    );
    return this.getSummary();
  }

  async runStep(content: string | ParsedStep): Promise<LiveStepResult> {
    return this.enqueue(() => this.runParsedStep(typeof content === 'string' ? this.parser.parseStep(content) : content));
  }

  async runScript(content: string, stopOnFailure = true): Promise<LiveScriptResult> {
    return this.enqueue(async () => {
      const started = Date.now();
      const steps = this.parser.parseSteps(content);
      const results: LiveStepResult[] = [];
      let stoppedOnFailure = false;

      for (const step of steps) {
        const result = await this.runParsedStep(step);
        results.push(result);
        if (result.status === 'failed' && stopOnFailure) {
          stoppedOnFailure = true;
          break;
        }
      }

      return {
        steps: results,
        totalPassed: results.filter((step) => step.status === 'passed').length,
        totalFailed: results.filter((step) => step.status === 'failed').length,
        stoppedOnFailure,
        durationMs: Date.now() - started,
      };
    });
  }

  async runFeatureFile(filePath: string): Promise<FeatureResult> {
    return this.enqueue(async () => {
      if (!this.runner) throw new Error('Live session has not started');
      const feature = await this.parser.parseFile(filePath);
      return this.runner.runFeature(feature);
    });
  }

  async runFeatures(): Promise<TestRunResult> {
    return this.enqueue(async () => {
      if (!this.lifecycle) throw new Error('Live session has not started');
      return runFeatures(
        this.lifecycle.client,
        this.options.runOptions,
        Date.now(),
        this.artifactsDir,
        this.lifecycle.userDataDir,
        this.lifecycle.cdpPort,
        this.lifecycle.targetPid,
        { coordinateOrigin: 'devHostWindow', stepTimeoutMs: this.options.runOptions.timeout },
      );
    });
  }

  async reset(mode: 'cleanState' | 'reload' = 'cleanState'): Promise<void> {
    await this.enqueue(async () => {
      if (!this.lifecycle || !this.runner) throw new Error('Live session has not started');
      if (mode === 'cleanState') {
        await this.lifecycle.client.resetState();
        return;
      }

      if (this.lifecycle.mode === 'attach') {
        await this.lifecycle.reload();
      } else {
        await this.reloadLaunchedWindow();
      }
      this.runner.cleanup();
      this.runner = new TestRunner(
        this.lifecycle.client,
        {},
        this.artifactsDir,
        this.lifecycle.userDataDir,
        this.lifecycle.cdpPort,
        this.lifecycle.targetPid,
        { coordinateOrigin: 'devHostWindow' },
      );
    });
  }

  async getState(): Promise<VSCodeState> {
    return this.enqueue(async () => this.client.getState());
  }

  async captureFinalScreenshot(): Promise<StepArtifact | undefined> {
    return this.enqueue(async () => this.captureFinalScreenshotNow());
  }

  async close(): Promise<LiveSessionSummary> {
    if (this.closed) return this.getSummary();
    await this.enqueue(async () => {
      if (this.closed) return;
      try {
        if (this.options.finalScreenshot !== false) {
          await this.captureFinalScreenshotNow();
        }
      } finally {
        this.runner?.cleanup();
        this.closed = true;
        await this.lifecycle?.close();
      }
    });
    return this.getSummary();
  }

  getSummary(): LiveSessionSummary {
    if (!this.lifecycle) {
      return {
        sessionId: this.sessionId,
        mode: this.options.mode === 'attach' ? 'attach' : 'launch',
        startedAt: this.startedAt.toISOString(),
        artifactsDir: this.artifactsDir,
        controllerPort: this.options.runOptions.controllerPort,
        cdpPort: this.options.runOptions.cdpPort,
        stepsRun: this.stepsRun,
        failedSteps: this.failedSteps,
        closed: this.closed,
      };
    }
    return {
      sessionId: this.sessionId,
      mode: this.lifecycle.mode,
      startedAt: this.startedAt.toISOString(),
      endedAt: this.closed ? new Date().toISOString() : undefined,
      artifactsDir: this.artifactsDir,
      controllerPort: this.lifecycle.controllerPort,
      cdpPort: this.lifecycle.cdpPort,
      userDataDir: this.lifecycle.userDataDir,
      targetPid: this.lifecycle.targetPid,
      stepsRun: this.stepsRun,
      failedSteps: this.failedSteps,
      finalScreenshot: this.finalScreenshot,
      closed: this.closed,
    };
  }

  private async runParsedStep(step: ParsedStep): Promise<LiveStepResult> {
    if (!this.runner) throw new Error('Live session has not started');
    if (this.closed) throw new Error('Live session is closed');
    const result = await this.runner.runSingleStep(step, {
      stepIndex: this.stepsRun + 1,
      screenshotPolicy: this.options.screenshotPolicy ?? 'always',
      includeState: true,
      captureLogs: true,
    });
    this.stepsRun++;
    if (result.status === 'failed') this.failedSteps++;
    return result;
  }

  private async captureFinalScreenshotNow(): Promise<StepArtifact | undefined> {
    if (!this.runner || this.finalScreenshot) return this.finalScreenshot;
    try {
      const targetDir = path.join(this.artifactsDir, 'final');
      this.finalScreenshot = await this.runner.captureArtifactScreenshot('final', 'final-screenshot', targetDir);
    } catch (err) {
      this.log(`Could not capture final screenshot: ${errorMessage(err)}`);
    }
    return this.finalScreenshot;
  }

  private async reloadLaunchedWindow(): Promise<void> {
    if (!this.lifecycle) throw new Error('Live session has not started');
    try {
      await this.lifecycle.client.executeCommand('workbench.action.reloadWindow');
    } catch {
      // The window can close before the command returns.
    }
    this.lifecycle.client.disconnect();
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        await this.lifecycle.client.connect();
        await this.lifecycle.client.ping();
        return;
      } catch {
        await delay(1000);
      }
    }
    throw new Error('Dev Host did not come back after reload within 60s.');
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private log(message: string): void {
    this.options.logger?.(message);
  }
}

function timestampForPath(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
