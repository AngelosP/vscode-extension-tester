import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

/**
 * Client for the FlaUI bridge - automates native Windows dialogs.
 * Spawns a .NET process that uses Windows UI Automation to interact
 * with OS-level dialogs (Save As, Open File, etc.).
 */
export class NativeUIClient {
  private process?: cp.ChildProcess;
  private rl?: readline.Interface;
  private pending?: { resolve: (v: unknown) => void; reject: (e: Error) => void };

  /**
   * When set, `findDevHostWindow` will only match windows whose process is a
   * descendant of this PID (i.e. the VS Code main process we spawned).
   * This prevents FlaUI from grabbing an unrelated Dev Host (e.g. an F5 session).
   */
  targetPid?: number;

  async start(): Promise<void> {
    const bridge = resolveBridgeCommand();

    this.process = cp.spawn(bridge.command, bridge.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.rl = readline.createInterface({ input: this.process.stdout! });
    this.rl.on('line', (line) => {
      if (this.pending) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.error) {
            this.pending.reject(new Error(parsed.error));
          } else {
            this.pending.resolve(parsed.result);
          }
        } catch {
          this.pending.reject(new Error(`Invalid response: ${line}`));
        }
        this.pending = undefined;
      }
    });
  }

  stop(): void {
    this.rl?.close();
    this.process?.kill();
    this.process = undefined;
  }

  get isRunning(): boolean {
    return this.process !== undefined && !this.process.killed;
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
  async clickElement(elementId: string): Promise<void> {
    await this.call('clickElement', { elementId });
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
  async clickInDevHost(elementName: string, controlType?: string): Promise<void> {
    const win = await this.findDevHostWindow();
    const el = await this.findElement(win.id, elementName, controlType);
    if (!el) {
      throw new Error(`Element "${elementName}" not found in Dev Host window`);
    }
    await this.clickElement(el.id);
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
    if (allowedPids && candidates.length > 1) {
      // Pick the window that belongs to the VS Code instance we launched
      win = candidates.find(w => allowedPids.has(w.processId));
    }
    // Fall back to first match (single instance or no PID filter)
    if (!win) win = candidates[0];
    if (!win) throw new Error('Dev Host window not found');

    await this.focusWindow(win.id);
    return win;
  }

  // ─── Internal ───────────────────────────────────────────────────

  private call(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process || this.process.killed) {
        reject(new Error('FlaUI bridge not running'));
        return;
      }
      this.pending = { resolve, reject };
      const line = JSON.stringify({ method, params }) + '\n';
      this.process.stdin!.write(line);
    });
  }
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
    const output = cp.execSync(
      'wmic process get ProcessId,ParentProcessId /format:csv',
      { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    // Build parent → children map
    const children = new Map<number, number[]>();
    for (const line of output.split('\n')) {
      const parts = line.trim().split(',');
      // CSV columns: Node, ParentProcessId, ProcessId
      if (parts.length >= 3) {
        const parentPid = parseInt(parts[1], 10);
        const procPid = parseInt(parts[2], 10);
        if (!isNaN(parentPid) && !isNaN(procPid)) {
          if (!children.has(parentPid)) children.set(parentPid, []);
          children.get(parentPid)!.push(procPid);
        }
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
    // If wmic fails, return just the root PID — best effort
  }
  return descendants;
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
