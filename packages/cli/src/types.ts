// ─── Constants ────────────────────────────────────────────────────────────────

/** Default port for the controller extension WebSocket server. */
export const CONTROLLER_WS_PORT = 9788;

/** Default port for Chrome DevTools Protocol (VS Code renderer). */
export const CDP_PORT = 9222;

/** Default timeout for waiting for VS Code to launch and stabilize. */
export const VSCODE_LAUNCH_TIMEOUT_MS = 60_000;

/** Default timeout for connecting to the controller extension WebSocket. */
export const WS_CONNECT_TIMEOUT_MS = 15_000;

/** Default timeout for a single step execution. */
export const STEP_TIMEOUT_MS = 30_000;

/** Default FPS for screen recording. */
export const DEFAULT_RECORDING_FPS = 15;

/** Controller extension identifier. */
export const CONTROLLER_EXTENSION_ID = 'vscode-extension-tester.vscode-extension-tester-controller';

/** Default features directory in the user's repo. */
export const DEFAULT_FEATURES_DIR = 'tests/vscode-extension-tester/e2e';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Result of executing a single Gherkin step. */
export interface StepResult {
  readonly keyword: string;
  readonly text: string;
  readonly status: 'passed' | 'failed' | 'skipped' | 'pending';
  readonly durationMs: number;
  readonly error?: StepError;
  readonly outputLog?: string;
  readonly artifacts?: LiveStepArtifacts;
  readonly state?: VSCodeState;
}

export interface StepError {
  readonly message: string;
  readonly stack?: string;
}

/** Result of a Gherkin scenario. */
export interface ScenarioResult {
  readonly name: string;
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly steps: StepResult[];
  readonly durationMs: number;
  readonly tags: string[];
}

/** Result of a Gherkin feature. */
export interface FeatureResult {
  readonly name: string;
  readonly description: string;
  readonly scenarios: ScenarioResult[];
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly durationMs: number;
}

/** Complete test run result. */
export interface TestRunResult {
  readonly features: FeatureResult[];
  readonly totalPassed: number;
  readonly totalFailed: number;
  readonly totalSkipped: number;
  readonly durationMs: number;
}

export type ScreenshotPolicy = 'always' | 'onFailure' | 'never';

export type StepArtifactKind =
  | 'screenshot'
  | 'failure-screenshot'
  | 'final-screenshot'
  | 'output-log'
  | 'log-manifest'
  | 'host-log'
  | 'warning';

export interface StepArtifact {
  readonly kind: StepArtifactKind;
  readonly path?: string;
  readonly label?: string;
  readonly message?: string;
}

export interface LiveStepArtifacts {
  readonly screenshots: StepArtifact[];
  readonly logs: StepArtifact[];
  readonly warnings: string[];
  readonly manifestPath?: string;
}

export interface LiveStepResult extends StepResult {
  readonly stepIndex: number;
  readonly artifacts: LiveStepArtifacts;
  readonly state?: VSCodeState;
}

export interface LiveScriptResult {
  readonly steps: LiveStepResult[];
  readonly totalPassed: number;
  readonly totalFailed: number;
  readonly stoppedOnFailure: boolean;
  readonly durationMs: number;
}

export interface RunSingleStepOptions {
  readonly stepIndex?: number;
  readonly label?: string;
  readonly screenshotPolicy?: ScreenshotPolicy;
  readonly includeState?: boolean;
  readonly captureLogs?: boolean;
}

export interface LiveSessionOptions {
  readonly mode: 'auto' | 'launch' | 'attach';
  readonly runOptions: RunOptions;
  readonly artifactsDir?: string;
  readonly screenshotPolicy?: ScreenshotPolicy;
  readonly finalScreenshot?: boolean;
  readonly build?: boolean;
  readonly logger?: (message: string) => void;
}

export interface LiveSessionSummary {
  readonly sessionId: string;
  readonly mode: 'launch' | 'attach';
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly artifactsDir: string;
  readonly controllerPort: number;
  readonly cdpPort: number;
  readonly userDataDir?: string;
  readonly targetPid?: number;
  readonly stepsRun: number;
  readonly failedSteps: number;
  readonly finalScreenshot?: StepArtifact;
  readonly closed: boolean;
}

