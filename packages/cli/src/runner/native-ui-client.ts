import * as cp from 'node:child_process';
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

  async start(): Promise<void> {
    const dllPath = path.resolve(
      __dirname, '..', '..', '..', '..', 'dotnet', 'bin', 'Release', 'net8.0-windows', 'FlaUIBridge.dll'
    );

    this.process = cp.spawn('dotnet', [dllPath], {
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

  /** List all visible windows. */
  async listWindows(): Promise<NativeWindow[]> {
    return this.call('listWindows', {}) as Promise<NativeWindow[]>;
  }

  /** Get the accessibility tree of a window. */
  async getElementTree(windowId: string): Promise<unknown> {
    return this.call('getElementTree', { windowId });
  }

  // ─── High-level helpers ─────────────────────────────────────────

  /**
   * Handle a Save As dialog: wait for it, type the filename, click Save.
   */
  async handleSaveAsDialog(filename: string, timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let win: NativeWindow | null = null;

    // Poll for the dialog
    while (Date.now() < deadline) {
      win = await this.findWindow('Save As');
      if (!win) win = await this.findWindow('Save File');
      if (win) break;
      await delay(500);
    }
    if (!win) throw new Error('Save As dialog not found');

    await this.focusWindow(win.id);

    // Find the filename text field and set the value
    const fileNameBox = await this.findElement(win.id, 'File name:', 'edit');
    if (!fileNameBox) throw new Error('File name field not found in Save As dialog');

    await this.setText(fileNameBox.id, filename);

    // Click Save button
    const saveBtn = await this.findElement(win.id, 'Save', 'button');
    if (!saveBtn) throw new Error('Save button not found in Save As dialog');

    await this.clickElement(saveBtn.id);
  }

  /**
   * Handle an Open File dialog: wait for it, type the filename, click Open.
   */
  async handleOpenDialog(filename: string, timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let win: NativeWindow | null = null;

    while (Date.now() < deadline) {
      win = await this.findWindow('Open');
      if (!win) win = await this.findWindow('Open File');
      if (win) break;
      await delay(500);
    }
    if (!win) throw new Error('Open dialog not found');

    await this.focusWindow(win.id);

    const fileNameBox = await this.findElement(win.id, 'File name:', 'edit');
    if (!fileNameBox) throw new Error('File name field not found in Open dialog');

    await this.setText(fileNameBox.id, filename);

    const openBtn = await this.findElement(win.id, 'Open', 'button');
    if (!openBtn) throw new Error('Open button not found in dialog');

    await this.clickElement(openBtn.id);
  }

  /**
   * Dismiss any dialog by clicking a button by name (e.g. "Cancel", "OK", "Don't Save").
   */
  async clickDialogButton(titlePattern: string, buttonName: string, timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let win: NativeWindow | null = null;

    while (Date.now() < deadline) {
      win = await this.findWindow(titlePattern);
      if (win) break;
      await delay(500);
    }
    if (!win) throw new Error(`Dialog "${titlePattern}" not found`);

    await this.focusWindow(win.id);

    const btn = await this.findElement(win.id, buttonName, 'button');
    if (!btn) throw new Error(`Button "${buttonName}" not found in "${titlePattern}" dialog`);

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
   * Get the accessibility tree of the Dev Host window - useful for debugging
   * what elements are available to click/focus.
   */
  async getDevHostTree(): Promise<unknown> {
    const win = await this.findDevHostWindow();
    return this.getElementTree(win.id);
  }

  /** Find the Extension Development Host window. */
  private async findDevHostWindow(): Promise<NativeWindow> {
    let win = await this.findWindow('Extension Development Host');
    if (!win) {
      // Try partial match
      const windows = await this.listWindows();
      const devHost = (windows as NativeWindow[]).find(
        w => w.title.includes('Extension Development Host')
      );
      if (devHost) win = devHost;
    }
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

export interface NativeWindow {
  id: string;
  title: string;
  processId: number;
  bounds: { x: number; y: number; width: number; height: number };
  isVisible: boolean;
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
