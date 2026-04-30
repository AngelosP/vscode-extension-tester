import CDP from 'chrome-remote-interface';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AutomationDiagnostic, AutomationDiagnosticEntry, QuickInputSelectResult, QuickInputState, QuickInputTextResult } from '../types.js';

/**
 * A JS function string that finds an element by CSS selector, piercing open
 * shadow DOM boundaries.  Tries `document.querySelector` first (fast path for
 * light-DOM elements).  On miss, recursively walks every open `shadowRoot` and
 * queries inside each one.
 *
 * Used as `(${DEEP_QS})('selector')` inside `Runtime.evaluate` expressions so
 * it is fully self-contained (no globals, no side-effects).
 *
 * Limitation: closed shadow roots (`mode: 'closed'`) are invisible — there is
 * no programmatic access to them.
 */
export const DEEP_QS = `function(sel) {
  var r = document.querySelector(sel);
  if (r) return r;
  function walk(root) {
    var els = root.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var sr = els[i].shadowRoot;
      if (sr) {
        var found = sr.querySelector(sel);
        if (found) return found;
        found = walk(sr);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(document);
}`;

const WORKBENCH_QUICK_INPUT_HELPERS = `
function isVisible(el) {
  if (!el) return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
function clean(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}
function stripThemeIcons(text) {
  return clean(text).replace(/\$\([^)]+\)\s*/g, '').trim();
}
function widget() {
  const widgets = Array.from(document.querySelectorAll('.quick-input-widget'));
  return widgets.find(isVisible) || null;
}
function inputFor(root) {
  return root.querySelector('.quick-input-box input, .quick-input-header input, input');
}
function readRow(row, index) {
  const labelEl = row.querySelector('.quick-input-list-label .label-name, .monaco-icon-label .label-name, .label-name, .monaco-highlighted-label');
  const descriptionEl = row.querySelector('.quick-input-list-label .label-description, .monaco-icon-label .label-description, .label-description');
  const detailEl = row.querySelector('.quick-input-list-label .label-detail, .monaco-icon-label .label-detail, .label-detail, .quick-input-list-entry-detail');
  const aria = clean(row.getAttribute('aria-label'));
  const rowText = clean(row.textContent);
  const label = clean(labelEl && labelEl.textContent) || aria || rowText;
  const description = clean(descriptionEl && descriptionEl.textContent) || undefined;
  const detail = clean(detailEl && detailEl.textContent) || undefined;
  const rawId = row.getAttribute('data-index') || row.getAttribute('aria-posinset') || String(index);
  const info = {
    id: 'workbench-item-' + rawId,
    label,
    matchLabel: stripThemeIcons(label),
    description,
    detail,
    kind: row.classList.contains('quick-input-list-separator') || row.getAttribute('role') === 'separator' ? 'separator' : 'item',
    picked: row.classList.contains('selected') || row.getAttribute('aria-selected') === 'true' || row.getAttribute('aria-checked') === 'true',
    buttons: Array.from(row.querySelectorAll('.quick-input-list-entry-action-bar .action-label, .monaco-action-bar .action-label'))
      .map((button) => clean(button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent))
      .filter(Boolean),
  };
  return { row, info };
}
function readRows(root) {
  return Array.from(root.querySelectorAll('.quick-input-list .monaco-list-row'))
    .filter(isVisible)
    .map(readRow);
}
function normalize(text) {
  return stripThemeIcons(text).toLowerCase();
}
function matches(item, target) {
  const needle = normalize(target);
  return item.info.id === target || normalize(item.info.label) === needle || normalize(item.info.matchLabel) === needle;
}
function fuzzyMatches(item, target) {
  const needle = normalize(target);
  return item.info.id === target || normalize(item.info.label).includes(needle) || normalize(item.info.matchLabel).includes(needle);
}
`;

const WORKBENCH_QUICK_INPUT_STATE = `function() {
  ${WORKBENCH_QUICK_INPUT_HELPERS}
  const root = widget();
  if (!root) return { active: false };
  const input = inputFor(root);
  const title = clean((root.querySelector('.quick-input-titlebar .quick-input-title, .quick-input-title') || {}).textContent);
  const placeholder = input ? clean(input.getAttribute('placeholder') || input.getAttribute('aria-label')) : undefined;
  const rows = readRows(root);
  const activeItems = rows.filter((item) => item.row.classList.contains('focused') || item.row.classList.contains('active') || item.row.getAttribute('aria-selected') === 'true');
  const selectedItems = rows.filter((item) => item.info.picked);
  return {
    active: true,
    kind: rows.length > 0 ? 'quickPick' : 'inputBox',
    source: 'workbench',
    title: title || placeholder || undefined,
    placeholder,
    value: input ? input.value : undefined,
    enabled: input ? !input.disabled : undefined,
    items: rows.map((item) => item.info),
    activeItems: activeItems.map((item) => item.info),
    selectedItems: selectedItems.map((item) => item.info),
    updatedAt: Date.now(),
  };
}`;

const WORKBENCH_QUICK_INPUT_ITEM_POINT = `function(target) {
  ${WORKBENCH_QUICK_INPUT_HELPERS}
  const root = widget();
  if (!root) return { error: 'No visible workbench QuickInput widget found' };
  const rows = readRows(root).filter((item) => item.info.kind !== 'separator');
  const exact = rows.filter((item) => matches(item, target));
  const candidates = exact.length > 0 ? exact : rows.filter((item) => fuzzyMatches(item, target));
  if (candidates.length === 0) {
    return { error: 'Workbench QuickInput item "' + target + '" not found. Available items: ' + rows.map((item) => item.info.label + ' (' + item.info.id + ')').join(', ') };
  }
  if (candidates.length > 1) {
    return { error: 'Workbench QuickInput item "' + target + '" matched multiple items. Use an item id: ' + candidates.map((item) => item.info.label + ' (' + item.info.id + ')').join(', ') };
  }
  const hit = candidates[0];
  hit.row.scrollIntoView({ block: 'center', inline: 'nearest' });
  const rect = hit.row.getBoundingClientRect();
  return { label: hit.info.label, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}`;

const WORKBENCH_QUICK_INPUT_FOCUS_INPUT = `function() {
  ${WORKBENCH_QUICK_INPUT_HELPERS}
  const root = widget();
  if (!root) return { error: 'No visible workbench QuickInput widget found' };
  const input = inputFor(root);
  if (!input || !isVisible(input)) return { error: 'No visible workbench QuickInput input found' };
  input.focus();
  return { focused: document.activeElement === input || root.contains(document.activeElement) };
}`;

export type CdpMouseButton = 'left' | 'right' | 'middle';

export interface CdpClickOptions {
  button?: CdpMouseButton;
  clickCount?: number;
}

export interface CdpEvaluationOptions {
  timeoutMs?: number;
}

interface WebviewClientOptions {
  operationTimeoutMs?: number;
  retries?: number;
  retryOperationTimeouts?: boolean;
}

interface WebviewTryOptions extends CdpEvaluationOptions {
  strategy?: string;
  diagnostics?: AutomationDiagnosticEntry[];
  client?: WebviewClientOptions;
}

const CDP_PROTOCOL_TIMEOUT_MS = 5_000;

/**
 * Chrome DevTools Protocol client for sending real input events to VS Code.
 * Works with any focused element - regular editors, webview Monaco, dialogs, etc.
 *
 * For webview interactions, discovers webview targets via CDP Target API
 * since VS Code webviews are cross-origin iframes that can't be accessed
 * from the main renderer's DOM.
 */
export class CdpClient {
  private client?: CDP.Client;
  /**
   * Optional callback to activate a VS Code tab by title before probing.
   * Injected by the test runner so the CDP client can ask the controller
   * extension to bring a tab to the foreground.
   */
  onActivateTab?: (title: string) => Promise<void>;

  constructor(private readonly port: number) {}

  async connect(): Promise<void> {
    try {
      this.client = await this.withProtocolTimeout(CDP({ port: this.port }), 'CDP connect');
      await this.withProtocolTimeout(this.client.Runtime.enable(), 'CDP Runtime.enable');
    } catch (err) {
      this.disconnect();
      throw err;
    }
  }

  disconnect(): void {
    this.client?.close();
    this.client = undefined;
  }

  get isConnected(): boolean {
    return this.client !== undefined;
  }