/** JSON-RPC request to the controller extension. */
export interface ControllerRequest {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

/** JSON-RPC response from the controller extension. */
export interface ControllerResponse {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { code: number; message: string; data?: unknown };
}

/** VS Code state snapshot. */
export interface VSCodeState {
  readonly activeEditor?: {
    fileName: string;
    languageId: string;
    content: string;
    isDirty: boolean;
  };
  readonly terminals: Array<{ name: string; isActive: boolean }>;
  readonly notifications: NotificationInfo[];
  readonly progress?: ProgressState;
}

export interface NotificationInfo {
  readonly id?: string;
  readonly message: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly source?: string;
  readonly actions?: NotificationActionInfo[];
  readonly selectedAction?: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly active?: boolean;
}

export interface NotificationActionInfo {
  readonly label: string;
  readonly isCloseAffordance?: boolean;
}

export interface QuickInputItemInfo {
  readonly id: string;
  readonly label: string;
  readonly matchLabel: string;
  readonly description?: string;
  readonly detail?: string;
  readonly kind?: 'item' | 'separator';
  readonly picked?: boolean;
  readonly alwaysShow?: boolean;
  readonly buttons?: string[];
}

export interface QuickInputState {
  readonly active: boolean;
  readonly id?: string;
  readonly kind?: 'quickPick' | 'inputBox';
  readonly source?: 'showQuickPick' | 'createQuickPick' | 'showInputBox' | 'createInputBox' | 'workbench';
  readonly title?: string;
  readonly placeholder?: string;
  readonly prompt?: string;
  readonly value?: string;
  readonly validationMessage?: string;
  readonly busy?: boolean;
  readonly enabled?: boolean;
  readonly canSelectMany?: boolean;
  readonly items?: QuickInputItemInfo[];
  readonly activeItems?: QuickInputItemInfo[];
  readonly selectedItems?: QuickInputItemInfo[];
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

export interface QuickInputSelectResult {
  readonly selected: string | string[];
  readonly intercepted: boolean;
}

export interface QuickInputTextResult {
  readonly entered: string;
  readonly intercepted: boolean;
  readonly accepted?: boolean;
  readonly validationMessage?: string;
}

export interface ProgressInfo {
  readonly id: string;
  readonly title?: string;
  readonly location?: string;
  readonly cancellable?: boolean;
  readonly message?: string;
  readonly increment?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
  readonly status: 'active' | 'completed' | 'failed' | 'canceled';
  readonly error?: string;
}

export interface ProgressState {
  readonly active: ProgressInfo[];
  readonly history: ProgressInfo[];
}

/** Metadata about how a test run was invoked (embedded in reports & artifacts). */
export interface RunMetadata {
  readonly timestamp: string;
  readonly cliCommand: string;
  readonly entryPoint: string;
  readonly cwd: string;
  readonly options: Record<string, unknown>;
}

/** CLI run options. */
export interface RunOptions {
  // ─── Execution mode ───
  /** If true, attach to an already-running Dev Host instead of launching one. */
  attachDevhost: boolean;

  // ─── Paths & identity ───
  extensionPath: string;
  /** Root profile-aware e2e directory, e.g. tests/vscode-extension-tester/e2e */
  features: string;
  /** Leaf test-slug directory under the effective profile folder. */
  testId?: string;

  // ─── Launch options (ignored in attach mode) ───
  vscodeVersion: string;
  xvfb: boolean;

  // ─── Ports ───
  controllerPort: number;
  cdpPort: number;

  // ─── Recording & reporting ───
  record: boolean;
  recordOnFailure: boolean;
  reporter: 'console' | 'json' | 'html';
  timeout: number;

  // ─── Profile strategy (mutually exclusive, launch mode only) ───
  reuseNamedProfile?: string;
  reuseOrCreateNamedProfile?: string;
  cloneNamedProfile?: string;

  // ─── Build ───
  /** If true, build the extension before running tests (default: true). */
  build: boolean;

  // ─── Paused ───
  /** If true, set up the environment but don't run tests. */
  paused: boolean;

  // ─── Reset policy ───
  autoReset: boolean;

  // ─── Parallelism (launch mode only) ───
  parallel: boolean;
  maxWorkers?: number;
}
