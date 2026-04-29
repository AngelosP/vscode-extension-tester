import type { ControllerClient } from './controller-client.js';
import type { ParsedFeature, ParsedScenario, ParsedStep } from './gherkin-parser.js';
import type {
  FeatureResult,
  LiveStepArtifacts,
  LiveStepResult,
  NotificationInfo,
  ProgressInfo,
  QuickInputState,
  RunSingleStepOptions,
  ScenarioResult,
  StepArtifact,
  StepResult,
} from '../types.js';
import { CDP_PORT } from '../types.js';
import { NativeUIClient } from './native-ui-client.js';
import { CdpClient } from './cdp-client.js';
import { loadEnv } from '../agent/env.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Executes parsed Gherkin features by dispatching steps to the controller.
 */
export class TestRunner {
  private readonly envData: Record<string, string>;
  private nativeUI?: NativeUIClient;
  private cdp?: CdpClient;
  private screenshotCounter = 0;
  private currentScenarioName: string | undefined;
  private dispatchArtifacts: StepArtifact[] = [];
  /** Per-channel byte offsets recorded before each scenario starts. */
  private scenarioStartOffsets = new Map<string, number>();

  constructor(
    private readonly client: ControllerClient,
    private readonly testData: Record<string, string> = {},
    private readonly artifactsDir?: string,
    private readonly userDataDir?: string,
    private readonly cdpPort: number = CDP_PORT,
    private readonly targetPid?: number,
  ) {
    // Load .env values for ${VARIABLE} resolution in step text
    this.envData = loadEnv(process.cwd());
  }

  async runFeature(feature: ParsedFeature): Promise<FeatureResult> {
    const startTime = Date.now();
    const scenarioResults: ScenarioResult[] = [];

    for (const scenario of feature.scenarios) {
      const result = await this.runScenario(scenario, feature.backgroundSteps);
      scenarioResults.push(result);
    }

    return {
      name: feature.name,
      description: feature.description,
      scenarios: scenarioResults,
      passed: scenarioResults.filter((s) => s.status === 'passed').length,
      failed: scenarioResults.filter((s) => s.status === 'failed').length,
      skipped: scenarioResults.filter((s) => s.status === 'skipped').length,
      durationMs: Date.now() - startTime,
    };
  }

  private async runScenario(scenario: ParsedScenario, backgroundSteps: ParsedStep[]): Promise<ScenarioResult> {
    const startTime = Date.now();
    this.currentScenarioName = scenario.name;

    // Snapshot per-channel offsets before the scenario so we can isolate its output later
    await this.recordChannelOffsets();

    const allSteps = [...backgroundSteps, ...scenario.steps];
    const stepResults: StepResult[] = [];
    let failed = false;

    for (const step of allSteps) {
      if (failed) {
        stepResults.push({ keyword: step.keyword, text: step.text, status: 'skipped', durationMs: 0 });
        continue;
      }
      const result = await this.runStep(step);
      stepResults.push(result);
      if (result.status === 'failed') failed = true;
    }

    // Dump per-scenario captured output channels (best-effort)
    await this.dumpCapturedChannels(scenario.name).catch(() => { /* non-fatal */ });

    return {
      name: scenario.name,
      status: failed ? 'failed' : stepResults.every((s) => s.status === 'passed') ? 'passed' : 'skipped',
      steps: stepResults,
      durationMs: Date.now() - startTime,
      tags: scenario.tags,
    };
  }

  async runSingleStep(step: ParsedStep, options: RunSingleStepOptions = {}): Promise<LiveStepResult> {
    const stepIndex = options.stepIndex ?? 1;
    const label = options.label ?? `${step.keyword}${step.text}`;
    const stepDir = this.artifactsDir
      ? path.join(this.artifactsDir, 'live-steps', `${String(stepIndex).padStart(3, '0')}-${sanitizeFilename(label, 80)}`)
      : undefined;
    if (stepDir) fs.mkdirSync(stepDir, { recursive: true });

    await this.recordChannelOffsets();
    this.currentScenarioName = 'Live step';
    const result = await this.runStep(step, { captureFailureScreenshot: false });
    const artifacts = cloneArtifacts(result.artifacts);

    if (stepDir && result.outputLog) {
      const outputPath = path.join(stepDir, 'output.log');
      fs.writeFileSync(outputPath, result.outputLog, 'utf-8');
      artifacts.logs.push({ kind: 'output-log', path: outputPath, label: 'Step output delta' });
    }

    if (this.artifactsDir && options.captureLogs !== false) {
      const channelLabel = `live-step-${String(stepIndex).padStart(3, '0')}-${sanitizeFilename(step.text, 60)}`;
      try {
        await this.dumpCapturedChannels(channelLabel);
        const manifestPath = path.join(this.artifactsDir, 'output-channels', sanitizeFilename(channelLabel), '_capture-manifest.json');
        if (fs.existsSync(manifestPath)) {
          artifacts.logs.push({ kind: 'log-manifest', path: manifestPath, label: 'Captured output channels' });
          artifacts.manifestPath = manifestPath;
        }
      } catch (err) {
        artifacts.warnings.push(`Could not write step log artifacts: ${errorMessage(err)}`);
      }

      if (stepDir) {
        this.copyVsCodeHostLogs(stepDir);
        for (const logName of ['exthost.log', 'renderer.log']) {
          const logPath = path.join(stepDir, logName);
          if (fs.existsSync(logPath)) {
            artifacts.logs.push({ kind: 'host-log', path: logPath, label: logName });
          }
        }
      }
    }

    const policy = options.screenshotPolicy ?? 'always';
    if (policy === 'always' || (policy === 'onFailure' && result.status === 'failed')) {
      if (stepDir) {
        try {
          const screenshot = await this.captureArtifactScreenshot(
            result.status === 'failed' ? `failure-${sanitizeFilename(step.text, 60)}` : `after-${sanitizeFilename(step.text, 60)}`,
            result.status === 'failed' ? 'failure-screenshot' : 'screenshot',
            stepDir,
          );
          artifacts.screenshots.push(screenshot);
        } catch (err) {
          artifacts.warnings.push(`Could not capture step screenshot: ${errorMessage(err)}`);
        }
      } else {
        artifacts.warnings.push('Screenshot capture skipped because this step has no artifacts directory.');
      }
    }

    let state: LiveStepResult['state'];
    if (options.includeState !== false) {
      try {
        state = await this.client.getState();
      } catch (err) {
        artifacts.warnings.push(`Could not capture VS Code state: ${errorMessage(err)}`);
      }
    }

    const liveResult: LiveStepResult = { ...result, stepIndex, artifacts, state };
    if (stepDir) {
      const manifestPath = path.join(stepDir, 'step-result.json');
      fs.writeFileSync(manifestPath, JSON.stringify(liveResult, null, 2), 'utf-8');
      if (!liveResult.artifacts.manifestPath) {
        liveResult.artifacts.logs.push({ kind: 'log-manifest', path: manifestPath, label: 'Step result manifest' });
      }
    }

    return liveResult;
  }