  /**
   * Type text character-by-character into whatever is focused.
   * Uses CDP Input.dispatchKeyEvent which works in webviews, Monaco, etc.
   */
  async typeText(text: string): Promise<void> {
    if (!this.client) throw new Error('CDP not connected');

    for (const char of text) {
      await this.withProtocolTimeout(this.client.Input.dispatchKeyEvent({
        type: 'keyDown',
        text: char,
        key: char,
        unmodifiedText: char,
      }), 'CDP Input.dispatchKeyEvent keyDown');
      await this.withProtocolTimeout(this.client.Input.dispatchKeyEvent({
        type: 'keyUp',
        key: char,
      }), 'CDP Input.dispatchKeyEvent keyUp');
      await delay(20);
    }
  }

  /**
   * Insert text at the current cursor position in whatever element is focused.
   * Uses CDP Input.insertText — more reliable than typeText for native <input>
   * elements (e.g. VS Code's QuickInput InputBox) because it bypasses key
   * event handling and directly inserts the text.
   */
  async insertText(text: string): Promise<void> {
    if (!this.client) throw new Error('CDP not connected');
    await this.withProtocolTimeout((this.client as any).Input.insertText({ text }), 'CDP Input.insertText');
  }

  /**
   * Press a key or key combination (e.g. "Enter", "Escape", "Ctrl+S", "Shift+Tab").
   */
  async pressKey(keySpec: string): Promise<void> {
    if (!this.client) throw new Error('CDP not connected');

    const { key, code, keyCode, modifiers } = parseKeySpec(keySpec);

    await this.withProtocolTimeout(this.client.Input.dispatchKeyEvent({
      type: 'keyDown',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    }), 'CDP Input.dispatchKeyEvent keyDown');
    await this.withProtocolTimeout(this.client.Input.dispatchKeyEvent({
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    }), 'CDP Input.dispatchKeyEvent keyUp');
  }

  /** Move the mouse within the active CDP target viewport. */
  async moveMouse(x: number, y: number): Promise<void> {
    if (!this.client) throw new Error('CDP not connected');
    await this.withProtocolTimeout(this.client.Input.dispatchMouseEvent({
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
    } as any), 'CDP Input.dispatchMouseEvent mouseMoved');
  }

  /** Click at active CDP target viewport coordinates. */
  async clickAt(x: number, y: number, options: CdpClickOptions = {}): Promise<void> {
    if (!this.client) throw new Error('CDP not connected');
    await this.dispatchClick(this.client, x, y, options);
  }

  /**
   * Click an element by CSS selector.
   * Searches the main VS Code window first, then all webview targets.
   * For webview elements, uses JS focus/click rather than mouse coordinates
   * since webview iframes are in separate processes.
   */
  async clickSelector(selector: string): Promise<void> {
    if (!this.client) throw new Error('CDP not connected');

    const safeSelector = escapeSelector(selector);

    // 1. Try main document
    const mainResult = await this.withProtocolTimeout(this.client.Runtime.evaluate({
      expression: `(() => {
        const el = document.querySelector('${safeSelector}');
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        if (typeof el.focus === 'function') el.focus();
        const rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`,
      returnByValue: true,
    }), 'CDP Runtime.evaluate clickSelector');
    const point = mainResult.result.value as { x: number; y: number } | undefined;
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      await this.clickAt(point.x, point.y);
      return;
    }

    // 2. Search webview targets
    const clicked = await this.clickInWebview(safeSelector);
    if (clicked) return;

