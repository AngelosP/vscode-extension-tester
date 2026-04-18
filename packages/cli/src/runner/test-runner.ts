import type { ControllerClient } from './controller-client.js';
import type { ParsedFeature, ParsedScenario, ParsedStep } from './gherkin-parser.js';
import type { FeatureResult, ScenarioResult, StepResult } from '../types.js';
import { NativeUIClient } from './native-ui-client.js';
import { loadEnv } from '../agent/env.js';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Executes parsed Gherkin features by dispatching steps to the controller.
 */
export class TestRunner {
  private readonly envData: Record<string, string>;
  private nativeUI?: NativeUIClient;
  private screenshotCounter = 0;

  constructor(
    private readonly client: ControllerClient,
    private readonly testData: Record<string, string> = {},
    private readonly artifactsDir?: string,
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

    return {
      name: scenario.name,
      status: failed ? 'failed' : stepResults.every((s) => s.status === 'passed') ? 'passed' : 'skipped',
      steps: stepResults,
      durationMs: Date.now() - startTime,
      tags: scenario.tags,
    };
  }

  private async runStep(step: ParsedStep): Promise<StepResult> {
    const startTime = Date.now();
    const resolvedText = this.resolveEnvVars(step.text);

    // Snapshot output channels before the step
    let outputBefore = '';
    try { outputBefore = await this.client.getAllOutputContent(); } catch { /* best effort */ }

    try {
      await this.dispatch(resolvedText);

      // Capture output produced during this step
      let outputLog: string | undefined;
      try {
        const outputAfter = await this.client.getAllOutputContent();
        const newOutput = outputAfter.slice(outputBefore.length).trim();
        if (newOutput) outputLog = newOutput;
      } catch { /* best effort */ }

      return { keyword: step.keyword, text: step.text, status: 'passed', durationMs: Date.now() - startTime, outputLog };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));

      let outputLog: string | undefined;
      try {
        const outputAfter = await this.client.getAllOutputContent();
        const newOutput = outputAfter.slice(outputBefore.length).trim();
        if (newOutput) outputLog = newOutput;
      } catch { /* best effort */ }

