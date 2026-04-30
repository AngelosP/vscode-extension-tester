import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { NativeBridgeErrorDetails, ScreenshotCaptureResult } from '../types.js';

/**
 * Client for the FlaUI bridge - automates native Windows dialogs.
 * Spawns a .NET process that uses Windows UI Automation to interact
 * with OS-level dialogs (Save As, Open File, etc.).
 */
export class NativeUIClient {
  private process?: cp.ChildProcess;
  private rl?: readline.Interface;
  private readonly pending = new Map<number, PendingNativeCall>();
  private readonly pendingOrder: number[] = [];
  private nextRequestId = 0;
  private callQueue: Promise<unknown> = Promise.resolve();
  private exited = false;
  private stderrBuffer = '';

  /**
   * When set, `findDevHostWindow` will only match windows whose process is a
   * descendant of this PID (i.e. the VS Code main process we spawned).
   * This prevents FlaUI from grabbing an unrelated Dev Host (e.g. an F5 session).
   */
  targetPid?: number;

  async start(): Promise<void> {
    if (this.isRunning) return;

    const bridge = resolveBridgeCommand();

    this.exited = false;
    this.stderrBuffer = '';

    this.process = cp.spawn(bridge.command, bridge.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stderr?.on('data', (chunk) => {
      this.stderrBuffer += chunk.toString();
      if (this.stderrBuffer.length > 8000) {
        this.stderrBuffer = this.stderrBuffer.slice(-8000);
      }
    });

    this.process.on('error', (err) => {
      this.exited = true;
      this.failAllPending(new Error(`FlaUI bridge failed: ${err.message}`));
    });

    this.process.on('exit', (code, signal) => {
      this.exited = true;
      const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      const stderr = this.stderrBuffer.trim();
      this.failAllPending(
        new Error(`FlaUI bridge exited with ${detail}${stderr ? `: ${stderr}` : ''}`),
      );
      this.process = undefined;
    });

    this.rl = readline.createInterface({ input: this.process.stdout! });
    this.rl.on('line', (line) => this.handleLine(line));
  }

  stop(): void {
    this.failAllPending(new Error('FlaUI bridge stopped'));
    this.rl?.close();
    this.process?.kill();
    this.process = undefined;
    this.exited = true;
  }

  get isRunning(): boolean {
    return this.process !== undefined && !this.process.killed && !this.exited;
  }

  /** Find a window by title substring. */
  async findWindow(titlePattern: string): Promise<NativeWindow | null> {
    return this.call('findWindow', { titlePattern }) as Promise<NativeWindow | null>;
  }

  /** Find a UI element by name within a window. */
  async findElement(windowId: string, name: string, controlType?: string): Promise<NativeElement | null> {
    return this.call('findElement', { windowId, name, controlType }) as Promise<NativeElement | null>;
  }

  /** Click an element. */
  async clickElement(elementId: string, options?: NativeClickOptions): Promise<void> {
    await this.call('clickElement', withClickOptions({ elementId }, options));
  }

  /** Move the OS mouse cursor to screen coordinates. */
  async moveMouse(x: number, y: number): Promise<void> {
    await this.call('moveMouse', { x, y });
  }

  /** Click at screen coordinates, or at the current cursor position when x/y are omitted. */
  async clickMouse(x?: number, y?: number, options?: NativeClickOptions): Promise<void> {
    await this.call('clickMouse', withClickOptions({ x, y }, options));
  }

  /** Move the OS mouse cursor to coordinates relative to the targeted Dev Host window. */
  async moveMouseInDevHost(x: number, y: number): Promise<void> {
    const point = await this.resolveDevHostPoint(x, y);
    await this.moveMouse(point.x, point.y);
  }

  /** Click coordinates relative to the targeted Dev Host window. */
  async clickInDevHostAt(x: number, y: number, options?: NativeClickOptions): Promise<void> {
    const point = await this.resolveDevHostPoint(x, y);
    await this.clickMouse(point.x, point.y, options);
  }

  /** Set text in a text field. */
  async setText(elementId: string, text: string): Promise<void> {
    await this.call('setText', { elementId, text });
  }

  /** Bring a window to the foreground. */
  async focusWindow(windowId: string): Promise<void> {
    await this.call('focusWindow', { windowId });
  }

  /** Resize a window to the given dimensions. */
  async resizeWindow(windowId: string, width: number, height: number): Promise<void> {
    await this.call('resizeWindow', { windowId, width, height });
  }

  /** Move a window to the given screen coordinates. */
  async moveWindow(windowId: string, x: number, y: number): Promise<void> {
    await this.call('moveWindow', { windowId, x, y });
  }

  /** Capture a window screenshot to a PNG file. */
  async captureWindowScreenshot(windowId: string, filePath: string): Promise<ScreenshotCaptureResult> {
    return this.call('captureWindowScreenshot', { windowId, filePath }) as Promise<ScreenshotCaptureResult>;
  }

  /** List all visible windows. */
  async listWindows(): Promise<NativeWindow[]> {
    return this.call('listWindows', {}) as Promise<NativeWindow[]>;
  }

  /** Get the accessibility tree of a window. */
  async getElementTree(windowId: string): Promise<unknown> {
    return this.call('getElementTree', { windowId });
  }

  /** Press a keyboard key (e.g. 'enter', 'escape', 'tab'). */
  async pressKey(key: string): Promise<void> {
    await this.call('pressKey', { key });
  }

  /** Find all visible popup/menu items in a window. */
  async findPopupItems(windowId: string): Promise<NativeElement[]> {
    return this.call('findPopupItems', { windowId }) as Promise<NativeElement[]>;
  }

  /** Select an item from a popup menu/list by name (partial match). */
  async selectPopupItem(windowId: string, itemName: string): Promise<{ success: boolean; selected: string }> {
    return this.call('selectPopupItem', { windowId, itemName }) as Promise<{ success: boolean; selected: string }>;
  }

  // ─── High-level helpers ─────────────────────────────────────────

  /**
   * Handle a Save As dialog: wait for it, type the filename, confirm.
   */
  async handleSaveAsDialog(filename: string, timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const result = await this.findFileDialog(['Save As', 'Save File'], deadline);
    if (!result) throw new Error('Save As dialog not found');

    const { fileNameBox } = result;
    await this.clickElement(fileNameBox.id); // ensure focus in the edit
    await this.setText(fileNameBox.id, filename);
    await this.pressKey('enter'); // confirm — more reliable than clicking the split button
  }

  /**
   * Handle an Open File dialog: wait for it, type the filename, confirm.
   */
  async handleOpenDialog(filename: string, timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const result = await this.findFileDialog(['Open', 'Open File'], deadline);
    if (!result) throw new Error('Open dialog not found');

    const { fileNameBox } = result;
    await this.clickElement(fileNameBox.id); // ensure focus in the edit
    await this.setText(fileNameBox.id, filename);
    await this.pressKey('enter'); // confirm — more reliable than clicking the split button
  }

  /**
   * Dismiss any dialog by clicking a button by name (e.g. "Cancel", "OK", "Don't Save").
   */
  async clickDialogButton(titlePattern: string, buttonName: string, timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let win: NativeWindow | null = null;
    let btn: NativeElement | null = null;

    // Poll for a window that both matches the title AND contains the button.
    // This avoids false matches against unrelated windows (e.g. VS Code windows
    // whose titles happen to contain the search pattern).
    while (Date.now() < deadline) {
      const allWindows = await this.listWindows() as NativeWindow[];
      for (const w of allWindows) {
        if (w.title.toLowerCase().includes(titlePattern.toLowerCase())) {
          const candidate = await this.findElement(w.id, buttonName, 'button');
          if (candidate) { win = w; btn = candidate; break; }
        }
      }
      if (win) break;
      await delay(500);
    }
    if (!win || !btn) throw new Error(`Dialog "${titlePattern}" not found`);

    await this.focusWindow(win.id);
    await this.clickElement(btn.id);
  }

  /**
   * Click an element by name/text inside the Dev Host window.
   * Searches the entire UI tree - works for webview elements too since
   * Windows UI Automation sees through Chromium's accessibility layer.
   */
  async clickInDevHost(elementName: string, controlType?: string, options?: NativeClickOptions): Promise<void> {
    const win = await this.findDevHostWindow();
    const el = await this.findElement(win.id, elementName, controlType);
    if (!el) {
      throw new Error(`Element "${elementName}" not found in Dev Host window`);
    }
    await this.clickElement(el.id, options);
  }

  /**
   * Focus an element by name/text inside the Dev Host window.
   */
  async focusInDevHost(elementName: string, controlType?: string): Promise<void> {
    const win = await this.findDevHostWindow();
    const el = await this.findElement(win.id, elementName, controlType);
    if (!el) {
      throw new Error(`Element "${elementName}" not found in Dev Host window`);
    }
    // Click to focus
    await this.clickElement(el.id);
  }

  /**
   * Resize the Dev Host window to the given dimensions.
   */
  async resizeDevHost(width: number, height: number): Promise<void> {
    const win = await this.findDevHostWindow();
    await this.resizeWindow(win.id, width, height);
  }

  /**
   * Move the Dev Host window to the given screen coordinates.
   */
  async moveDevHost(x: number, y: number): Promise<void> {
    const win = await this.findDevHostWindow();
    await this.moveWindow(win.id, x, y);
  }

  /** Capture the Dev Host window to a PNG file. */
  async captureDevHostScreenshot(filePath: string): Promise<ScreenshotCaptureResult> {
    const win = await this.findDevHostWindow();
    return this.captureWindowScreenshot(win.id, filePath);
  }

  /**
   * Get the accessibility tree of the Dev Host window - useful for debugging
   * what elements are available to click/focus.
   */
  async getDevHostTree(): Promise<unknown> {
    const win = await this.findDevHostWindow();
    return this.getElementTree(win.id);
  }

  /**
   * List all visible popup/menu items in the Dev Host window.
   * Finds MenuItem, ListItem, and TreeItem descendants of popup containers.
   * Useful for discovering what items are available in an open dropdown/menu.
   */
  async getDevHostPopupItems(): Promise<NativeElement[]> {
    const win = await this.findDevHostWindow();
    return this.findPopupItems(win.id);
  }

  /**
   * Select an item from an open popup menu/dropdown in the Dev Host window.
   * Uses Windows UI Automation to find the item by name (partial match)
   * and click it directly — bypasses the webview focus issue with CDP/keyboard.
   */
  async selectFromDevHostPopup(itemName: string, timeoutMs = 5000): Promise<string> {
    const win = await this.findDevHostWindow();
    const deadline = Date.now() + timeoutMs;

    // Poll — the popup may still be animating in
    while (Date.now() < deadline) {
      try {
        const result = await this.selectPopupItem(win.id, itemName);
        return result.selected;
      } catch {
        await delay(300);
      }
    }
    throw new Error(
      `Popup item "${itemName}" not found in Dev Host within ${timeoutMs}ms. ` +
      `Use getDevHostPopupItems() to see available items.`
    );
  }

  /**
   * Poll for a native file dialog by trying each title pattern in turn.
   * A window is only accepted if it contains a "File name:" edit field,
   * which distinguishes a real file dialog from an unrelated window whose
   * title happens to contain "Open" or "Save".
   *
   * On some Windows configurations the file dialog appears as a child of
   * the owning window. As a fallback we also check every visible window,
   * but we require it to also have an "Open" or "Save" button so we don't
   * accidentally match the parent VS Code window (which can "see through"
   * to its dialog's elements via UI Automation).
   */
  private async findFileDialog(
    titlePatterns: string[],
    deadline: number,
  ): Promise<{ win: NativeWindow; fileNameBox: NativeElement } | null> {
    while (Date.now() < deadline) {
      const allWindows = await this.listWindows() as NativeWindow[];

      // Pass 1: prefer windows whose title matches a pattern
      for (const w of allWindows) {
        const titleLower = w.title.toLowerCase();
        const matches = titlePatterns.some(p => titleLower.includes(p.toLowerCase()));
        if (!matches) continue;

        const fileNameBox = await this.findElement(w.id, 'File name:', 'edit');
        if (fileNameBox) {
          await this.focusWindow(w.id);
          return { win: w, fileNameBox };
        }
      }

      // Pass 2: the dialog may be a child of the owning window.  Check ALL
      // windows, but require BOTH a "File name:" edit AND a confirm button
      // ("Open" or "Save") to avoid matching the parent VS Code window.
      for (const w of allWindows) {
        const fileNameBox = await this.findElement(w.id, 'File name:', 'edit');
        if (!fileNameBox) continue;

        // Verify this is a real dialog by checking for a confirm button
        const hasOpen = await this.findElement(w.id, 'Open', 'button');
        const hasSave = hasOpen ? null : await this.findElement(w.id, 'Save', 'button');
        if (hasOpen || hasSave) {
          await this.focusWindow(w.id);
          return { win: w, fileNameBox };
        }
      }

      await delay(500);
    }
    return null;
  }

  /** Find the Extension Development Host window. */
  private async findDevHostWindow(): Promise<NativeWindow> {
    const allowedPids = this.targetPid ? getDescendantPids(this.targetPid) : undefined;

    const windows = await this.listWindows() as NativeWindow[];
    const candidates = windows.filter(
      w => w.title.includes('Extension Development Host')
    );

    let win: NativeWindow | undefined;
    if (allowedPids) {
      // Pick only the window that belongs to the VS Code instance we launched.
      win = candidates.find(w => allowedPids.has(w.processId));
      if (!win) {
        throw new Error(
          `Dev Host window matching target PID ${this.targetPid} was not found. ` +
          `Candidates: ${candidates.map(w => `${w.title} (pid ${w.processId})`).join(', ') || '<none>'}`
        );
      }
    }
    // Fall back to first match (single instance or no PID filter)
    if (!win) win = candidates[0];
    if (!win) throw new Error('Dev Host window not found');

    await this.focusWindow(win.id);
    return win;
  }

  private async resolveDevHostPoint(x: number, y: number): Promise<{ x: number; y: number }> {
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      throw new Error(`Relative Dev Host coordinates must be integers: ${x}, ${y}`);
    }
    const win = await this.findDevHostWindow();
    if (x < 0 || y < 0 || x >= win.bounds.width || y >= win.bounds.height) {
      throw new Error(
        `Relative Dev Host coordinate ${x}, ${y} is outside window bounds ` +
        `${Math.round(win.bounds.width)}x${Math.round(win.bounds.height)}`
      );
    }
    return {
      x: Math.round(win.bounds.x + x),
      y: Math.round(win.bounds.y + y),
    };
  }