    throw new Error(`Element not found: ${selector}`);
  }

  /**
   * Focus an element by CSS selector. Searches main document and webview targets.
   * After focusing, subsequent type/press steps will target this element.
   */
  async focusSelector(selector: string): Promise<void> {
    if (!this.client) throw new Error('CDP not connected');

    const safeSelector = escapeSelector(selector);

    // 1. Try main document
    const mainResult = await this.withProtocolTimeout(this.client.Runtime.evaluate({
      expression: `(() => {
        const el = document.querySelector('${safeSelector}');
        if (!el) return null;
        el.focus();
        return true;
      })()`,
      returnByValue: true,
    }), 'CDP Runtime.evaluate focusSelector');
    if (mainResult.result.value) return;

    // 2. Search webview targets
    const focused = await this.focusInWebview(safeSelector);
    if (focused) return;

    throw new Error(`Element not found for focus: ${selector}`);
  }

  /**
   * List items visible in VS Code's popup overlay menus (context menus,
   * QuickPick lists, dropdown menus). Searches the main document for
   * `.monaco-list-row`, `.context-view .action-label`, and
   * `.quick-input-list .monaco-list-row` elements.
   */
  async getPopupMenuItems(): Promise<string[]> {
    if (!this.client) throw new Error('CDP not connected');

    const result = await this.withProtocolTimeout(this.client.Runtime.evaluate({
      expression: `(() => {
        const items = new Set();

        // Context menus / dropdown menus
        document.querySelectorAll('.context-view .action-label').forEach(el => {
          const text = (el.textContent || '').trim();
          if (text && !el.closest('[aria-disabled="true"]')) items.add(text);
        });

        // QuickPick / QuickInput list rows
        document.querySelectorAll('.quick-input-list .monaco-list-row').forEach(el => {
          const label = el.querySelector('.label-name, .label-description, .quick-input-list-entry .label-name');
          const text = (label || el).textContent?.trim();
          if (text) items.add(text);
        });

        // Generic monaco list rows (e.g. editor picker)
        document.querySelectorAll('.monaco-list:not(.quick-input-list) .monaco-list-row').forEach(el => {
          const text = (el.textContent || '').trim();
          if (text) items.add(text);
        });

        return [...items];
      })()`,
      returnByValue: true,
    }), 'CDP Runtime.evaluate popup menu items');

    return (result.result.value as string[]) ?? [];
  }

  /** Inspect the visible workbench QuickInput widget from the renderer DOM. */
  async getWorkbenchQuickInputState(): Promise<QuickInputState> {
    if (!this.client) throw new Error('CDP not connected');

    const result = await this.withProtocolTimeout(this.client.Runtime.evaluate({
      expression: `(${WORKBENCH_QUICK_INPUT_STATE})()`,
      returnByValue: true,
    }), 'CDP Runtime.evaluate QuickInput state');

    return (result.result.value as QuickInputState | undefined) ?? { active: false };
  }

  /** Select a visible workbench QuickInput item by label or generated item id. */
  async selectWorkbenchQuickInputItem(labelOrId: string): Promise<QuickInputSelectResult> {
    if (!this.client) throw new Error('CDP not connected');

    const safeTarget = JSON.stringify(labelOrId);
    const result = await this.withProtocolTimeout(this.client.Runtime.evaluate({
      expression: `(${WORKBENCH_QUICK_INPUT_ITEM_POINT})(${safeTarget})`,
      returnByValue: true,
    }), 'CDP Runtime.evaluate QuickInput item point');
    const value = result.result.value as { label: string; x: number; y: number; error?: string } | undefined;
    if (!value || value.error) {
      throw new Error(value?.error ?? `Workbench QuickInput item "${labelOrId}" not found`);
    }

    await this.clickAt(value.x, value.y);
    return { selected: value.label, intercepted: false };
  }

  /** Focus the visible workbench QuickInput input, replace its value, and accept. */
  async submitWorkbenchQuickInputText(value: string): Promise<QuickInputTextResult> {
    if (!this.client) throw new Error('CDP not connected');

    const focusResult = await this.withProtocolTimeout(this.client.Runtime.evaluate({
      expression: `(${WORKBENCH_QUICK_INPUT_FOCUS_INPUT})()`,
      returnByValue: true,
    }), 'CDP Runtime.evaluate QuickInput focus');
    const focused = focusResult.result.value as { focused?: boolean; error?: string } | undefined;
    if (!focused?.focused) {
      throw new Error(focused?.error ?? 'No visible workbench QuickInput input found');
    }

    await this.pressKey('Ctrl+A');
    await this.insertText(value);
    await delay(100);
    await this.pressKey('Enter');
    return { entered: value, intercepted: false, accepted: true };
  }

  /**
   * Click an item in VS Code's popup overlay menu by matching its text.
   * Searches context menus, QuickPick lists, dropdown menus, and generic
   * monaco-list rows. Uses partial, case-insensitive matching.
   */
  async selectPopupMenuItem(itemText: string): Promise<void> {
    if (!this.client) throw new Error('CDP not connected');

    const safeText = itemText.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    const result = await this.withProtocolTimeout(this.client.Runtime.evaluate({
      expression: `(() => {
        const needle = '${safeText}'.toLowerCase();

        // Helper: try to find and click in a set of elements
        function tryClick(selector) {
          const els = document.querySelectorAll(selector);
          for (const el of els) {
            const text = (el.textContent || '').trim();
            if (text.toLowerCase().includes(needle)) {
              el.scrollIntoView({ block: 'center' });
              el.click();
              return text;
            }
          }
          return null;
        }

        // 1. Context menus / dropdown menus
        let hit = tryClick('.context-view .action-label');
        if (hit) return hit;

        // 2. Context-view list items (broader)
        hit = tryClick('.context-view .monaco-list-row');
        if (hit) return hit;

        // 3. QuickPick list rows
        hit = tryClick('.quick-input-list .monaco-list-row');
        if (hit) return hit;

        // 4. Generic monaco list rows
        hit = tryClick('.monaco-list .monaco-list-row');
        if (hit) return hit;

        return null;
      })()`,
      returnByValue: true,
    }), 'CDP Runtime.evaluate popup menu select');

    if (!result.result.value) {
      throw new Error(
        `Popup menu item "${itemText}" not found in DOM. ` +
        `Use getPopupMenuItems() to see available items.`
      );
    }
  }

  /**
   * Evaluate JavaScript in the page context. Returns the result.
   */
  async evaluate(expression: string, options: CdpEvaluationOptions = {}): Promise<unknown> {
    if (!this.client) throw new Error('CDP not connected');

    const result = await this.withProtocolTimeout(this.client.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true,
    }), 'CDP Runtime.evaluate', options.timeoutMs);
    if (result.exceptionDetails) {
      throw new Error(`JS eval failed: ${result.exceptionDetails.text}`);
    }
    return result.result.value;
  }

  // ─── Output channel reading (via VS Code renderer internals) ────────────

  /**
   * Discover all output channels registered in VS Code by evaluating JS in
   * the renderer process.  Tries multiple strategies because VS Code internals
   * vary across versions.
   *
   * Strategy 1: Access the OutputChannelRegistry via VS Code's AMD loader
   * Strategy 2: Scan the logs directory for output_logging_* files
   * Strategy 3: Scan Monaco models for `output:` scheme URIs
   */
  async getOutputChannelDescriptors(): Promise<Array<{
    id: string;
    label: string;
    extensionId?: string;
    file?: string;
  }>> {
    if (!this.client) throw new Error('CDP not connected');

    // Strategy 1: Try VS Code's internal output service via AMD require
    try {
      const result = await this.evaluate(`
        (async () => {
          // Try AMD require for internal modules
          const r = typeof require === 'function' ? require : undefined;
          if (!r) return null;

          try {
            // VS Code >= 1.80: IOutputChannelModelService
            const output = r('vs/workbench/services/output/common/output');
            if (output && output.Extensions && output.Extensions.OutputChannels) {
              const registry = r('vs/platform/registry/common/platform').Registry;
              const channelRegistry = registry.as(output.Extensions.OutputChannels);
              if (channelRegistry && typeof channelRegistry.getChannels === 'function') {
                const channels = channelRegistry.getChannels();
                return channels.map(c => ({
                  id: c.id || '',
                  label: c.label || '',
                  extensionId: (c.extensionId && c.extensionId.value) || c.extensionId || null,
                  file: (c.file && c.file.fsPath) || (c.log && c.log.fsPath) || null,
                }));
              }
            }
          } catch (e) { /* Strategy 1 sub-attempt failed */ }

          return null;
        })()
      `);
      if (Array.isArray(result) && result.length > 0) {
        return result;
      }
    } catch { /* Strategy 1 failed entirely */ }

    // Strategy 2: Find the VS Code logs directory and scan for output log files
    try {
      const logsDir = await this.evaluate(`
        (() => {
          // Try multiple ways to discover the logs path
          try {
            const r = typeof require === 'function' ? require : undefined;
            if (r) {
              try {
                const env = r('vs/workbench/services/environment/browser/environmentService');
                return env?.logsPath || null;
              } catch {}
              try {
                const env = r('vs/platform/environment/common/environment');
                return env?.logsPath || null;
              } catch {}
            }
          } catch {}

          // Check process environment (VS Code sets VSCODE_LOGS in some versions)
          if (typeof process !== 'undefined' && process.env && process.env.VSCODE_LOGS) {
            return process.env.VSCODE_LOGS;
          }

          return null;
        })()
      `) as string | null;

      if (logsDir && typeof logsDir === 'string') {
        const descriptors = this.scanLogsDirectory(logsDir);
        if (descriptors.length > 0) return descriptors;
      }
    } catch { /* Strategy 2 failed */ }

    // Strategy 3: Use the user-data-dir to find logs (most reliable fallback)
    try {
      const userDataDir = await this.evaluate(`
        (() => {
          // VS Code exposes the user data dir via process.env in renderer
          if (typeof process !== 'undefined' && process.env) {
            return process.env.VSCODE_PORTABLE ||
                   process.env.VSCODE_APPDATA ||
                   null;
          }
          return null;
        })()
      `) as string | null;

      // Also try to get it from the window title or workbench state
      if (!userDataDir) {
        // As a last resort, look for --user-data-dir in process.argv
        const argv = await this.evaluate(`
          (() => {
            if (typeof process !== 'undefined' && process.argv) {
              const arg = process.argv.find(a => a.startsWith('--user-data-dir='));
              return arg ? arg.split('=')[1] : null;
            }
            return null;
          })()
        `) as string | null;

        if (argv) {
          const logsPath = path.join(argv, 'logs');
          const descriptors = this.scanLogsDirectory(logsPath);
          if (descriptors.length > 0) return descriptors;
        }
      }
    } catch { /* Strategy 3 failed */ }

    return [];
  }

  /**
   * Read a specific output channel's content by name.
   * Tries CDP-discovered backing files first, then falls back.
   */
  async readOutputChannelContent(name: string): Promise<string | undefined> {
    const descriptors = await this.getOutputChannelDescriptors();
    const lower = name.toLowerCase();

    // Find by label match
    const match = descriptors.find(d => d.label.toLowerCase() === lower);
    if (match?.file && fs.existsSync(match.file)) {
      try {
        return fs.readFileSync(match.file, 'utf-8');
      } catch { /* file read failed */ }
    }

    // Try fuzzy match on all descriptors with files
    for (const d of descriptors) {
      if (!d.file || !fs.existsSync(d.file)) continue;
      if (d.label.toLowerCase().includes(lower) || d.id.toLowerCase().includes(lower)) {
        try {
          return fs.readFileSync(d.file, 'utf-8');
        } catch { /* continue */ }
      }
    }

    return undefined;
  }

  /**
   * Scan a VS Code logs directory for output channel log files.
   * Output log files live in subdirectories like `output_logging_<timestamp>/`.
   * Each file is named `<N>-<ChannelName>.log`.
   */
  private scanLogsDirectory(logsDir: string): Array<{
    id: string;
    label: string;
    file: string;
  }> {
    const results: Array<{ id: string; label: string; file: string }> = [];
    if (!fs.existsSync(logsDir)) return results;

    try {
      // Look for output_logging_* subdirectories (most recent first)
      const entries = fs.readdirSync(logsDir, { withFileTypes: true });
      const outputDirs = entries
        .filter(e => e.isDirectory() && e.name.startsWith('output_logging_'))
        .map(e => e.name)
        .sort()
        .reverse();

      // Use the most recent output_logging directory
      const targetDir = outputDirs[0];
      if (!targetDir) return results;

      const outputLogsPath = path.join(logsDir, targetDir);
      const logFiles = fs.readdirSync(outputLogsPath)
        .filter(f => f.endsWith('.log'));

      for (const file of logFiles) {
        // Parse filename: "<N>-<ChannelName>.log"
        const match = file.match(/^\d+-(.+)\.log$/);
        if (match) {
          results.push({
            id: file.replace('.log', ''),
            label: match[1],
            file: path.join(outputLogsPath, file),
          });
        }
      }
    } catch { /* directory scan failed */ }

    return results;
  }

  // ─── Webview-aware operations ──────────────────────────────────────────

  /**
   * Run a JS expression inside a webview. If `webviewTitle` is provided, only
   * targets whose title contains that substring (case-insensitive) are tried.
   * If omitted, every webview target is tried in turn until one returns a
   * non-null value.
   *
   * The expression is wrapped in `(() => { ... })()` and the return value is
   * marshalled back via `returnByValue`. If the expression throws, the error
   * propagates.
   */
  async evaluateInWebview(expression: string, webviewTitle?: string, options: CdpEvaluationOptions = {}): Promise<unknown> {
    const targets = await this.getWebviewTargets(webviewTitle, 5_000);
    if (targets.length === 0) {
      throw new Error(
        webviewTitle
          ? `No webview found matching title "${webviewTitle}". Open the webview first, or check the spelling.`
          : 'No webviews are currently open.',
      );
    }

    let lastError: Error | undefined;
    for (const target of targets) {
      try {
        const value = await this.withWebviewClient(target.id, async (wv) => {
          return await this.evaluateAcrossFrames(wv, expression, options);
        }, options.timeoutMs ? { operationTimeoutMs: options.timeoutMs, retries: 1, retryOperationTimeouts: false } : undefined);
        if (value !== null && value !== undefined) return value;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    if (lastError) throw lastError;
    return undefined;
  }

  /**
   * Click an element inside a webview by CSS selector. If `webviewTitle` is
   * provided, the search is restricted to webviews whose title matches.
   * Throws if the element is not found in any matching webview.
   */
  async clickInWebviewBySelector(
    selector: string,
    webviewTitle?: string,
    options: CdpClickOptions = {},
  ): Promise<void> {
    const safe = escapeSelector(selector);
    const diagnostics: AutomationDiagnosticEntry[] = [];
    const clientOptions = { retries: 1, retryOperationTimeouts: false };

    const found = await this.tryInWebviews(syntheticClickExpression(safe, options), webviewTitle, {
      strategy: 'synthetic-dom-events',
      diagnostics,
      client: clientOptions,
    });
    if (found) return;

    const clicked = await this.clickInWebviewWithMouse(safe, webviewTitle, options, diagnostics);
    if (clicked) return;

    throw diagnosticError(
      `Element not found in webview: ${selector}${formatDiagnosticSummary(diagnostics)}`,
      { kind: 'webview-click', subject: selector, entries: diagnostics },
    );
  }

  async clickInWebviewByAccessibleText(
    text: string,
    webviewTitle?: string,
    options: CdpClickOptions = {},
  ): Promise<void> {
    const targets = await this.getWebviewTargets(webviewTitle, 5_000);
    const diagnostics: AutomationDiagnosticEntry[] = [];
    const allCandidates: unknown[] = [];
    const markerPrefix = `vscode-ext-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    for (const target of targets) {
      try {
        const result = await this.withWebviewClient(target.id, async (wv) => {
          const contextIds = await this.discoverFrameContextIds(wv);
          const matches: Array<{ contextId: number; marker: string; name: string; tag: string; role?: string }> = [];
          for (const contextId of contextIds) {
            const discovered = await this.withProtocolTimeout(wv.Runtime.evaluate({
              expression: webviewTextCandidatesExpression(text, markerPrefix, contextId),
              returnByValue: true,
              awaitPromise: true,
              contextId,
            }), `CDP Runtime.evaluate text candidates context ${contextId}`);
            const value = discovered.result.value as { exact?: unknown[]; fuzzy?: unknown[]; candidates?: unknown[]; error?: string } | undefined;
            if (!value || discovered.exceptionDetails) continue;
            if (Array.isArray(value.candidates)) allCandidates.push(...value.candidates);
            if (Array.isArray(value.exact)) {
              for (const match of value.exact as Array<{ marker: string; name: string; tag: string; role?: string }>) {
                matches.push({ ...match, contextId });
              }
            }
          }
          if (matches.length === 0) return { clicked: false as const };
          if (matches.length > 1) {
            return { clicked: false as const, ambiguous: true, matches };
          }
          const match = matches[0];
          const click = await this.withProtocolTimeout(wv.Runtime.evaluate({
            expression: webviewTextClickExpression(match.marker, options),
            returnByValue: true,
            awaitPromise: true,
            contextId: match.contextId,
          }), `CDP Runtime.evaluate text click context ${match.contextId}`);
          return { clicked: click.result.value === true, match };
        }, { retries: 1, retryOperationTimeouts: false });

        if (result.clicked) return;
        if ('ambiguous' in result && result.ambiguous) {
          throw diagnosticError(
            `Webview text "${text}" matched multiple actionable elements: ${JSON.stringify(result.matches)}`,
            { kind: 'webview-click', subject: text, entries: diagnostics, candidates: result.matches },
          );
        }
      } catch (err) {
        if (hasDiagnostic(err)) throw err;
        diagnostics.push({
          phase: 'webview-text-click',
          targetId: target.id,
          targetTitle: target.title,
          strategy: 'accessible-text',
          message: errorMessage(err),
        });
      }
    }

    throw diagnosticError(
      `Webview element with text "${text}" not found${formatDiagnosticSummary(diagnostics)}`,
      { kind: 'webview-click', subject: text, entries: diagnostics, candidates: allCandidates.slice(0, 30) },
    );
  }

  /** Focus an element inside a webview by CSS selector. */
  async focusInWebviewBySelector(selector: string, webviewTitle?: string): Promise<void> {
    const safe = escapeSelector(selector);
    const expr = `(() => {
      const el = (${DEEP_QS})('${safe}');
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      if (typeof el.focus === 'function') el.focus();
      return true;
    })()`;
    const found = await this.tryInWebviews(expr, webviewTitle);
    if (!found) throw new Error(`Element not found in webview: ${selector}`);
  }

  /**
   * Scroll a specific scroll container inside a webview.
   *  - mode 'by': scroll relative to current position by (dx, dy)
   *  - mode 'to': set scrollLeft/scrollTop to absolute coords (dx, dy)
   *  - mode 'edge': dx/dy are 'top' | 'bottom' | 'left' | 'right'
   *  - mode 'into-view': scroll the element itself into view of its scroll parent
   */
  async scrollInWebview(
    selector: string,
    mode: 'by' | 'to' | 'edge' | 'into-view',
    arg1: number | string,
    arg2: number | string = 0,
    webviewTitle?: string,
  ): Promise<void> {
    const safe = escapeSelector(selector);
    let body = '';
    switch (mode) {
      case 'by':
        body = `el.scrollBy({ left: ${Number(arg1)}, top: ${Number(arg2)}, behavior: 'instant' });`;
        break;
      case 'to':
        body = `el.scrollTo({ left: ${Number(arg1)}, top: ${Number(arg2)}, behavior: 'instant' });`;
        break;
      case 'edge': {
        const edge = String(arg1).toLowerCase();
        if (edge === 'top') body = 'el.scrollTop = 0;';
        else if (edge === 'bottom') body = 'el.scrollTop = el.scrollHeight;';
        else if (edge === 'left') body = 'el.scrollLeft = 0;';
        else if (edge === 'right') body = 'el.scrollLeft = el.scrollWidth;';
        else throw new Error(`Unknown scroll edge: ${edge}`);
        break;
      }
      case 'into-view':
        body = `el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });`;
        break;
    }
    const expr = `(() => {
      const el = (${DEEP_QS})('${safe}');
      if (!el) return null;
      ${body}
      return true;
    })()`;
    const found = await this.tryInWebviews(expr, webviewTitle);
    if (!found) throw new Error(`Element not found in webview for scroll: ${selector}`);
  }

  /** Wait until a CSS selector exists in any matching webview, or throw on timeout. */
  async waitForSelectorInWebview(
    selector: string,
    timeoutMs: number,
    webviewTitle?: string,
  ): Promise<void> {
    const safe = escapeSelector(selector);
    const expr = `(() => (${DEEP_QS})('${safe}') ? true : null)()`;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = await this.tryInWebviews(expr, webviewTitle).catch(() => false);
      if (found) return;
      await delay(250);
    }
    throw new Error(`Selector "${selector}" did not appear in webview within ${timeoutMs}ms`);
  }

  /** Get the visible text of an element in a webview. */
  async getTextInWebview(selector: string, webviewTitle?: string): Promise<string> {
    const safe = escapeSelector(selector);
    const expr = `(() => {
      const el = (${DEEP_QS})('${safe}');
      if (!el) return null;
      return el.innerText || el.textContent || '';
    })()`;
    const value = await this.tryInWebviewsRaw(expr, webviewTitle);
    if (value === null || value === undefined) {
      throw new Error(`Element not found in webview: ${selector}`);
    }
    return String(value);
  }

  /** Check whether a selector exists in any matching webview. Never throws. */
  async elementExistsInWebview(selector: string, webviewTitle?: string): Promise<boolean> {
    const safe = escapeSelector(selector);
    const expr = `(() => (${DEEP_QS})('${safe}') ? true : null)()`;
    try {
      const v = await this.tryInWebviews(expr, webviewTitle);
      return v === true;
    } catch {
      return false;
    }
  }

  /** Return the full text content of all matching webviews, joined (including nested iframes). */
  async getWebviewBodyText(webviewTitle?: string): Promise<string> {
    const targets = await this.getWebviewTargets(webviewTitle, 5_000);
    if (targets.length === 0) {
      if (webviewTitle) {
        const all = await this.getWebviewTargets();
        const available = all.map((t) => `"${t.title || '(untitled)'}" (${t.url})`).join(', ') || 'none';
        throw new Error(
          `No webview found matching title "${webviewTitle}". Available webviews: ${available}. ` +
          'Note: the title is matched against the HTML <title> tag, not the VS Code panel title.',
        );
      }
      return '';
    }
    const parts: string[] = [];
    for (const target of targets) {
      try {
        const texts = await this.withWebviewClient(target.id, async (wv) => {
          return await this.collectFromAllFrames(
            wv,
            '(document.body && document.body.innerText) || ""',
          );
        });
        for (const t of texts) {
          const s = String(t);
          if (s) parts.push(s);
        }
      } catch { /* skip target */ }
    }
    return parts.join('\n');
  }

  /** List the open webviews - useful for debugging "which titles can I target?". */
  async listWebviews(): Promise<Array<{ title: string; url: string; probedTitle?: string }>> {
    const targets = await this.getWebviewTargets(undefined, 3_000);
    const results: Array<{ title: string; url: string; probedTitle?: string }> = [];
    for (const t of targets) {
      let probedTitle: string | undefined;
      try {
        probedTitle = await this.probeDocumentTitle(t.id) ?? undefined;
      } catch { /* skip */ }
      results.push({ title: t.title, url: t.url, probedTitle });
    }
    return results;
  }

  // ─── Frame-aware evaluation helpers ──────────────────────────────────────
  //
  // VS Code custom editor webviews use deeply nested cross-origin iframes:
  //   main renderer → vscode-webview:// outer → inner iframe(s) with content
  // CDP lists the outer webview as a target, but the inner iframes are frames
  // within that target - not separate targets. To interact with elements in the
  // inner frames, we must enumerate all execution contexts and try each one.
  //
  // In VS Code ≥ 1.88, webview content may instead be served from a separate
  // HTTPS origin and show up as its own CDP target (not a child frame). The
  // URL filter in getWebviewTargets handles that case, but when the content IS
  // a child frame, we still need robust frame-context discovery here.

  /**
   * Discover all execution context IDs within a connected CDP client.
   * Each frame (including cross-origin iframes) gets its own execution context.
   *
   * Strategy:
   * 1. Re-enable Runtime to trigger `executionContextCreated` for every existing
   *    context. Wait up to 150 ms for events.
   * 2. If only one context was found, use `Page.getFrameTree()` to check whether
   *    additional child frames exist. If so, wait an additional 300 ms for their
   *    context events (inner iframes in some VS Code versions take longer to
   *    report their execution contexts).
   */
  private async discoverFrameContextIds(client: CDP.Client): Promise<number[]> {
    const contextIds: number[] = [];
    const handler = (params: { context: { id: number } }) => {
      contextIds.push(params.context.id);
    };

    (client as any).on('Runtime.executionContextCreated', handler);
    try {
      try { await this.withProtocolTimeout(client.Runtime.disable(), 'CDP Runtime.disable'); } catch { /* may not be enabled yet */ }
      await this.withProtocolTimeout(client.Runtime.enable(), 'CDP Runtime.enable');
      // Allow context-created events to be delivered (they fire asynchronously)
      await delay(150);

      // If we found ≤ 1 context, the inner content frame may not have reported
      // yet.  Use Page.getFrameTree() to check for additional child frames.
      if (contextIds.length <= 1) {
        const expectedFrames = await countTargetFrames(client);
        if (expectedFrames > contextIds.length) {
          // More frames exist than contexts — wait longer for late-arriving events
          await delay(300);
        }
      }
    } finally {
      (client as any).removeListener('Runtime.executionContextCreated', handler);
    }

    return contextIds;
  }

  /**
   * Evaluate an expression across ALL execution contexts (frames) in a CDP client.
   * Returns the first non-null/non-undefined result, or null if none matched.
   */
  private async evaluateAcrossFrames(
    client: CDP.Client,
    expression: string,
    options: CdpEvaluationOptions = {},
  ): Promise<unknown> {
    const contextIds = await this.discoverFrameContextIds(client);

    for (const contextId of contextIds) {
      try {
        const r = await this.withProtocolTimeout(client.Runtime.evaluate({
          expression,
          returnByValue: true,
          awaitPromise: true,
          contextId,
        }), `CDP Runtime.evaluate context ${contextId}`, options.timeoutMs);
        if (!r.exceptionDetails && r.result.value !== null && r.result.value !== undefined) {
          return r.result.value;
        }
      } catch {
        // Context may have been destroyed (navigation, GC), skip
      }
    }
    return null;
  }

  /**
   * Evaluate an expression in ALL execution contexts and return every non-null result.
   * Used for collecting content from all frames (e.g. body text).
   */
  private async collectFromAllFrames(
    client: CDP.Client,
    expression: string,
    options: CdpEvaluationOptions = {},
  ): Promise<unknown[]> {
    const contextIds = await this.discoverFrameContextIds(client);
    const results: unknown[] = [];

    for (const contextId of contextIds) {
      try {
        const r = await this.withProtocolTimeout(client.Runtime.evaluate({
          expression,
          returnByValue: true,
          awaitPromise: true,
          contextId,
        }), `CDP Runtime.evaluate context ${contextId}`, options.timeoutMs);
        if (!r.exceptionDetails && r.result.value !== null && r.result.value !== undefined) {
          results.push(r.result.value);
        }
      } catch { /* skip destroyed context */ }
    }
    return results;
  }

  // ─── Webview target helpers ─────────────────────────────────────────────

  /**
   * Run an expression inside webviews until one returns a truthy value.
   * Traverses all frames (including nested iframes) within each webview target.
   * Returns true if any target/frame succeeded, false if none matched.
   */
  private async tryInWebviews(expression: string, webviewTitle?: string, options: WebviewTryOptions = {}): Promise<boolean> {
    const targets = await this.getWebviewTargets(webviewTitle);
    for (const target of targets) {
      try {
        const value = await this.withWebviewClient(target.id, async (wv) => {
          return await this.evaluateAcrossFrames(wv, expression, options);
        }, options.client);
        if (value === true) return true;
      } catch (err) {
        options.diagnostics?.push({
          phase: 'webview-operation',
          targetId: target.id,
          targetTitle: target.title,
          strategy: options.strategy,
          message: errorMessage(err),
        });
      }
    }
    return false;
  }

  /**
   * Like tryInWebviews but returns the raw value of the first non-null result.
   * Traverses all frames within each webview target.
   */
  private async tryInWebviewsRaw(expression: string, webviewTitle?: string, options: WebviewTryOptions = {}): Promise<unknown> {
    const targets = await this.getWebviewTargets(webviewTitle);
    for (const target of targets) {
      try {
        const value = await this.withWebviewClient(target.id, async (wv) => {
          return await this.evaluateAcrossFrames(wv, expression, options);
        }, options.client);
        if (value !== null && value !== undefined) return value;
      } catch { /* try next */ }
    }
    return null;
  }

  /**
   * List all CDP targets and return those that look like VS Code webviews.
   * If `titleFilter` is provided, only targets whose title contains the
   * substring (case-insensitive) are returned.
   *
   * Matching strategy (tried in order):
   * 1. **CDP title/URL** – fast, no extra connections required.
   * 2. **DOM probe** – connects to each webview target and checks
   *    `document.title` across all frames (handles VS Code panels whose
   *    CDP target title doesn't match the tab label).
   *
   * If `waitMs` is provided and no targets are found on the first attempt,
   * polls every 250ms until targets appear or the timeout expires.
   */
  private async getWebviewTargets(
    titleFilter?: string,
    waitMs?: number,
  ): Promise<Array<{ id: string; url: string; title: string }>> {
    const deadline = waitMs ? Date.now() + waitMs : 0;

    while (true) {
      let targets: Array<{ type: string; url: string; id: string; title: string }>;
      try {
        targets = await this.withProtocolTimeout(CDP.List({ port: this.port }) as Promise<any>, 'CDP target list') as any;
      } catch {
        // CDP.List() can ECONNREFUSED if called during VS Code startup
        if (!waitMs || Date.now() >= deadline) return [];
        await delay(250);
        continue;
      }
      const webviews = targets.filter(
        (t: { type: string; url: string }) =>
          (t.type === 'page' || t.type === 'iframe') &&
          isWebviewUrl(t.url)
      );

      let matched: Array<{ id: string; url: string; title: string }>;
      if (!titleFilter) {
        matched = webviews as Array<{ id: string; url: string; title: string }>;
      } else {
        const needle = titleFilter.toLowerCase();
        // Fast path: match by CDP target title or URL
        matched = (webviews as Array<{ id: string; url: string; title: string }>).filter(
          (t) => (t.title ?? '').toLowerCase().includes(needle) || t.url.toLowerCase().includes(needle),
        );

        // Slow path: probe document.title inside each webview's frames
        if (matched.length === 0) {
          // Ask the controller extension to activate the tab first (if callback set).
          // This ensures the target webview is in the foreground so its DOM is live.
          if (this.onActivateTab) {
            try { await this.onActivateTab(titleFilter); } catch { /* best effort */ }
            await delay(200); // give VS Code a moment to bring the tab to front
          }
          matched = await this.probeWebviewsByTitle(
            webviews as Array<{ id: string; url: string; title: string }>,
            needle,
          );
        }
      }

      if (matched.length > 0 || !waitMs || Date.now() >= deadline) return matched;
      await delay(250);
    }
  }

  /**
   * Probe each webview target by evaluating `document.title` across all frames.
   * Returns targets where any frame's document.title contains `needle`.
   */
  private async probeWebviewsByTitle(
    webviews: Array<{ id: string; url: string; title: string }>,
    needle: string,
  ): Promise<Array<{ id: string; url: string; title: string }>> {
    const matched: Array<{ id: string; url: string; title: string }> = [];
    for (const wv of webviews) {
      try {
        const docTitle = await this.probeDocumentTitle(wv.id);
        if (docTitle && docTitle.toLowerCase().includes(needle)) {
          // Replace the CDP title with the probed title so downstream code sees the real name
          matched.push({ ...wv, title: docTitle });
        }
      } catch {
        // Target may not be connectable yet — skip
      }
    }
    return matched;
  }

  /**
   * Connect to a single webview target and return the first non-empty
   * `document.title` found across all frames, or `null`.
   */
  private async probeDocumentTitle(targetId: string): Promise<string | null> {
    return this.withWebviewClient(targetId, async (client) => {
      const titles = await this.collectFromAllFrames(client, 'document.title || null');
      for (const t of titles) {
        const s = typeof t === 'string' ? t.trim() : '';
        if (s) return s;
      }
      return null;
    });
  }


  /**
   * Connect to a webview target, run a callback, then disconnect.
   * Retries up to 3 times on connection failures (ECONNREFUSED) because
   * webview targets can appear in the CDP target list before their debug
   * server is fully ready.
   */
  private async withWebviewClient<T>(
    targetId: string,
    fn: (client: CDP.Client) => Promise<T>,
    options: WebviewClientOptions = {},
  ): Promise<T> {
    let lastError: Error | undefined;
    const retries = options.retries ?? 3;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const wvClient = await this.withProtocolTimeout(
          CDP({ port: this.port, target: targetId }),
          `CDP attach to webview target ${targetId}`,
        );
        try {
          await this.withProtocolTimeout(wvClient.Runtime.enable(), `CDP Runtime.enable for webview target ${targetId}`);
          return await this.withProtocolTimeout(
            fn(wvClient),
            `CDP webview operation for target ${targetId}`,
            options.operationTimeoutMs,
          );
        } finally {
          try { wvClient.close(); } catch { /* best effort */ }
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (isTimeoutError(lastError) && options.retryOperationTimeouts === false) break;
        if (attempt < retries - 1) await delay(500);
      }
    }
    throw lastError!;
  }

  /**
   * Try to click an element in any webview target. Returns true if found.
   */
  private async clickInWebview(safeSelector: string): Promise<boolean> {
    const clicked = await this.clickInWebviewWithMouse(safeSelector, undefined, {});
    if (clicked) return true;
    return this.tryInWebviews(syntheticClickExpression(safeSelector, {}));
  }

  private async clickInWebviewWithMouse(
    safeSelector: string,
    webviewTitle: string | undefined,
    options: CdpClickOptions,
    diagnostics: AutomationDiagnosticEntry[] = [],
  ): Promise<boolean> {
    const targets = await this.getWebviewTargets(webviewTitle, 5_000);
    for (const target of targets) {
      try {
        const clicked = await this.withWebviewClient(target.id, async (wv) => {
          const contextIds = await this.discoverFrameContextIds(wv);
          diagnostics.push({
            phase: 'webview-click',
            targetId: target.id,
            targetTitle: target.title,
            strategy: 'mouse-dispatch',
            message: `Discovered ${contextIds.length} execution context(s)`,
          });
          for (const contextId of contextIds) {
            const result = await this.withProtocolTimeout(wv.Runtime.evaluate({
              expression: elementPointExpression(safeSelector),
              returnByValue: true,
              awaitPromise: true,
              contextId,
            }), `CDP Runtime.evaluate element point context ${contextId}`);
            const point = result.result.value as { x: number; y: number; unreliable?: boolean } | undefined;
            if (!point || point.unreliable || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
              diagnostics.push({
                phase: 'webview-click',
                targetId: target.id,
                targetTitle: target.title,
                contextId,
                strategy: 'mouse-dispatch',
                message: point?.unreliable ? 'Element point crosses an inaccessible frame boundary' : 'Element point not available',
              });
              continue;
            }
            await this.dispatchClick(wv, point.x, point.y, options);
            return true;
          }
          return false;
        }, { retries: 1, retryOperationTimeouts: false });
        if (clicked) return true;
      } catch (err) {
        diagnostics.push({
          phase: 'webview-click',
          targetId: target.id,
          targetTitle: target.title,
          strategy: 'mouse-dispatch',
          message: errorMessage(err),
        });
      }
    }
    return false;
  }

  private async dispatchClick(
    client: CDP.Client,
    x: number,
    y: number,
    options: CdpClickOptions,
  ): Promise<void> {
    const button = options.button ?? 'left';
    const clickCount = options.clickCount ?? 1;
    const buttons = buttonMask(button);

    await this.withProtocolTimeout(client.Input.dispatchMouseEvent({
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
    } as any), 'CDP Input.dispatchMouseEvent mouseMoved');

    for (let count = 1; count <= clickCount; count++) {
      await this.withProtocolTimeout(client.Input.dispatchMouseEvent({
        type: 'mousePressed',
        x,
        y,
        button,
        buttons,
        clickCount: count,
      } as any), 'CDP Input.dispatchMouseEvent mousePressed');
      await this.withProtocolTimeout(client.Input.dispatchMouseEvent({
        type: 'mouseReleased',
        x,
        y,
        button,
        buttons: 0,
        clickCount: count,
      } as any), 'CDP Input.dispatchMouseEvent mouseReleased');
    }
  }

  private withProtocolTimeout<T>(
    operation: Promise<T>,
    description: string,
    timeoutMs = CDP_PROTOCOL_TIMEOUT_MS,
  ): Promise<T> {
    return withTimeout(operation, timeoutMs, `${description} timed out after ${timeoutMs}ms`);
  }

  /**
   * Try to focus an element in any webview target. Returns true if found.
   */
  private async focusInWebview(safeSelector: string): Promise<boolean> {
    const expr = `(() => {
      const el = (${DEEP_QS})('${safeSelector}');
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      if (typeof el.focus === 'function') el.focus();
      return true;
    })()`;
    return this.tryInWebviews(expr);
  }

  // ─── Diagnostics ──────────────────────────────────────────────────────────

  /**
   * List frame contexts for a webview target.  Useful for debugging which
   * execution contexts (frames) are discovered inside a webview.
   */
  async listWebviewFrameContexts(webviewTitle?: string): Promise<Array<{
    targetId: string;
    targetUrl: string;
    targetTitle: string;
    contexts: Array<{ id: number; origin: string; name: string; frameId?: string; isDefault?: boolean }>;
    frameTree?: unknown;
  }>> {
    const targets = await this.getWebviewTargets(webviewTitle, 5_000);
    const results: Array<{
      targetId: string;
      targetUrl: string;
      targetTitle: string;
      contexts: Array<{ id: number; origin: string; name: string; frameId?: string; isDefault?: boolean }>;
      frameTree?: unknown;
    }> = [];

    for (const target of targets) {
      try {
        const info = await this.withWebviewClient(target.id, async (wv) => {
          // Collect full context metadata
          const contexts: Array<{
            id: number; origin: string; name: string;
            frameId?: string; isDefault?: boolean;
          }> = [];
          const handler = (params: {
            context: {
              id: number; origin: string; name: string;
              auxData?: { frameId?: string; isDefault?: boolean };
            };
          }) => {
            contexts.push({
              id: params.context.id,
              origin: params.context.origin,
              name: params.context.name,
              frameId: params.context.auxData?.frameId,
              isDefault: params.context.auxData?.isDefault,
            });
          };
          (wv as any).on('Runtime.executionContextCreated', handler);
          try {
            try { await this.withProtocolTimeout(wv.Runtime.disable(), 'CDP Runtime.disable'); } catch { /* */ }
            await this.withProtocolTimeout(wv.Runtime.enable(), 'CDP Runtime.enable');
            await delay(300);
          } finally {
            (wv as any).removeListener('Runtime.executionContextCreated', handler);
          }

          // Also try Page.getFrameTree
          let frameTree: unknown;
          try {
            await this.withProtocolTimeout((wv as any).Page.enable(), 'CDP Page.enable');
            const result = await this.withProtocolTimeout<{ frameTree: unknown }>((wv as any).Page.getFrameTree(), 'CDP Page.getFrameTree');
            frameTree = result.frameTree;
            try { await this.withProtocolTimeout((wv as any).Page.disable(), 'CDP Page.disable'); } catch { /* */ }
          } catch { /* Page domain not available */ }

          return { contexts, frameTree };
        });
        results.push({
          targetId: target.id,
          targetUrl: target.url,
          targetTitle: target.title,
          ...info,
        });
      } catch { /* skip unreachable target */ }
    }
    return results;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function escapeSelector(selector: string): string {
  return selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function elementPointExpression(safeSelector: string): string {
  return `(() => {
    const el = (${DEEP_QS})('${safeSelector}');
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    if (typeof el.focus === 'function') el.focus();
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    let x = rect.left + rect.width / 2;
    let y = rect.top + rect.height / 2;
    try {
      let current = window;
      while (current.frameElement) {
        const frameRect = current.frameElement.getBoundingClientRect();
        x += frameRect.left;
        y += frameRect.top;
        current = current.parent;
      }
    } catch {
      return { x, y, unreliable: true };
    }
    return { x, y, unreliable: false };
  })()`;
}

function syntheticClickExpression(safeSelector: string, options: CdpClickOptions): string {
  const button = options.button ?? 'left';
  const buttonNumber = button === 'left' ? 0 : button === 'middle' ? 1 : 2;
  const buttons = buttonMask(button);
  const clickCount = options.clickCount ?? 1;
  return `(() => {
    const el = (${DEEP_QS})('${safeSelector}');
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    if (typeof el.focus === 'function') el.focus();
    const rect = el.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const base = { bubbles: true, cancelable: true, composed: true, clientX, clientY, button: ${buttonNumber}, buttons: ${buttons} };
    for (let i = 0; i < ${clickCount}; i++) {
      if (typeof PointerEvent === 'function') el.dispatchEvent(new PointerEvent('pointerdown', base));
      el.dispatchEvent(new MouseEvent('mousedown', base));
      if (${buttonNumber} === 2) {
        el.dispatchEvent(new MouseEvent('contextmenu', base));
      }
      if (typeof PointerEvent === 'function') el.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }));
      el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
      if (${buttonNumber} !== 2) {
        el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0, detail: i + 1 }));
      }
    }
    return true;
  })()`;
}

function webviewTextCandidatesExpression(text: string, markerPrefix: string, contextId: number): string {
  const target = JSON.stringify(text);
  const prefix = JSON.stringify(`${markerPrefix}-${contextId}`);
  return `(() => {
    const target = ${target};
    const markerPrefix = ${prefix};
    const normalizedTarget = normalize(target);
    const actionableSelector = 'button,a,input,select,textarea,[role="button"],[role="link"],[role="menuitem"],[role="option"],[role="tab"],[role="checkbox"],[role="radio"],[tabindex],summary';
    function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
    function normalize(value) { return clean(value).toLowerCase(); }
    function visible(el) {
      if (!el || el === document.body || el === document.documentElement) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    function disabled(el) { return el.disabled || el.getAttribute('aria-disabled') === 'true'; }
    function byId(id) { try { return id ? document.getElementById(id) : null; } catch { return null; } }
    function labelsFor(el) {
      const labels = [];
      if (el.labels) for (const label of Array.from(el.labels)) labels.push(clean(label.textContent));
      const id = el.id;
      if (id) for (const label of Array.from(document.querySelectorAll('label[for="' + CSS.escape(id) + '"]'))) labels.push(clean(label.textContent));
      return labels.filter(Boolean).join(' ');
    }
    function nameFor(el) {
      const labelledBy = clean((el.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => clean((byId(id) || {}).textContent)).join(' '));
      return clean(el.getAttribute('aria-label')) || labelledBy || clean(el.getAttribute('title')) || clean(el.getAttribute('alt')) || labelsFor(el) || clean(el.value) || clean(el.getAttribute('placeholder')) || clean(el.innerText || el.textContent);
    }
    function actionable(el) {
      const hit = el.closest(actionableSelector);
      if (!hit || !visible(hit) || disabled(hit)) return null;
      return hit;
    }
    function walk(root, out) {
      for (const el of Array.from(root.querySelectorAll('*'))) {
        const sr = el.shadowRoot;
        if (sr) walk(sr, out);
        if (!visible(el)) continue;
        const action = actionable(el);
        if (!action) continue;
        const name = nameFor(el) || nameFor(action);
        if (!name) continue;
        out.push({ element: el, action, name, normalized: normalize(name) });
      }
    }
    const raw = [];
    walk(document, raw);
    const byAction = new Map();
    for (const item of raw) {
      if (!byAction.has(item.action)) byAction.set(item.action, item);
      if (item.normalized === normalizedTarget) byAction.set(item.action, item);
    }
    const items = Array.from(byAction.values());
    const exact = items.filter((item) => item.normalized === normalizedTarget);
    const fuzzy = exact.length ? [] : items.filter((item) => item.normalized.includes(normalizedTarget));
    let counter = 0;
    function serialize(item) {
      const marker = markerPrefix + '-' + (++counter);
      item.action.setAttribute('data-vscode-ext-test-text-click', marker);
      return {
        marker,
        name: item.name,
        tag: item.action.tagName.toLowerCase(),
        role: item.action.getAttribute('role') || undefined,
        disabled: disabled(item.action),
      };
    }
    const candidates = (exact.length ? exact : fuzzy).slice(0, 20).map(serialize);
    return { exact: exact.map(serialize), fuzzy: fuzzy.map(serialize), candidates };
  })()`;
}

function webviewTextClickExpression(marker: string, options: CdpClickOptions): string {
  const safeMarker = JSON.stringify(marker);
  const button = options.button ?? 'left';
  const buttonNumber = button === 'left' ? 0 : button === 'middle' ? 1 : 2;
  const buttons = buttonMask(button);
  const clickCount = options.clickCount ?? 1;
  return `(() => {
    const el = document.querySelector('[data-vscode-ext-test-text-click=' + JSON.stringify(${safeMarker}) + ']');
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    if (typeof el.focus === 'function') el.focus();
    const rect = el.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const base = { bubbles: true, cancelable: true, composed: true, clientX, clientY, button: ${buttonNumber}, buttons: ${buttons} };
    for (let i = 0; i < ${clickCount}; i++) {
      if (typeof PointerEvent === 'function') el.dispatchEvent(new PointerEvent('pointerdown', base));
      el.dispatchEvent(new MouseEvent('mousedown', base));
      if (${buttonNumber} === 2) el.dispatchEvent(new MouseEvent('contextmenu', base));
      if (typeof PointerEvent === 'function') el.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }));
      el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
      if (${buttonNumber} !== 2) el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0, detail: i + 1 }));
    }
    return true;
  })()`;
}

function diagnosticError(message: string, diagnostic: AutomationDiagnostic): Error {
  const error = new Error(message) as Error & { diagnostic?: AutomationDiagnostic };
  error.diagnostic = diagnostic;
  return error;
}

function hasDiagnostic(error: unknown): error is Error & { diagnostic: AutomationDiagnostic } {
  return error instanceof Error && 'diagnostic' in error;
}

function formatDiagnosticSummary(entries: AutomationDiagnosticEntry[]): string {
  if (entries.length === 0) return '';
  return `\nDiagnostics:\n${entries.slice(-8).map((entry) => `- ${entry.strategy ?? entry.phase}${entry.contextId !== undefined ? ` ctx=${entry.contextId}` : ''}: ${entry.message}`).join('\n')}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buttonMask(button: CdpMouseButton): number {
  switch (button) {
    case 'left': return 1;
    case 'right': return 2;
    case 'middle': return 4;
  }
}