  private async runStep(step: ParsedStep, options: { captureFailureScreenshot?: boolean } = {}): Promise<StepResult> {
    const startTime = Date.now();
    const resolvedText = this.resolveEnvVars(step.text);
    const docString = step.docString ? this.resolveEnvVars(step.docString) : undefined;
    this.dispatchArtifacts = [];

    // Snapshot output channels before the step
    let outputBefore = '';
    try { outputBefore = await this.client.getAllOutputContent(); } catch { /* best effort */ }

    try {
      const dispatchLog = await this.dispatch(resolvedText, docString);

      // Capture output produced during this step
      let outputLog: string | undefined;
      try {
        const outputAfter = await this.client.getAllOutputContent();
        const newOutput = outputAfter.slice(outputBefore.length).trim();
        if (newOutput) outputLog = newOutput;
      } catch { /* best effort */ }

      // Merge dispatch-returned log (e.g. evaluate results) into outputLog
      if (dispatchLog) {
        outputLog = outputLog ? `${outputLog}\n${dispatchLog}` : dispatchLog;
      }

      const artifacts = this.buildArtifacts(this.dispatchArtifacts);
      return { keyword: step.keyword, text: step.text, status: 'passed', durationMs: Date.now() - startTime, outputLog, artifacts };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));

      let outputLog: string | undefined;
      try {
        const outputAfter = await this.client.getAllOutputContent();
        const newOutput = outputAfter.slice(outputBefore.length).trim();
        if (newOutput) outputLog = newOutput;
      } catch { /* best effort */ }