  // ─── Internal ───────────────────────────────────────────────────

  private call(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    const task = this.callQueue.then(
      () => this.send(method, params, timeoutMs),
      () => this.send(method, params, timeoutMs),
    );
    this.callQueue = task.catch(() => undefined);
    return task;
  }

  private send(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process || this.process.killed) {
        reject(new Error('FlaUI bridge not running'));
        return;
      }

      const id = ++this.nextRequestId;
      const timer = setTimeout(() => {
        this.removePending(id);
        reject(new Error(`Native UI request "${method}" timed out after ${timeoutMs}ms`));
        this.restartAfterProtocolFailure();
      }, timeoutMs);

      this.pending.set(id, { method, resolve, reject, timer });
      this.pendingOrder.push(id);

      try {
        const line = JSON.stringify({ id, method, params }) + '\n';
        this.process.stdin!.write(line);
      } catch (err) {
        clearTimeout(timer);
        this.removePending(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private handleLine(line: string): void {
    let parsed: NativeBridgeResponse;
    try {
      parsed = JSON.parse(line) as NativeBridgeResponse;
    } catch {
      this.failNextPending(new Error(`Invalid response: ${line}`));
      return;
    }

    const id = typeof parsed.id === 'number' ? parsed.id : this.pendingOrder[0];
    if (id === undefined) return;

    const pending = this.pending.get(id);
    if (!pending) return;

    this.removePending(id);
    clearTimeout(pending.timer);

    if (parsed.error) {
      pending.reject(new Error(formatNativeBridgeError(parsed.error, this.stderrBuffer)));
    } else {
      pending.resolve(parsed.result);
    }
  }

  private failNextPending(error: Error): void {
    const id = this.pendingOrder[0];
    if (id === undefined) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.removePending(id);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private failAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    this.pendingOrder.length = 0;
  }

  private removePending(id: number): void {
    this.pending.delete(id);
    const index = this.pendingOrder.indexOf(id);
    if (index >= 0) this.pendingOrder.splice(index, 1);
  }

  private restartAfterProtocolFailure(): void {
    this.rl?.close();
    this.process?.kill();
    this.process = undefined;
    this.exited = true;
  }
}

interface PendingNativeCall {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface NativeBridgeResponse {
  id?: number;
  result?: unknown;
  error?: string | NativeBridgeErrorDetails;
}

function formatNativeBridgeError(error: string | NativeBridgeErrorDetails, stderr: string): string {
  if (typeof error === 'string') {
    const detail = stderr.trim();
    return detail ? `${error}\nRecent FlaUI stderr:\n${detail}` : error;
  }

  const parts = [error.message];
  const metadata = [
    error.type && `type=${error.type}`,
    error.hresult !== undefined && `hresult=${error.hresult}`,
    error.method && `method=${error.method}`,
    error.phase && `phase=${error.phase}`,
  ].filter(Boolean).join(', ');
  if (metadata) parts.push(`(${metadata})`);
  if (error.inner) parts.push(`Inner: ${formatNativeBridgeError(error.inner, '')}`);
  if (error.stack) parts.push(`Stack:\n${error.stack}`);
  const detail = stderr.trim();
  if (detail) parts.push(`Recent FlaUI stderr:\n${detail}`);
  return parts.join('\n');
}

export type NativeMouseButton = 'left' | 'right' | 'middle';

export interface NativeClickOptions {
  button?: NativeMouseButton;
  clickCount?: number;
}

function withClickOptions(
  params: Record<string, unknown>,
  options?: NativeClickOptions,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...params };
  if (options?.button) result['button'] = options.button;
  if (options?.clickCount !== undefined) result['clickCount'] = options.clickCount;
  return result;
}

function resolveBridgeCommand(): { command: string; args: string[] } {
  const bundledExePath = path.resolve(
    __dirname,
    '..',
    '..',
    'assets',
    'native',
    'win-x64',
    'FlaUIBridge.exe'
  );
  if (fs.existsSync(bundledExePath)) {
    return { command: bundledExePath, args: [] };
  }

  const bundledDllPath = path.resolve(
    __dirname,
    '..',
    '..',
    'assets',
    'native',
    'win-x64',
    'FlaUIBridge.dll'
  );
  if (fs.existsSync(bundledDllPath)) {
    return { command: 'dotnet', args: [bundledDllPath] };
  }

  const repoDllPath = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'dotnet',
    'bin',
    'Release',
    'net8.0-windows',
    'FlaUIBridge.dll'
  );
  if (fs.existsSync(repoDllPath)) {
    return { command: 'dotnet', args: [repoDllPath] };
  }

  throw new Error(
    'FlaUI bridge binary not found. Run `npm run build:native` before using native UI automation.'
  );
}

export interface NativeWindow {
  id: string;
  title: string;
  processId: number;
  bounds: { x: number; y: number; width: number; height: number };
  isVisible: boolean;
}

/**
 * Build a set containing `pid` and all its transitive child process IDs.
 * Used to match a VS Code window (owned by a renderer child process)
 * back to the main process we spawned.
 */
function getDescendantPids(pid: number): Set<number> {
  const descendants = new Set<number>([pid]);
  try {
    const output = getProcessTreeCsv();
    // Build parent → children map
    const children = new Map<number, number[]>();
    for (const line of output.split('\n')) {
      const parts = line.trim().split(',').map((part) => part.trim().replace(/^"|"$/g, ''));
      if (parts.length < 2 || parts[0] === 'Node' || parts[0] === 'ParentProcessId') continue;
      const parentIndex = parts.length >= 3 ? parts.length - 2 : 0;
      const processIndex = parts.length >= 3 ? parts.length - 1 : 1;
      const parentPid = parseInt(parts[parentIndex], 10);
      const procPid = parseInt(parts[processIndex], 10);
      if (!isNaN(parentPid) && !isNaN(procPid)) {
        if (!children.has(parentPid)) children.set(parentPid, []);
        children.get(parentPid)!.push(procPid);
      }
    }
    // BFS from pid
    const queue = [pid];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const child of children.get(current) ?? []) {
        if (!descendants.has(child)) {
          descendants.add(child);
          queue.push(child);
        }
      }
    }
  } catch {
    // If process discovery fails, return just the root PID — best effort
  }
  return descendants;
}

function getProcessTreeCsv(): string {
  try {
    return cp.execSync(
      'wmic process get ProcessId,ParentProcessId /format:csv',
      { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch {
    return cp.execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ParentProcessId, ProcessId | ConvertTo-Csv -NoTypeInformation"',
      { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  }
}

export interface NativeElement {
  id: string;
  name: string;
  controlType: string;
  isEnabled: boolean;
  isVisible: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  value?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