function isTimeoutError(error: Error): boolean {
  return /timed out after \d+ms/.test(error.message);
}

/**
 * Use the CDP Page domain to count the total number of frames (including
 * child iframes) inside a target.  Returns -1 if the Page domain is not
 * available (e.g. when connected to a worker or service-worker target).
 *
 * Called from `discoverFrameContextIds` to detect when inner iframes exist
 * but their execution contexts have not yet been reported via Runtime events.
 */
async function countTargetFrames(client: CDP.Client): Promise<number> {
  let pageEnabled = false;
  try {
    await withTimeout(
      (client as any).Page.enable(),
      CDP_PROTOCOL_TIMEOUT_MS,
      `CDP Page.enable timed out after ${CDP_PROTOCOL_TIMEOUT_MS}ms`,
    );
    pageEnabled = true;
    const { frameTree } = await withTimeout<{ frameTree: any }>(
      (client as any).Page.getFrameTree(),
      CDP_PROTOCOL_TIMEOUT_MS,
      `CDP Page.getFrameTree timed out after ${CDP_PROTOCOL_TIMEOUT_MS}ms`,
    );
    return countFrameTreeNodes(frameTree);
  } catch {
    return -1;
  } finally {
    if (pageEnabled) {
      try {
        await withTimeout(
          (client as any).Page.disable(),
          CDP_PROTOCOL_TIMEOUT_MS,
          `CDP Page.disable timed out after ${CDP_PROTOCOL_TIMEOUT_MS}ms`,
        );
      } catch { /* best effort */ }
    }
  }
}