      const warnings: string[] = [];
      const screenshots = [...this.dispatchArtifacts];
      if (options.captureFailureScreenshot !== false && this.artifactsDir) {
        try {
          screenshots.push(await this.captureArtifactScreenshot(
            `failure-${sanitizeFilename(this.currentScenarioName ?? 'scenario', 40)}-${sanitizeFilename(step.text, 60)}`,
            'failure-screenshot',
          ));
        } catch (screenshotError) {
          warnings.push(`Could not capture failure screenshot: ${errorMessage(screenshotError)}`);
        }
      }
      const artifacts = this.buildArtifacts(screenshots, [], warnings);
      return { keyword: step.keyword, text: step.text, status: 'failed', durationMs: Date.now() - startTime, error: { message: error.message, stack: error.stack }, outputLog, artifacts };
    }
  }

  private async dispatch(text: string, docString?: string): Promise<string | void> {
    let match: RegExpMatchArray | null;

    // ─── Reset state ───
    if (/^(?:the )?(?:VS Code|Dev Host|extension) is in a clean state$/.test(text)) {
      await this.client.resetState();
      await delay(500); // Let VS Code settle
      return;
    }

    // ─── Utility: create file with content (inline) ───
    match = text.match(/^a file "([^"]+)" exists with content "([^"]+)"$/);
    if (match) { this.createFile(match[1], match[2]); return; }

    // ─── Utility: create file with content (doc string) ───
    match = text.match(/^a file "([^"]+)" exists with content:?$/);
    if (match && docString !== undefined) { this.createFile(match[1], docString); return; }

    // ─── Utility: create empty file ───
    match = text.match(/^a file "([^"]+)" exists$/);
    if (match) { this.createFile(match[1], ''); return; }

    // ─── Utility: create temp file with content (inline) ───
    match = text.match(/^a temp file "([^"]+)" exists with content "([^"]+)"$/);
    if (match) { this.createTempFile(match[1], match[2]); return; }

    // ─── Utility: create temp file with content (doc string) ───
    match = text.match(/^a temp file "([^"]+)" exists with content:?$/);
    if (match && docString !== undefined) { this.createTempFile(match[1], docString); return; }

    // ─── Utility: create empty temp file ───
    match = text.match(/^a temp file "([^"]+)" exists$/);
    if (match) { this.createTempFile(match[1], ''); return; }

    // ─── Utility: open file in editor (via code, no UI) ───
    match = text.match(/^I open file "([^"]+)" in the editor$/);
    if (match) {
      const filePath = this.resolveFilePath(match[1]);
      await this.client.openFile(filePath);
      return;
    }

    // ─── Utility: add folder to workspace ───
    // Adding the FIRST workspace folder restarts the Extension Host, which
    // disconnects the WebSocket. We catch the disconnect error and reconnect.
    match = text.match(/^I add folder "([^"]+)" to the workspace$/);
    if (match) {
      const folderPath = this.resolveFilePath(match[1]);
      try {
        await this.client.addWorkspaceFolder(folderPath);
        this.client.disconnect();
        await delay(3000);
        for (let attempt = 0; attempt < 30; attempt++) {
          try {
            await this.client.connect();
            await this.client.ping();
            return;
          } catch {
            await delay(1000);
          }
        }
        throw new Error(
          `Extension Host did not come back after adding workspace folder "${folderPath}" within 30s.`
        );
      } catch {
        // Extension Host likely restarted (first folder added) — reconnect.
        this.client.disconnect();
        await delay(3000);
        for (let attempt = 0; attempt < 30; attempt++) {
          try {
            await this.client.connect();
            await this.client.ping();
            return;
          } catch {
            await delay(1000);
          }
        }
        throw new Error(
          `Extension Host did not come back after adding workspace folder "${folderPath}" within 30s.`
        );
      }
      return;
    }

    // ─── Utility: delete file ───
    match = text.match(/^I delete file "([^"]+)"$/);
    if (match) { this.deleteFile(match[1]); return; }

    // ─── Utility: file should exist ───
    match = text.match(/^the file "([^"]+)" should exist$/);
    if (match) {
      const p = this.resolveFilePath(match[1]);
      if (!fs.existsSync(p)) throw new Error(`File not found: ${p}`);
      return;
    }

    // ─── Utility: file should contain ───
    match = text.match(/^the file "([^"]+)" should contain "([^"]+)"$/);
    if (match) {
      const p = this.resolveFilePath(match[1]);
      if (!fs.existsSync(p)) throw new Error(`File not found: ${p}`);
      const content = fs.readFileSync(p, 'utf-8');
      if (!content.includes(match[2])) throw new Error(`File "${p}" does not contain "${match[2]}"`);
      return;
    }

    // ─── Commands ───
    match = text.match(/^I wait for command "([^"]+)"(?: for (\d+) seconds?)?$/);
    if (match) { await this.waitForCommand(match[1], match[2]); return; }

    match = text.match(/^command "([^"]+)" should be available$/);
    if (match) { await this.assertCommandAvailable(match[1]); return; }

    match = text.match(/^I execute command "([^"]+)"$/);
    if (match) { await this.client.executeCommand(match[1]); return; }

    match = text.match(/^I execute command "([^"]+)" with args '([^']+)'$/);
    if (match) { await this.client.executeCommand(match[1], JSON.parse(match[2])); return; }

    // ─── Start command (fire-and-forget, for commands that show UI) ───
    match = text.match(/^I start command "([^"]+)"$/);
    if (match) { await this.client.startCommand(match[1]); return; }

    match = text.match(/^I start command "([^"]+)" with args '([^']+)'$/);
    if (match) { await this.client.startCommand(match[1], JSON.parse(match[2])); return; }

    // ─── QuickInput / QuickPick ───
    if (/^I inspect the QuickInput$/.test(text)) {
      const state = await this.getQuickInputState();
      return JSON.stringify(state, null, 2);
    }

    match = text.match(/^I select QuickInput item "([^"]+)"$/);
    if (match) { await this.selectQuickInputItem(match[1]); return; }

    match = text.match(/^I select "([^"]+)" from the QuickInput$/);
    if (match) { await this.selectQuickInputItem(match[1]); return; }

    match = text.match(/^I select "([^"]+)" from the QuickPick$/);
    if (match) { await this.client.respondToQuickPick(match[1]); return; }

    match = text.match(/^I wait for QuickInput item "([^"]+)"(?: for (\d+) seconds?)?$/);
    if (match) { await this.waitForQuickInput((state) => this.quickInputHasItem(state, match![1]), `item "${match[1]}"`, match[2]); return; }

    match = text.match(/^I wait for QuickInput title "([^"]+)"(?: for (\d+) seconds?)?$/);
    if (match) { await this.waitForQuickInput((state) => (state.title ?? '').includes(match![1]), `title "${match[1]}"`, match[2]); return; }

    match = text.match(/^I wait for QuickInput value "([^"]*)"(?: for (\d+) seconds?)?$/);
    if (match) { await this.waitForQuickInput((state) => (state.value ?? '') === match![1], `value "${match[1]}"`, match[2]); return; }

    match = text.match(/^the QuickInput should contain item "([^"]+)"$/);
    if (match) { await this.assertQuickInputItem(match[1]); return; }

    match = text.match(/^the QuickInput title should contain "([^"]+)"$/);
    if (match) { await this.assertQuickInputTitle(match[1]); return; }

    match = text.match(/^the QuickInput value should be "([^"]*)"$/);
    if (match) { await this.assertQuickInputValue(match[1]); return; }

    // ─── InputBox / QuickInput text ───
    match = text.match(/^I (?:enter|type) "([^"]*)" (?:in|into) the QuickInput$/);
    if (match) { await this.submitQuickInputText(match[1]); return; }

    match = text.match(/^I type "([^"]+)" into the InputBox$/);
    if (match) {
      await this.submitQuickInputText(match[1]);
      return;
    }

    // ─── Dialog ───
    match = text.match(/^I click "([^"]+)" on the dialog$/);
    if (match) { await this.client.respondToDialog(match[1]); return; }

    // ─── Auth ───
    match = text.match(/^I sign in with Microsoft as "([^"]+)"$/);
    if (match) { await this.client.handleAuth('microsoft', { username: match[1] }); return; }

    // ─── Notification assertion ───
    match = text.match(/^I should see notification "([^"]+)"(?: for (\d+) seconds?)?$/);
    if (match) { await this.assertNotification(match[1], match[2]); return; }

    match = text.match(/^I click "([^"]+)" on notification "([^"]+)"$/);
    if (match) { await this.clickNotificationAction(match[2], match[1]); return; }

    // ─── Negative notification assertion ───
    match = text.match(/^I should not see notification "([^"]+)"$/);
    if (match) { await this.assertNoNotification(match[1]); return; }

    // ─── Progress assertions ───
    match = text.match(/^I wait for progress "([^"]+)" to (start|finish|complete)(?: for (\d+) seconds?)?$/);
    if (match) { await this.waitForProgress(match[1], match[2] === 'start' ? 'active' : 'completed', match[3]); return; }

    match = text.match(/^progress "([^"]+)" should be (active|completed|failed|canceled)$/);
    if (match) { await this.assertProgress(match[1], match[2] as ProgressInfo['status']); return; }

    // ─── Editor assertion ───
    match = text.match(/^the editor should contain "([^"]+)"$/);
    if (match) { await this.assertEditorContent(match[1]); return; }

    // ─── Output channel assertion ───
    match = text.match(/^I wait for output channel "([^"]+)" to contain "([^"]+)"(?: for (\d+) seconds?)?$/);
    if (match) { await this.waitForOutputContains(match[1], match[2], match[3]); return; }

    match = text.match(/^the output channel "([^"]+)" should contain "([^"]+)"$/);
    if (match) { await this.assertOutputContains(match[1], match[2]); return; }

    // ─── Negative output channel assertion ───
    match = text.match(/^the output channel "([^"]+)" should not contain "([^"]+)"$/);
    if (match) { await this.assertOutputNotContains(match[1], match[2]); return; }

    // ─── Type text (via controller - always available) ───
    match = text.match(/^I type "([^"]+)"$/);
    if (match) { await this.typeText(match[1]); return; }

    // ─── Press key ───
    match = text.match(/^I press "([^"]+)"$/);
    if (match) { await this.pressKey(match[1]); return; }

    // ─── Raw mouse movement/clicks (screen coordinates via native bridge) ───
    match = text.match(/^I move the mouse to (-?\d+),?\s*(-?\d+)$/);
    if (match) {
      await (await this.requireNativeUI()).moveMouse(parseInt(match[1], 10), parseInt(match[2], 10));
      return;
    }

    match = text.match(/^I (?:(left|right|middle) )?(click|double click)(?: at (-?\d+),?\s*(-?\d+))?$/);
    if (match) {
      const button = (match[1] ?? 'left') as 'left' | 'right' | 'middle';
      const clickCount = match[2] === 'double click' ? 2 : 1;
      const x = match[3] !== undefined ? parseInt(match[3], 10) : undefined;
      const y = match[4] !== undefined ? parseInt(match[4], 10) : undefined;
      await (await this.requireNativeUI()).clickMouse(x, y, { button, clickCount });
      return;
    }

    // ─── Click element by name/text in Dev Host (uses Windows UI Automation) ───
    match = text.match(/^I (?:(left|right|middle) )?(click|double click) the element "([^"]+)"$/);
    if (match) {
      await (await this.requireNativeUI()).clickInDevHost(match[3], undefined, {
        button: (match[1] ?? 'left') as 'left' | 'right' | 'middle',
        clickCount: match[2] === 'double click' ? 2 : 1,
      });
      return;
    }

    // ─── Click element by name/text with control type ───
    match = text.match(/^I (?:(left|right|middle) )?(click|double click) the "([^"]+)" (\w+)$/);
    if (match) {
      await (await this.requireNativeUI()).clickInDevHost(match[3], match[4], {
        button: (match[1] ?? 'left') as 'left' | 'right' | 'middle',
        clickCount: match[2] === 'double click' ? 2 : 1,
      });
      return;
    }

    // ─── Native dialog: Save As ───
    match = text.match(/^I save the file as "([^"]+)"$/);
    if (match) { await (await this.requireNativeUI()).handleSaveAsDialog(match[1]); return; }

    // ─── Native dialog: Open File ───
    match = text.match(/^I open the file "([^"]+)"$/);
    if (match) { await (await this.requireNativeUI()).handleOpenDialog(match[1]); return; }

    // ─── Native dialog: Click button by dialog title ───
    match = text.match(/^I click "([^"]+)" on the "([^"]+)" dialog$/);
    if (match) { await (await this.requireNativeUI()).clickDialogButton(match[2], match[1]); return; }

    // ─── Native dialog: Dismiss Save As ───
    if (/^I cancel the (?:Save As|Save|Open|Open File) dialog$/.test(text)) {
      const ui = await this.requireNativeUI();
      try { await ui.clickDialogButton('Save', 'Cancel'); } catch {
        await ui.clickDialogButton('Open', 'Cancel');
      }
      return;
    }

    // ─── Popup menu: select item (uses FlaUI, falls back to CDP) ───
    match = text.match(/^I select "([^"]+)" from the popup menu$/);
    if (match) {
      const label = match[1];
      // Strategy 1: FlaUI (OS-level, works when popup steals focus from webview)
      try {
        await (await this.requireNativeUI()).selectFromDevHostPopup(label, 3000);
        return;
      } catch { /* fall through to CDP */ }
      // Strategy 2: CDP DOM click (works for monaco-list overlays)
      const cdp = await this.requireCdp();
      await cdp.selectPopupMenuItem(label);
      return;
    }

    // ─── Popup menu: list items (diagnostic) ───
    if (/^I list the popup menu items$/.test(text)) {
      try {
        const items = await (await this.requireNativeUI()).getDevHostPopupItems();
        return items.map((i) => i.name).join(', ');
      } catch {
        const cdp = await this.requireCdp();
        const items = await cdp.getPopupMenuItems();
        return items.join(', ');
      }
    }

    // ─── Native: resize window ───
    match = text.match(/^I resize the (?:window|Dev Host) to (\d+)(?:x|\s+by\s+)(\d+)$/);
    if (match) {
      await (await this.requireNativeUI()).resizeDevHost(parseInt(match[1], 10), parseInt(match[2], 10));
      return;
    }

    // ─── Native: move window ───
    match = text.match(/^I move the (?:window|Dev Host) to (-?\d+),?\s*(-?\d+)$/);
    if (match) {
      await (await this.requireNativeUI()).moveDevHost(parseInt(match[1], 10), parseInt(match[2], 10));
      return;
    }

    // ─── Screenshot ───
    match = text.match(/^I take a screenshot(?: "([^"]+)")?$/);
    if (match) { await this.takeScreenshot(match[1]); return; }

    // ─── Wait ───
    match = text.match(/^I wait (\d+) seconds?$/);
    if (match) { await delay(parseInt(match[1], 10) * 1000); return; }

    // ─── Output capture: declare a channel to capture ───
    match = text.match(/^I capture the output channel "([^"]+)"$/);
    if (match) { await this.client.startCaptureChannel(match[1]); return; }

    match = text.match(/^I stop capturing the output channel "([^"]+)"$/);
    if (match) { await this.client.stopCaptureChannel(match[1]); return; }

    match = text.match(/^the output channel "([^"]+)" should have been captured$/);
    if (match) {
      const name = match[1];
      // Try CDP first
      const cdpContent = await this.tryReadOutputViaCdp(name);
      if (cdpContent !== undefined) {
        if (!cdpContent) {
          throw new Error(
            `Output channel "${name}" was not captured (no content via CDP).`
          );
        }
        return;
      }
      const ch = await this.client.getOutputChannel(name);
      if (!ch.content) {
        throw new Error(
          `Output channel "${name}" was not captured (no content). ` +
          'Make sure the controller activates before the extension creates the channel.'
        );
      }
      return;
    }

    // ─── Webview: wait for selector ───
    match = text.match(/^I wait for "([^"]+)" in the webview(?: "([^"]+)")?(?: for (\d+) seconds?)?$/);
    if (match) {
      const timeoutMs = match[3] ? parseInt(match[3], 10) * 1000 : 10_000;
      await (await this.requireCdp()).waitForSelectorInWebview(match[1], timeoutMs, match[2]);
      return;
    }

    // ─── Webview: click by selector ───
    match = text.match(/^I (?:(left|right|middle) )?(click|double click) "([^"]+)" in the webview(?: "([^"]+)")?$/);
    if (match) {
      await (await this.requireCdp()).clickInWebviewBySelector(match[3], match[4], {
        button: (match[1] ?? 'left') as 'left' | 'right' | 'middle',
        clickCount: match[2] === 'double click' ? 2 : 1,
      });
      return;
    }

    // ─── Webview: focus by selector ───
    match = text.match(/^I focus "([^"]+)" in the webview(?: "([^"]+)")?$/);
    if (match) {
      await (await this.requireCdp()).focusInWebviewBySelector(match[1], match[2]);
      return;
    }

    // ─── Webview: scroll by pixels ───
    match = text.match(/^I scroll "([^"]+)" by (-?\d+) (-?\d+)(?: in the webview(?: "([^"]+)")?)?$/);
    if (match) {
      const cdp = await this.requireCdp();
      await cdp.scrollInWebview(
        match[1],
        'by',
        parseInt(match[2], 10),
        parseInt(match[3], 10),
        match[4],
      );
      return;
    }

    // ─── Webview: scroll to absolute coords ───
    match = text.match(/^I scroll "([^"]+)" to (\d+) (\d+)(?: in the webview(?: "([^"]+)")?)?$/);
    if (match) {
      const cdp = await this.requireCdp();
      await cdp.scrollInWebview(
        match[1],
        'to',
        parseInt(match[2], 10),
        parseInt(match[3], 10),
        match[4],
      );
      return;
    }

    // ─── Webview: scroll to edge ───
    match = text.match(/^I scroll "([^"]+)" to the (top|bottom|left|right)(?: in the webview(?: "([^"]+)")?)?$/);
    if (match) {
      await (await this.requireCdp()).scrollInWebview(match[1], 'edge', match[2], 0, match[3]);
      return;
    }

    // ─── Webview: scroll into view ───
    match = text.match(/^I scroll "([^"]+)" into view(?: in the webview(?: "([^"]+)")?)?$/);
    if (match) {
      await (await this.requireCdp()).scrollInWebview(match[1], 'into-view', 0, 0, match[2]);
      return;
    }

    // ─── Webview: evaluate JS ───
    match = text.match(/^I evaluate "([^"]+)" in the webview(?: "([^"]+)")?$/);
    if (match) {
      const result = await (await this.requireCdp()).evaluateInWebview(match[1], match[2]);
      if (result !== undefined && result !== null) {
        const serialized = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        console.log(`[evaluate] ${serialized}`);
        return `[evaluate] ${serialized}`;
      }
      return;
    }

    // ─── Webview: list open webviews (debugging aid) ───
    if (/^I list the webviews$/.test(text)) {
      const webviews = await (await this.requireCdp()).listWebviews();
      if (webviews.length === 0) {
        console.log('[webviews] No webviews are currently open.');
      } else {
        console.log(`[webviews] Found ${webviews.length} webview(s):`);
        for (const wv of webviews) {
          const probed = wv.probedTitle ? ` probedTitle="${wv.probedTitle}"` : '';
          console.log(`  title="${wv.title}"${probed} url=${wv.url}`);
        }
      }
      return;
    }

    // ─── Webview: list frame contexts (debugging aid) ───
    match = text.match(/^I list the frame contexts(?: in the webview(?: "([^"]+)")?)?$/);
    if (match) {
      const infos = await (await this.requireCdp()).listWebviewFrameContexts(match[1]);
      if (infos.length === 0) {
        console.log('[frames] No matching webview targets found.');
      } else {
        for (const info of infos) {
          console.log(`[frames] target="${info.targetTitle}" url=${info.targetUrl}`);
          for (const ctx of info.contexts) {
            const def = ctx.isDefault ? ' (default)' : '';
            const frame = ctx.frameId ? ` frame=${ctx.frameId}` : '';
            console.log(`  ctx=${ctx.id} origin=${ctx.origin}${frame}${def} name=${ctx.name || '(none)'}`);
          }
          if (info.frameTree) {
            console.log(`  frameTree: ${JSON.stringify(info.frameTree, null, 2)}`);
          }
        }
      }
      return;
    }

    // ─── Webview assertions ───
    match = text.match(/^the webview(?: "([^"]+)")? should contain "([^"]+)"$/);
    if (match) {
      const body = await (await this.requireCdp()).getWebviewBodyText(match[1]);
      if (!body.includes(match[2])) {
        const where = match[1] ? `webview "${match[1]}"` : 'any webview';
        throw new Error(`Text "${match[2]}" not found in ${where}.`);
      }
      return;
    }

    match = text.match(/^element "([^"]+)" should exist(?: in the webview(?: "([^"]+)")?)?$/);
    if (match) {
      // Use polling (like waitForSelector) instead of a single point-in-time check.
      // Elements often aren't in the DOM yet right after an action triggers rendering.
      await (await this.requireCdp()).waitForSelectorInWebview(match[1], 5_000, match[2]);
      return;
    }

    match = text.match(/^element "([^"]+)" should not exist(?: in the webview(?: "([^"]+)")?)?$/);
    if (match) {
      const exists = await (await this.requireCdp()).elementExistsInWebview(match[1], match[2]);
      if (exists) throw new Error(`Element "${match[1]}" unexpectedly exists.`);
      return;
    }

    match = text.match(/^element "([^"]+)" should have text "([^"]+)"(?: in the webview(?: "([^"]+)")?)?$/);
    if (match) {
      const got = await (await this.requireCdp()).getTextInWebview(match[1], match[3]);
      if (!got.includes(match[2])) {
        throw new Error(`Element "${match[1]}" text "${got}" does not contain "${match[2]}".`);
      }
      return;
    }

    // ─── Setup steps (no-ops handled by orchestrator) ───
    if (/^(VS Code is running|extension .+ is installed|recording is enabled|debug capture is enabled)/.test(text)) return;

    throw new Error(`No step definition matches: "${text}"`);
  }

  private async submitQuickInputText(value: string): Promise<void> {
    let result: Awaited<ReturnType<ControllerClient['submitQuickInputText']>> | undefined;
    let controllerError: unknown;
    try {
      result = await this.client.submitQuickInputText(value);
    } catch (err) {
      controllerError = err;
    }

    if (result && result.intercepted !== false) {
      if (result.accepted === false) {
        throw new Error(`QuickInput rejected value "${value}"${result.validationMessage ? `: ${result.validationMessage}` : ''}`);
      }
      return;
    }

    const cdp = await this.requireCdp();
    const workbenchState = await cdp.getWorkbenchQuickInputState();
    if (workbenchState.active) {
      await cdp.submitWorkbenchQuickInputText(value);
      return;
    }

    if (controllerError) throw controllerError instanceof Error ? controllerError : new Error(String(controllerError));
    if (result?.intercepted === false) {
      await cdp.insertText(value);
      await delay(100);
      await cdp.pressKey('Enter');
      return;
    }
  }

  private async getQuickInputState(): Promise<QuickInputState> {
    const controllerState = await this.client.getQuickInputState();
    if (controllerState.active) return controllerState;

    const workbenchState = await (await this.requireCdp()).getWorkbenchQuickInputState();
    return workbenchState.active ? workbenchState : controllerState;
  }

  private async selectQuickInputItem(labelOrId: string): Promise<void> {
    let controllerError: unknown;
    try {
      await this.client.selectQuickInputItem(labelOrId);
      return;
    } catch (err) {
      controllerError = err;
    }

    const cdp = await this.requireCdp();
    const workbenchState = await cdp.getWorkbenchQuickInputState();
    if (workbenchState.active) {
      await cdp.selectWorkbenchQuickInputItem(labelOrId);
      return;
    }

    throw controllerError instanceof Error ? controllerError : new Error(String(controllerError));
  }

  private async waitForQuickInput(
    predicate: (state: QuickInputState) => boolean,
    description: string,
    timeoutSeconds?: string,
  ): Promise<QuickInputState> {
    const timeoutMs = timeoutSeconds ? parseInt(timeoutSeconds, 10) * 1000 : 10_000;
    const deadline = Date.now() + timeoutMs;
    let lastState: QuickInputState = { active: false };
    while (Date.now() < deadline) {
      lastState = await this.getQuickInputState();
      if (lastState.active && predicate(lastState)) return lastState;
      await delay(100);
    }
    throw new Error(`QuickInput ${description} not found within ${timeoutMs}ms. Last state: ${JSON.stringify(lastState)}`);
  }

  private async waitForCommand(commandId: string, timeoutSeconds?: string): Promise<void> {
    const timeoutMs = timeoutSeconds ? parseInt(timeoutSeconds, 10) * 1000 : 10_000;
    const deadline = Date.now() + timeoutMs;
    let lastMatches: string[] = [];
    while (Date.now() < deadline) {
      lastMatches = await this.client.listCommands(commandId);
      if (lastMatches.includes(commandId)) return;
      await delay(500);
    }
    throw new Error(`Command "${commandId}" was not available within ${timeoutMs}ms. Last matches: ${JSON.stringify(lastMatches)}`);
  }

  private async assertCommandAvailable(commandId: string): Promise<void> {
    const matches = await this.client.listCommands(commandId);
    if (!matches.includes(commandId)) {
      throw new Error(`Command "${commandId}" is not available. Matches: ${JSON.stringify(matches)}`);
    }
  }

  private quickInputHasItem(state: QuickInputState, labelOrId: string): boolean {
    const target = normalizeQuickInputText(labelOrId);
    return Boolean(state.items?.some((item) =>
      item.id === labelOrId ||
      normalizeQuickInputText(item.label).includes(target) ||
      normalizeQuickInputText(item.matchLabel).includes(target)
    ));
  }

  private async assertQuickInputItem(labelOrId: string): Promise<void> {
    const state = await this.getQuickInputState();
    if (!state.active) throw new Error('No QuickInput is active');
    if (!this.quickInputHasItem(state, labelOrId)) {
      throw new Error(`QuickInput item "${labelOrId}" not found. Items: ${(state.items ?? []).map((item) => item.label).join(', ')}`);
    }
  }

  private async assertQuickInputTitle(expectedText: string): Promise<void> {
    const state = await this.getQuickInputState();
    if (!state.active) throw new Error('No QuickInput is active');
    if (!(state.title ?? '').includes(expectedText)) {
      throw new Error(`QuickInput title "${state.title ?? ''}" does not contain "${expectedText}"`);
    }
  }

  private async assertQuickInputValue(expectedValue: string): Promise<void> {
    const state = await this.getQuickInputState();
    if (!state.active) throw new Error('No QuickInput is active');
    if ((state.value ?? '') !== expectedValue) {
      throw new Error(`QuickInput value "${state.value ?? ''}" does not equal "${expectedValue}"`);
    }
  }

  private async waitForProgress(title: string, status: 'active' | 'completed', timeoutSeconds?: string): Promise<ProgressInfo> {
    const timeoutMs = timeoutSeconds ? parseInt(timeoutSeconds, 10) * 1000 : 30_000;
    const deadline = Date.now() + timeoutMs;
    let lastProgress: ProgressInfo[] = [];
    let lastNotifications: NotificationInfo[] = [];
    while (Date.now() < deadline) {
      const state = await this.client.getProgressState();
      lastProgress = [...state.active, ...state.history];
      const match = findProgressByTitle(lastProgress, title, status);
      if (match) return match;
      lastNotifications = await this.client.getNotifications();
      const errorNotification = lastNotifications.find((notification) => notification.severity === 'error' && notification.active !== false);
      if (errorNotification) {
        throw new Error(`Progress "${title}" was interrupted by error notification: "${errorNotification.message}"`);
      }
      await delay(200);
    }
    throw new Error(`Progress "${title}" did not become ${status} within ${timeoutMs}ms. Seen progress: ${lastProgress.map((item) => `${item.title ?? '(untitled)'}:${item.status}`).join(', ')}. Seen notifications: ${formatNotifications(lastNotifications)}`);
  }

  private async assertProgress(title: string, status: ProgressInfo['status']): Promise<void> {
    const state = await this.client.getProgressState();
    const match = findProgressByTitle([...state.active, ...state.history], title, status);
    if (!match) {
      throw new Error(`Progress "${title}" with status ${status} not found`);
    }
  }

  private async assertNotification(expectedText: string, timeoutSeconds?: string): Promise<void> {
    const timeoutMs = timeoutSeconds ? parseInt(timeoutSeconds, 10) * 1000 : 5_000;
    const deadline = Date.now() + timeoutMs;
    let lastNotifications: NotificationInfo[] = [];
    while (Date.now() < deadline) {
      lastNotifications = await this.client.getNotifications();
      if (lastNotifications.some((n) => n.message.includes(expectedText))) return;
      await delay(500);
    }
    throw new Error(`Notification containing "${expectedText}" not found after ${timeoutMs}ms. Seen: ${formatNotifications(lastNotifications)}`);
  }

  private async clickNotificationAction(message: string, action: string): Promise<void> {
    const timeoutMs = 10_000;
    const deadline = Date.now() + timeoutMs;
    let lastNotifications: NotificationInfo[] = [];
    while (Date.now() < deadline) {
      lastNotifications = await this.client.getNotifications();
      const match = lastNotifications.find((notification) =>
        notification.active &&
        notification.message.toLowerCase().includes(message.toLowerCase()) &&
        (notification.actions ?? []).some((candidate) => labelsMatch(candidate.label, action))
      );
      if (match) {
        await this.client.clickNotificationAction(message, action);
        return;
      }
      await delay(200);
    }
    const seen = lastNotifications
      .map((notification) => `"${notification.message}" [${(notification.actions ?? []).map((candidate) => candidate.label).join(', ')}]`)
      .join('; ');
    throw new Error(`Notification containing "${message}" with action "${action}" not found within ${timeoutMs}ms. Seen: ${seen}`);
  }

  private async assertNoNotification(text: string): Promise<void> {
    const notifications = await this.client.getNotifications();
    const found = notifications.find((n) => n.message.toLowerCase().includes(text.toLowerCase()));
    if (found) {
      throw new Error(`Unexpected notification found: "${found.message}"`);
    }
  }

  private async assertEditorContent(expectedText: string): Promise<void> {
    const state = await this.client.getState();
    if (!state.activeEditor) throw new Error('No active editor');
    if (!state.activeEditor.content.includes(expectedText)) {
      throw new Error(`Editor does not contain "${expectedText}"`);
    }
  }

  private async assertOutputContains(channelName: string, expectedText: string): Promise<void> {
    // Try CDP first (can read ALL extensions' channels), fall back to controller
    const content = await this.tryReadOutputViaCdp(channelName);
    if (content !== undefined) {
      if (!content.includes(expectedText)) {
        throw new Error(`Output channel "${channelName}" does not contain "${expectedText}"`);
      }
      return;
    }
    const output = await this.client.getOutputChannel(channelName);
    if (!output.content.includes(expectedText)) {
      throw new Error(`Output channel "${channelName}" does not contain "${expectedText}"`);
    }
  }

  private async waitForOutputContains(channelName: string, expectedText: string, timeoutSeconds?: string): Promise<void> {
    const timeoutMs = timeoutSeconds ? parseInt(timeoutSeconds, 10) * 1000 : 10_000;
    const deadline = Date.now() + timeoutMs;
    let lastContent: string | undefined;
    while (Date.now() < deadline) {
      lastContent = await this.tryReadOutputViaCdp(channelName);
      if (lastContent?.includes(expectedText)) return;
      await delay(500);
    }
    const preview = lastContent ? lastContent.slice(-1000) : '<not found>';
    throw new Error(`Output channel "${channelName}" did not contain "${expectedText}" within ${timeoutMs}ms. Last content tail: ${preview}`);
  }

  private async assertOutputNotContains(channelName: string, text: string): Promise<void> {
    const content = await this.tryReadOutputViaCdp(channelName);
    if (content !== undefined) {
      if (content.includes(text)) {
        throw new Error(`Output channel "${channelName}" unexpectedly contains "${text}"`);
      }
      return;
    }
    const output = await this.client.getOutputChannel(channelName);
    if (output.content.includes(text)) {
      throw new Error(`Output channel "${channelName}" unexpectedly contains "${text}"`);
    }
  }

  /**
   * Try to read an output channel's content via CDP (accesses VS Code renderer
   * internals to enumerate channels and read their backing log files).
   * Returns undefined if CDP is unavailable or the channel wasn't found.
   */
  private async tryReadOutputViaCdp(name: string): Promise<string | undefined> {
    // First try direct log file scan (most reliable — doesn't need CDP)
    const fromLogs = this.readFromVsCodeLogs(name);
    if (fromLogs !== undefined) return fromLogs;

    // Then try CDP discovery
    try {
      const cdp = await this.requireCdp();
      return await cdp.readOutputChannelContent(name);
    } catch {
      return undefined;
    }
  }

  /**
   * Scan VS Code's logs directory for output channel backing files.
   * The logs live at <userDataDir>/logs/<session>/window1/exthost/output_logging_<timestamp>/<N>-<Name>.log
   */
  private readFromVsCodeLogs(channelName: string): string | undefined {
    if (!this.userDataDir) return undefined;

    const outputDir = this.findLatestOutputLoggingDir();
    if (outputDir) {
      try {
        const lower = channelName.toLowerCase();
        const logFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.log'));
        for (const file of logFiles) {
          const match = file.match(/^\d+-(.+)\.log$/);
          if (match && match[1].toLowerCase() === lower) {
            return fs.readFileSync(path.join(outputDir, file), 'utf-8');
          }
        }
      } catch { /* scan failed */ }
    }

    return this.readLatestNamedLogFile(channelName);
  }

  private readLatestNamedLogFile(channelName: string): string | undefined {
    if (!this.userDataDir) return undefined;
    const logsRoot = path.join(this.userDataDir, 'logs');
    if (!fs.existsSync(logsRoot)) return undefined;

    try {
      const sessions = fs.readdirSync(logsRoot, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => path.join(logsRoot, e.name))
        .sort()
        .reverse();
      for (const sessionDir of sessions) {
        const candidates = this.findNamedLogFilesRecursive(sessionDir, channelName, 6)
          .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        if (candidates.length > 0) {
          return fs.readFileSync(candidates[0], 'utf-8');
        }
      }
    } catch { /* scan failed */ }

    return undefined;
  }

  private findNamedLogFilesRecursive(dir: string, channelName: string, maxDepth: number): string[] {
    if (maxDepth <= 0) return [];
    const target = channelName.toLowerCase();
    const results: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isFile() && entry.name.endsWith('.log')) {
          const label = entry.name.replace(/^\d+-/, '').replace(/\.log$/, '').toLowerCase();
          if (label === target) results.push(entryPath);
        } else if (entry.isDirectory()) {
          results.push(...this.findNamedLogFilesRecursive(entryPath, channelName, maxDepth - 1));
        }
      }
    } catch { /* scan failed */ }
    return results;
  }

  /**
   * Enumerate all output channel log files from VS Code's logs directory.
   */
  private scanAllVsCodeOutputLogs(): Array<{ label: string; file: string }> {
    const outputDir = this.findLatestOutputLoggingDir();
    if (!outputDir) return [];

    const results: Array<{ label: string; file: string }> = [];
    try {
      const logFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.log'));
      for (const file of logFiles) {
        const match = file.match(/^\d+-(.+)\.log$/);
        if (match) {
          results.push({
            label: match[1],
            file: path.join(outputDir, file),
          });
        }
      }
    } catch { /* scan failed */ }

    return results;
  }

  /**
   * Find the most recent output_logging_* directory inside VS Code's logs.
   * Structure: <userDataDir>/logs/<session>/window1/exthost/output_logging_<timestamp>/
   */
  private findLatestOutputLoggingDir(): string | undefined {
    if (!this.userDataDir) return undefined;

    const logsRoot = path.join(this.userDataDir, 'logs');
    if (!fs.existsSync(logsRoot)) return undefined;

    try {
      // Find the most recent session
      const sessions = fs.readdirSync(logsRoot, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort()
        .reverse();

      // Search each session for output_logging_* (could be at various nesting levels)
      for (const session of sessions) {
        const sessionDir = path.join(logsRoot, session);
        const found = this.findOutputLoggingRecursive(sessionDir, 4);
        if (found) return found;
      }
    } catch { /* scan failed */ }

    return undefined;
  }

  /**
   * Recursively search for an output_logging_* directory up to maxDepth levels.
   * Returns the most recent one found.
   */
  private findOutputLoggingRecursive(dir: string, maxDepth: number): string | undefined {
    if (maxDepth <= 0) return undefined;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const outputDirs = entries
        .filter(e => e.isDirectory() && e.name.startsWith('output_logging_'))
        .map(e => path.join(dir, e.name))
        .sort()
        .reverse();

      if (outputDirs.length > 0) return outputDirs[0];

      // Recurse into subdirectories
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const found = this.findOutputLoggingRecursive(path.join(dir, entry.name), maxDepth - 1);
        if (found) return found;
      }
    } catch { /* permission error or similar */ }

    return undefined;
  }

  /** Lazily start the FlaUI bridge for native dialog automation. */
  private async requireNativeUI(): Promise<NativeUIClient> {
    if (!this.nativeUI) {
      this.nativeUI = new NativeUIClient();
      this.nativeUI.targetPid = this.targetPid;
    }
    if (!this.nativeUI.isRunning) await this.nativeUI.start();
    return this.nativeUI;
  }

  private async typeText(text: string): Promise<void> {
    try {
      const cdp = await this.requireCdp();
      await cdp.insertText(text);
    } catch {
      await this.client.typeText(text);
    }
  }

  private async pressKey(key: string): Promise<void> {
    if (key.includes(' ')) {
      await this.client.pressKey(key);
      return;
    }

    try {
      const cdp = await this.requireCdp();
      await cdp.pressKey(key);
    } catch {
      await this.client.pressKey(key);
    }
  }

  /** Lazily connect a CDP client for webview interactions. */
  private async requireCdp(): Promise<CdpClient> {
    if (!this.cdp) {
      this.cdp = new CdpClient(this.cdpPort);
      // Wire controller's tab activation so CDP can bring a webview to front
      // before probing its DOM title.
      this.cdp.onActivateTab = async (title: string) => {
        await this.client.activateTab(title);
      };
    }
    if (!this.cdp.isConnected) {
      try {
        await this.cdp.connect();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Could not connect to Chrome DevTools Protocol on port ${this.cdpPort}: ${msg}\n` +
          'Make sure the Dev Host was launched via the "Debug extension with automation support" config ' +
          'so --remote-debugging-port is set.',
        );
      }
    }
    return this.cdp;
  }

  /** Call after all features are done to clean up the FlaUI process and CDP client. */
  cleanup(): void {
    this.nativeUI?.stop();
    this.cdp?.disconnect();
  }

  /** Record the current byte offset for every known channel. */
  private async recordChannelOffsets(): Promise<void> {
    this.scenarioStartOffsets.clear();
    try {
      // Scan VS Code log files directly (most reliable)
      const logChannels = this.scanAllVsCodeOutputLogs();
      for (const lc of logChannels) {
        try {
          const content = fs.readFileSync(lc.file, 'utf-8');
          this.scenarioStartOffsets.set(lc.label, content.length);
        } catch { /* file may not exist yet */ }
      }

      // Also get controller-side offsets
      const names = await this.client.getOutputChannels();
      const offsets = await Promise.all(
        names.map(async (name) => {
          const offset = await this.client.getOutputChannelOffset(name);
          return [name, offset] as const;
        }),
      );
      for (const [name, offset] of offsets) {
        if (!this.scenarioStartOffsets.has(name)) {
          this.scenarioStartOffsets.set(name, offset);
        }
      }
    } catch { /* best effort */ }
  }

  /**
   * Dump the captured output channels to the artifacts directory:
   *   <artifactsDir>/output-channels/<name>.log              (cumulative)
   *   <artifactsDir>/output-channels/<scenario>/<name>.log   (per-scenario delta)
   *
   * If the controller is in allow-list mode (the user used `I capture the
   * output channel "..."`), only the declared channels are written.
   */
  private async dumpCapturedChannels(scenarioName: string): Promise<void> {
    if (!this.artifactsDir) return;

    const cumulativeDir = path.join(this.artifactsDir, 'output-channels');
    const scenarioDir = path.join(cumulativeDir, sanitizeFilename(scenarioName));
    fs.mkdirSync(scenarioDir, { recursive: true });

    // Gather channels from both CDP (all extensions) and controller (own channel)
    const [controllerCaptured, controllerChannels, diagnostics] = await Promise.all([
      this.client.getCapturedChannels(),
      this.client.getOutputChannels().catch(() => [] as string[]),
      this.client.getDiagnostics().catch((e: any) => ({
        diag: [`getDiagnostics FAILED: ${e?.message ?? e}`] as string[],
        channelSummary: {},
      })),
    ]);

    // Scan VS Code log files directly (finds ALL extensions' channels)
    let logFileChannels: Array<{ label: string; content: string }> = [];
    const logDescriptors = this.scanAllVsCodeOutputLogs();
    for (const ld of logDescriptors) {
      try {
        const content = fs.readFileSync(ld.file, 'utf-8');
        if (content) logFileChannels.push({ label: ld.label, content });
      } catch { /* skip unreadable files */ }
    }

    // Merge: log file channels + controller channels (controller wins for its own channel)
    const allChannels = new Map<string, string>();
    for (const ch of logFileChannels) {
      allChannels.set(ch.label, ch.content);
    }
    for (const ch of controllerCaptured) {
      if (ch.content) {
        allChannels.set(ch.name, ch.content);
      }
    }

    const knownChannelNames = Array.from(new Set([
      ...controllerChannels,
      ...logFileChannels.map(c => c.label),
    ])).sort();

    const capturedList = Array.from(allChannels.entries()).map(([name, content]) => ({
      name,
      length: content.length,
    }));

    const manifest = {
      scenario: scenarioName,
      knownChannels: knownChannelNames,
      capturedChannels: capturedList,
      diagnostics,
      logFileChannelCount: logFileChannels.length,
      userDataDir: this.userDataDir ?? null,
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(scenarioDir, '_capture-manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );

    if (allChannels.size === 0) {
      return;
    }

    for (const [name, content] of allChannels) {
      const file = sanitizeFilename(name) + '.log';
      // Cumulative - overwritten each scenario
      fs.writeFileSync(path.join(cumulativeDir, file), content, 'utf-8');
      // Per-scenario delta
      const startOffset = this.scenarioStartOffsets.get(name) ?? 0;
      const delta = content.slice(startOffset);
      fs.writeFileSync(path.join(scenarioDir, file), delta, 'utf-8');
    }

    // Copy VS Code host logs (exthost.log = console.log from extensions,
    // renderer.log = renderer process logs) into the scenario directory.
    this.copyVsCodeHostLogs(scenarioDir);
  }

  /**
   * Copy exthost.log and renderer.log from VS Code's logs directory into
   * the target directory. These contain console.log output from extensions
   * and the renderer process respectively.
   */
  private copyVsCodeHostLogs(targetDir: string): void {
    if (!this.userDataDir) return;

    const logsRoot = path.join(this.userDataDir, 'logs');
    if (!fs.existsSync(logsRoot)) return;

    try {
      // Find the most recent session
      const sessions = fs.readdirSync(logsRoot, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort()
        .reverse();

      if (sessions.length === 0) return;
      const sessionDir = path.join(logsRoot, sessions[0]);

      // Copy key log files from the session
      const logsToCopy = [
        // exthost.log is nested under window1/exthost/
        { pattern: 'exthost.log', search: true },
        // renderer.log is under window1/
        { pattern: 'renderer.log', search: true },
      ];

      for (const logDef of logsToCopy) {
        const found = this.findFileRecursive(sessionDir, logDef.pattern, 3);
        if (found) {
          try {
            fs.copyFileSync(found, path.join(targetDir, logDef.pattern));
          } catch { /* non-fatal */ }
        }
      }
    } catch { /* non-fatal */ }
  }

  /**
   * Find a file by name recursively up to maxDepth levels.
   */
  private findFileRecursive(dir: string, fileName: string, maxDepth: number): string | undefined {
    if (maxDepth <= 0) return undefined;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() && entry.name === fileName) {
          return path.join(dir, entry.name);
        }
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const found = this.findFileRecursive(path.join(dir, entry.name), fileName, maxDepth - 1);
          if (found) return found;
        }
      }
    } catch { /* */ }
    return undefined;
  }

  /** Take a screenshot and save it to the artifacts directory. */
  async captureArtifactScreenshot(label?: string, kind: StepArtifact['kind'] = 'screenshot', targetDir = this.artifactsDir): Promise<StepArtifact> {
    if (!targetDir) {
      throw new Error('Screenshot capture is unavailable because this run has no artifacts directory');
    }
    this.screenshotCounter++;
    const name = label
      ? `${this.screenshotCounter}-${sanitizeFilename(label)}.png`
      : `${this.screenshotCounter}-screenshot.png`;
    const filePath = path.join(targetDir, name);
    fs.mkdirSync(targetDir, { recursive: true });

    await (await this.requireNativeUI()).captureDevHostScreenshot(filePath);
    return { kind, path: filePath, label: label ?? 'screenshot' };
  }

  private async takeScreenshot(label?: string): Promise<void> {
    const artifact = await this.captureArtifactScreenshot(label);
    this.dispatchArtifacts.push(artifact);
  }

  private buildArtifacts(screenshots: StepArtifact[] = [], logs: StepArtifact[] = [], warnings: string[] = []): LiveStepArtifacts | undefined {
    if (screenshots.length === 0 && logs.length === 0 && warnings.length === 0) return undefined;
    return { screenshots, logs, warnings };
  }

  // ─── File utility helpers ───────────────────────────────────────

  /** Resolve a file path - relative paths are resolved from cwd. */
  private resolveFilePath(filePath: string): string {
    if (path.isAbsolute(filePath)) return filePath;
    return path.resolve(process.cwd(), filePath);
  }

  /** Create a file (and parent dirs) via code - no UI. */
  private createFile(filePath: string, content: string): void {
    const resolved = this.resolveFilePath(filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, 'utf-8');
  }

  /** Create a file in the OS temp directory. */
  private createTempFile(fileName: string, content: string): void {
    const os = require('node:os');
    const resolved = path.join(os.tmpdir(), fileName);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, 'utf-8');
  }

  /** Delete a file if it exists. */
  private deleteFile(filePath: string): void {
    const resolved = this.resolveFilePath(filePath);
    if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
  }

  private resolveEnvVars(text: string): string {
    return text.replace(/\$\{([^}]+)\}/g, (_m, varName: string) => {
      if (varName in this.testData) return this.testData[varName];
      if (varName in this.envData) return this.envData[varName];
      return process.env[varName] ?? `\${${varName}}`;
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cloneArtifacts(artifacts: LiveStepArtifacts | undefined): MutableLiveStepArtifacts {
  return {
    screenshots: [...(artifacts?.screenshots ?? [])],
    logs: [...(artifacts?.logs ?? [])],
    warnings: [...(artifacts?.warnings ?? [])],
    manifestPath: artifacts?.manifestPath,
  };
}

interface MutableLiveStepArtifacts extends LiveStepArtifacts {
  screenshots: StepArtifact[];
  logs: StepArtifact[];
  warnings: string[];
  manifestPath?: string;
}

function sanitizeFilename(name: string, maxLength = 120): string {
  const sanitized = name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'unnamed';
  return sanitized.slice(0, maxLength) || 'unnamed';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeQuickInputText(text: string): string {
  return text.replace(/\$\([^)]+\)\s*/g, '').trim().toLowerCase();
}

function labelsMatch(actual: string, expected: string): boolean {
  return actual.toLowerCase() === expected.toLowerCase();
}

function findProgressByTitle(items: ProgressInfo[], title: string, status: ProgressInfo['status']): ProgressInfo | undefined {
  const needle = title.toLowerCase();
  return [...items].reverse().find((item) =>
    (item.title ?? '').toLowerCase().includes(needle) && item.status === status
  );
}

function formatNotifications(notifications: NotificationInfo[]): string {
  return notifications
    .map((notification) => `${notification.severity}:${notification.active === false ? 'inactive' : 'active'}:"${notification.message}"`)
    .join('; ');
}
