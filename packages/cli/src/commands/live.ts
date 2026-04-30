import * as readline from 'node:readline';
import * as path from 'node:path';
import type { RunOptions, ScreenshotPolicy } from '../types.js';
import { CDP_PORT, CONTROLLER_WS_PORT, DEFAULT_FEATURES_DIR, STEP_TIMEOUT_MS } from '../types.js';
import { LiveTestSession } from '../runner/live-session.js';
import { validateProfileOptions } from '../profile.js';

interface LiveCommandOptions {
  mode?: 'auto' | 'launch' | 'attach';
  extensionPath?: string;
  features?: string;
  vscodeVersion?: string;
  controllerPort?: string;
  cdpPort?: string;
  timeout?: string;
  xvfb?: boolean;
  build?: boolean;
  screenshotPolicy?: ScreenshotPolicy;
  finalScreenshot?: boolean;
  artifactsDir?: string;
  reuseNamedProfile?: string;
  reuseOrCreateNamedProfile?: string;
  cloneNamedProfile?: string;
}

interface LiveRequest {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

export async function liveCommand(opts: LiveCommandOptions): Promise<void> {
  const restoreConsole = redirectConsoleLogToStderr();
  let session: LiveTestSession | undefined;
  let closing = false;

  const closeSession = async () => {
    if (closing) return session?.getSummary();
    closing = true;
    return session?.close();
  };

  const interrupt = async () => {
    try {
      const summary = await closeSession();
      writeJson({ type: 'session_ended', summary });
    } finally {
      restoreConsole();
      process.exit(130);
    }
  };

  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);

  try {
    const runOptions: RunOptions = {
      attachDevhost: normalizeLiveMode(opts.mode) === 'attach',
      extensionPath: opts.extensionPath ?? '.',
      features: opts.features ?? DEFAULT_FEATURES_DIR,
      vscodeVersion: opts.vscodeVersion ?? 'stable',
      xvfb: opts.xvfb === true,
      controllerPort: parseInt(String(opts.controllerPort ?? CONTROLLER_WS_PORT), 10),
      cdpPort: parseInt(String(opts.cdpPort ?? CDP_PORT), 10),
      record: false,
      recordOnFailure: false,
      reporter: 'json',
      timeout: parseInt(String(opts.timeout ?? STEP_TIMEOUT_MS), 10),
      reuseNamedProfile: opts.reuseNamedProfile,
      reuseOrCreateNamedProfile: opts.reuseOrCreateNamedProfile,
      cloneNamedProfile: opts.cloneNamedProfile,
      autoReset: false,
      parallel: false,
      build: opts.build !== false,
      paused: false,
    };
    validateProfileOptions(runOptions, {
      cwd: path.resolve(runOptions.extensionPath),
      log: (message) => console.error(message),
    });

    session = await LiveTestSession.start({
      mode: normalizeLiveMode(opts.mode),
      runOptions,
      artifactsDir: opts.artifactsDir,
      screenshotPolicy: normalizeScreenshotPolicy(opts.screenshotPolicy),
      finalScreenshot: opts.finalScreenshot !== false,
      build: runOptions.build,
      logger: (message) => console.error(message),
    });
    writeJson({ type: 'session_started', summary: session.getSummary() });

    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let request: LiveRequest;
      try {
        request = JSON.parse(trimmed) as LiveRequest;
      } catch (err) {
        writeJson({ type: 'response', ok: false, error: errorMessage(err) });
        continue;
      }

      try {
        const result = await handleRequest(session, request);
        writeJson({ type: 'response', id: request.id, ok: true, result });
        if (request.method === 'end') break;
      } catch (err) {
        writeJson({ type: 'response', id: request.id, ok: false, error: errorMessage(err) });
      }
    }
  } catch (err) {
    writeJson({ type: 'fatal', ok: false, error: errorMessage(err) });
    process.exitCode = 1;
  } finally {
    try {
      const summary = await closeSession();
      if (summary) writeJson({ type: 'session_ended', summary });
    } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
      restoreConsole();
    }
  }
}

async function handleRequest(session: LiveTestSession, request: LiveRequest): Promise<unknown> {
  switch (request.method) {
    case 'runStep': {
      const step = requiredString(request.params?.step, 'params.step');
      return session.runStep(step);
    }
    case 'runScript': {
      const script = requiredString(request.params?.script, 'params.script');
      const stopOnFailure = request.params?.stopOnFailure !== false;
      return session.runScript(script, stopOnFailure);
    }
    case 'runExtensionHostScript': {
      const script = requiredString(request.params?.script, 'params.script');
      const timeoutMs = optionalPositiveInteger(request.params?.timeoutMs, 'params.timeoutMs');
      return session.runExtensionHostScript(script, timeoutMs);
    }
    case 'reset': {
      const mode = request.params?.mode === 'reload' ? 'reload' : 'cleanState';
      await session.reset(mode);
      return session.getSummary();
    }
    case 'state':
      return session.getState();
    case 'summary':
      return session.getSummary();
    case 'end':
      return session.close();
    default:
      throw new Error(`Unknown live method: ${request.method ?? '<missing>'}`);
  }
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function redirectConsoleLogToStderr(): () => void {
  const originalLog = console.log;
  console.log = (...args: unknown[]) => console.error(...args);
  return () => { console.log = originalLog; };
}

function normalizeLiveMode(value: unknown): 'auto' | 'launch' | 'attach' {
  if (value === undefined) return 'auto';
  if (value === 'auto' || value === 'launch' || value === 'attach') return value;
  throw new Error(`Unknown --mode value: ${String(value)}`);
}

function normalizeScreenshotPolicy(value: unknown): ScreenshotPolicy {
  if (value === undefined) return 'always';
  if (value === 'always' || value === 'onFailure' || value === 'never') return value;
  throw new Error(`Unknown --screenshot-policy value: ${String(value)}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