function countFrameTreeNodes(node: any): number {
  let count = 1; // the node's own frame
  if (Array.isArray(node.childFrames)) {
    for (const child of node.childFrames) {
      count += countFrameTreeNodes(child);
    }
  }
  return count;
}

/**
 * Test whether a CDP target URL looks like a VS Code webview.
 * Matches traditional `vscode-webview://` URLs as well as the HTTPS-based
 * resource URLs introduced in VS Code ≥ 1.88 where webview content is served
 * from `https://<id>.vscode-webview-resource.vscode-cdn.net/…` or similar
 * `vscode-resource` / `vscode-webview-resource` origins.
 */
function isWebviewUrl(url: string): boolean {
  return (
    url.startsWith('vscode-webview://') ||
    url.includes('webviewPanel') ||
    /vscode[-.](?:webview[-.])?resource/i.test(url)
  );
}

// ─── Key parsing ────────────────────────────────────────────────────────────

interface ParsedKey {
  key: string;
  code: string;
  keyCode: number;
  modifiers: number;
}

const KEY_MAP: Record<string, { key: string; code: string; keyCode: number }> = {
  'enter':     { key: 'Enter',     code: 'Enter',      keyCode: 13 },
  'return':    { key: 'Enter',     code: 'Enter',      keyCode: 13 },
  'escape':    { key: 'Escape',    code: 'Escape',     keyCode: 27 },
  'esc':       { key: 'Escape',    code: 'Escape',     keyCode: 27 },
  'tab':       { key: 'Tab',       code: 'Tab',        keyCode: 9 },
  'backspace': { key: 'Backspace', code: 'Backspace',  keyCode: 8 },
  'delete':    { key: 'Delete',    code: 'Delete',     keyCode: 46 },
  'space':     { key: ' ',         code: 'Space',      keyCode: 32 },
  'arrowup':   { key: 'ArrowUp',   code: 'ArrowUp',    keyCode: 38 },
  'arrowdown': { key: 'ArrowDown', code: 'ArrowDown',  keyCode: 40 },
  'arrowleft': { key: 'ArrowLeft', code: 'ArrowLeft',  keyCode: 37 },
  'arrowright':{ key: 'ArrowRight',code: 'ArrowRight', keyCode: 39 },
  'up':        { key: 'ArrowUp',   code: 'ArrowUp',    keyCode: 38 },
  'down':      { key: 'ArrowDown', code: 'ArrowDown',  keyCode: 40 },
  'left':      { key: 'ArrowLeft', code: 'ArrowLeft',  keyCode: 37 },
  'right':     { key: 'ArrowRight',code: 'ArrowRight', keyCode: 39 },
  'home':      { key: 'Home',      code: 'Home',       keyCode: 36 },
  'end':       { key: 'End',       code: 'End',        keyCode: 35 },
  'pageup':    { key: 'PageUp',    code: 'PageUp',     keyCode: 33 },
  'pagedown':  { key: 'PageDown',  code: 'PageDown',   keyCode: 34 },
  'f1':        { key: 'F1',        code: 'F1',         keyCode: 112 },
  'f2':        { key: 'F2',        code: 'F2',         keyCode: 113 },
  'f3':        { key: 'F3',        code: 'F3',         keyCode: 114 },
  'f4':        { key: 'F4',        code: 'F4',         keyCode: 115 },
  'f5':        { key: 'F5',        code: 'F5',         keyCode: 116 },
  'f6':        { key: 'F6',        code: 'F6',         keyCode: 117 },
  'f7':        { key: 'F7',        code: 'F7',         keyCode: 118 },
  'f8':        { key: 'F8',        code: 'F8',         keyCode: 119 },
  'f9':        { key: 'F9',        code: 'F9',         keyCode: 120 },
  'f10':       { key: 'F10',       code: 'F10',        keyCode: 121 },
  'f11':       { key: 'F11',       code: 'F11',        keyCode: 122 },
  'f12':       { key: 'F12',       code: 'F12',        keyCode: 123 },
  '/':         { key: '/',         code: 'Slash',      keyCode: 191 },
  '?':         { key: '?',         code: 'Slash',      keyCode: 191 },
  '[':         { key: '[',         code: 'BracketLeft', keyCode: 219 },
  '{':         { key: '{',         code: 'BracketLeft', keyCode: 219 },
  ']':         { key: ']',         code: 'BracketRight', keyCode: 221 },
  '}':         { key: '}',         code: 'BracketRight', keyCode: 221 },
  '=':         { key: '=',         code: 'Equal',      keyCode: 187 },
  '+':         { key: '+',         code: 'Equal',      keyCode: 187 },
  '-':         { key: '-',         code: 'Minus',      keyCode: 189 },
  '_':         { key: '_',         code: 'Minus',      keyCode: 189 },
  '`':         { key: '`',         code: 'Backquote',  keyCode: 192 },
  '~':         { key: '~',         code: 'Backquote',  keyCode: 192 },
  '\\':        { key: '\\',        code: 'Backslash',  keyCode: 220 },
  '|':         { key: '|',         code: 'Backslash',  keyCode: 220 },
  ',':         { key: ',',         code: 'Comma',      keyCode: 188 },
  '<':         { key: '<',         code: 'Comma',      keyCode: 188 },
  '.':         { key: '.',         code: 'Period',     keyCode: 190 },
  '>':         { key: '>',         code: 'Period',     keyCode: 190 },
  ';':         { key: ';',         code: 'Semicolon',  keyCode: 186 },
  ':':         { key: ':',         code: 'Semicolon',  keyCode: 186 },
  "'":         { key: "'",         code: 'Quote',      keyCode: 222 },
  '"':         { key: '"',         code: 'Quote',      keyCode: 222 },
};