      return { keyword: step.keyword, text: step.text, status: 'failed', durationMs: Date.now() - startTime, error: { message: error.message, stack: error.stack }, outputLog };
    }
  }

  private async dispatch(text: string): Promise<void> {
    let match: RegExpMatchArray | null;

    // ─── Reset state ───
    if (/^(?:the )?(?:VS Code|Dev Host|extension) is in a clean state$/.test(text)) {
      await this.client.resetState();
      await delay(500); // Let VS Code settle
      return;
    }

    // ─── Utility: create file with content ───
    match = text.match(/^a file "([^"]+)" exists with content "([^"]+)"$/);
    if (match) { this.createFile(match[1], match[2]); return; }

    // ─── Utility: create empty file ───
    match = text.match(/^a file "([^"]+)" exists$/);
    if (match) { this.createFile(match[1], ''); return; }

    // ─── Utility: create temp file with content ───
    match = text.match(/^a temp file "([^"]+)" exists with content "([^"]+)"$/);
    if (match) { this.createTempFile(match[1], match[2]); return; }

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
    match = text.match(/^I execute command "([^"]+)"$/);
    if (match) { await this.client.executeCommand(match[1]); return; }

    // ─── QuickPick ───
    match = text.match(/^I select "([^"]+)" from the QuickPick$/);
    if (match) { await this.client.respondToQuickPick(match[1]); return; }

    // ─── InputBox ───
    match = text.match(/^I type "([^"]+)" into the InputBox$/);
    if (match) { await this.client.respondToInputBox(match[1]); return; }

    // ─── Dialog ───
    match = text.match(/^I click "([^"]+)" on the dialog$/);
    if (match) { await this.client.respondToDialog(match[1]); return; }

    // ─── Auth ───
    match = text.match(/^I sign in with Microsoft as "([^"]+)"$/);
    if (match) { await this.client.handleAuth('microsoft', { username: match[1] }); return; }

    // ─── Notification assertion ───
    match = text.match(/^I should see notification "([^"]+)"$/);
    if (match) { await this.assertNotification(match[1]); return; }

    // ─── Negative notification assertion ───
    match = text.match(/^I should not see notification "([^"]+)"$/);
    if (match) { await this.assertNoNotification(match[1]); return; }

    // ─── Editor assertion ───
    match = text.match(/^the editor should contain "([^"]+)"$/);
    if (match) { await this.assertEditorContent(match[1]); return; }

    // ─── Output channel assertion ───
    match = text.match(/^the output channel "([^"]+)" should contain "([^"]+)"$/);
    if (match) { await this.assertOutputContains(match[1], match[2]); return; }

    // ─── Negative output channel assertion ───
    match = text.match(/^the output channel "([^"]+)" should not contain "([^"]+)"$/);
    if (match) { await this.assertOutputNotContains(match[1], match[2]); return; }

    // ─── Type text (via controller — always available) ───
    match = text.match(/^I type "([^"]+)"$/);
    if (match) { await this.client.typeText(match[1]); return; }

    // ─── Press key ───
    match = text.match(/^I press "([^"]+)"$/);
    if (match) { await this.client.pressKey(match[1]); return; }

    // ─── Click element by name/text in Dev Host (uses Windows UI Automation) ───
    match = text.match(/^I click the element "([^"]+)"$/);
    if (match) { await this.requireNativeUI().clickInDevHost(match[1]); return; }

    // ─── Click element by name/text with control type ───
    match = text.match(/^I click the "([^"]+)" (\w+)$/);
    if (match) { await this.requireNativeUI().clickInDevHost(match[1], match[2]); return; }

    // ─── Native dialog: Save As ───
    match = text.match(/^I save the file as "([^"]+)"$/);
    if (match) { await this.requireNativeUI().handleSaveAsDialog(match[1]); return; }

    // ─── Native dialog: Open File ───
    match = text.match(/^I open the file "([^"]+)"$/);
    if (match) { await this.requireNativeUI().handleOpenDialog(match[1]); return; }

    // ─── Native dialog: Click button by dialog title ───
    match = text.match(/^I click "([^"]+)" on the "([^"]+)" dialog$/);
    if (match) { await this.requireNativeUI().clickDialogButton(match[2], match[1]); return; }

    // ─── Native dialog: Dismiss Save As ───
    if (/^I cancel the (?:Save As|Save|Open|Open File) dialog$/.test(text)) {
      const ui = this.requireNativeUI();
      try { await ui.clickDialogButton('Save', 'Cancel'); } catch {
        await ui.clickDialogButton('Open', 'Cancel');
      }
      return;
    }

    // ─── Screenshot ───
    match = text.match(/^I take a screenshot(?: "([^"]+)")?$/);
    if (match) { await this.takeScreenshot(match[1]); return; }

    // ─── Wait ───
    match = text.match(/^I wait (\d+) seconds?$/);
    if (match) { await delay(parseInt(match[1], 10) * 1000); return; }

    // ─── Setup steps (no-ops handled by orchestrator) ───
    if (/^(VS Code is running|extension .+ is installed|recording is enabled|debug capture is enabled)/.test(text)) return;

    throw new Error(`No step definition matches: "${text}"`);
  }

  private async assertNotification(expectedText: string): Promise<void> {
    for (let i = 0; i < 10; i++) {
      const notifications = await this.client.getNotifications();
      if (notifications.some((n) => n.message.includes(expectedText))) return;
      await delay(500);
    }
    throw new Error(`Notification containing "${expectedText}" not found after 5s`);
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
    const output = await this.client.getOutputChannel(channelName);
    if (!output.content.includes(expectedText)) {
      throw new Error(`Output channel "${channelName}" does not contain "${expectedText}"`);
    }
  }

  private async assertOutputNotContains(channelName: string, text: string): Promise<void> {
    const output = await this.client.getOutputChannel(channelName);
    if (output.content.includes(text)) {
      throw new Error(`Output channel "${channelName}" unexpectedly contains "${text}"`);
    }
  }

  /** Lazily start the FlaUI bridge for native dialog automation. */
  private requireNativeUI(): NativeUIClient {
    if (!this.nativeUI) {
      this.nativeUI = new NativeUIClient();
      // Start synchronously — first call will await
      this.nativeUI.start().catch(() => { /* logged by individual calls */ });
    }
    return this.nativeUI;
  }

  /** Call after all features are done to clean up the FlaUI process. */
  cleanup(): void {
    this.nativeUI?.stop();
  }

  /** Take a screenshot and save it to the artifacts directory. */
  private async takeScreenshot(label?: string): Promise<void> {
    if (!this.artifactsDir) {
      throw new Error('Screenshot requires --run-id mode (artifacts directory not set)');
    }
    this.screenshotCounter++;
    const name = label
      ? `${this.screenshotCounter}-${label.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`
      : `${this.screenshotCounter}-screenshot.png`;
    const filePath = path.join(this.artifactsDir, name);
    fs.mkdirSync(this.artifactsDir, { recursive: true });

    // Write the PS script to a temp file to avoid quoting issues
    const os = require('node:os');
    const scriptPath = path.join(os.tmpdir(), `vscode-ext-tester-screenshot-${process.pid}.ps1`);
    const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Screenshot {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$devHost = Get-Process | Where-Object { $_.MainWindowTitle -like "*Extension Development Host*" } | Select-Object -First 1
if ($devHost -and $devHost.MainWindowHandle -ne [IntPtr]::Zero) {
  [Win32Screenshot]::ShowWindow($devHost.MainWindowHandle, 9)
  [Win32Screenshot]::SetForegroundWindow($devHost.MainWindowHandle)
  Start-Sleep -Milliseconds 500
  $rect = New-Object Win32Screenshot+RECT
  [Win32Screenshot]::GetWindowRect($devHost.MainWindowHandle, [ref]$rect)
  $w = $rect.Right - $rect.Left
  $h = $rect.Bottom - $rect.Top
  if ($w -gt 0 -and $h -gt 0) {
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
    $bmp.Save('${filePath.replace(/\\/g, '\\\\').replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    exit 0
  }
}
# Fallback: capture full screen if Dev Host window not found
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save('${filePath.replace(/\\/g, '\\\\').replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
`;
    fs.writeFileSync(scriptPath, script, 'utf-8');

    try {
      cp.execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`, {
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } finally {
      try { fs.unlinkSync(scriptPath); } catch { /* best effort */ }
    }
  }

  // ─── File utility helpers ───────────────────────────────────────

  /** Resolve a file path — relative paths are resolved from cwd. */
  private resolveFilePath(filePath: string): string {
    if (path.isAbsolute(filePath)) return filePath;
    return path.resolve(process.cwd(), filePath);
  }

  /** Create a file (and parent dirs) via code — no UI. */
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