function parseKeySpec(spec: string): ParsedKey {
  const trimmed = spec.trim();
  const endsWithPlusKey = trimmed.endsWith('+') && trimmed.includes('+');
  const parts = trimmed.split('+').map((p) => p.trim()).filter(Boolean);
  if (endsWithPlusKey) parts.push('+');
  let modifiers = 0;

  // CDP modifier flags: Alt=1, Ctrl=2, Meta=4, Shift=8
  const nonModifierParts: string[] = [];
  for (const part of parts) {
    switch (part.toLowerCase()) {
      case 'alt':   modifiers |= 1; break;
      case 'ctrl':
      case 'control': modifiers |= 2; break;
      case 'meta':
      case 'cmd':
      case 'command': modifiers |= 4; break;
      case 'shift': modifiers |= 8; break;
      default:       nonModifierParts.push(part); break;
    }
  }

  if (nonModifierParts.length !== 1) {
    throw new Error(`Unsupported key spec: ${spec}`);
  }

  const keyName = nonModifierParts[0];
  const mapped = KEY_MAP[keyName.toLowerCase()];

  if (mapped) {
    return { ...mapped, modifiers };
  }

  // Single character key
  if (keyName.length === 1) {
    const upper = keyName.toUpperCase();
    if (upper >= 'A' && upper <= 'Z') {
      return { key: keyName, code: `Key${upper}`, keyCode: upper.charCodeAt(0), modifiers };
    }
    if (keyName >= '0' && keyName <= '9') {
      return { key: keyName, code: `Digit${keyName}`, keyCode: keyName.charCodeAt(0), modifiers };
    }
  }

  throw new Error(`Unsupported key spec: ${spec}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
    unrefTimer(timeoutHandle);
  });

  return Promise.race([operation, timeout]).finally(() => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  });
}

function unrefTimer(handle: ReturnType<typeof setTimeout>): void {
  if (typeof handle === 'object' && 'unref' in handle && typeof handle.unref === 'function') {
    handle.unref();
  }
}
