import CDP from 'chrome-remote-interface';
import * as fs from 'node:fs';
import * as path from 'node:path';

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

  constructor(private readonly port: number) {}

  async connect(): Promise<void> {
    this.client = await CDP({ port: this.port });
    await this.client.Runtime.enable();
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
      await this.client.Input.dispatchKeyEvent({
        type: 'keyDown',
        text: char,
        key: char,
        unmodifiedText: char,
      });
      await this.client.Input.dispatchKeyEvent({
        type: 'keyUp',
        key: char,
      });
      await delay(20);
    }
  }

  /**
   * Press a key or key combination (e.g. "Enter", "Escape", "Ctrl+S", "Shift+Tab").
   */
  async pressKey(keySpec: string): Promise<void> {
    if (!this.client) throw new Error('CDP not connected');

    const { key, code, keyCode, modifiers } = parseKeySpec(keySpec);

    await this.client.Input.dispatchKeyEvent({
      type: 'keyDown',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    });
    await this.client.Input.dispatchKeyEvent({
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    });
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
    const mainResult = await this.client.Runtime.evaluate({
      expression: `(() => {
        const el = document.querySelector('${safeSelector}');
        if (!el) return null;
        el.focus();
        el.click();
        return true;
      })()`,
      returnByValue: true,
    });
    if (mainResult.result.value) return;

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
    const mainResult = await this.client.Runtime.evaluate({
      expression: `(() => {
        const el = document.querySelector('${safeSelector}');
        if (!el) return null;
        el.focus();
        return true;
      })()`,
      returnByValue: true,
    });
    if (mainResult.result.value) return;

    // 2. Search webview targets
    const focused = await this.focusInWebview(safeSelector);
    if (focused) return;

    throw new Error(`Element not found for focus: ${selector}`);
  }

  /**
   * Evaluate JavaScript in the page context. Returns the result.
   */
  async evaluate(expression: string): Promise<unknown> {
    if (!this.client) throw new Error('CDP not connected');

    const result = await this.client.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
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
  async evaluateInWebview(expression: string, webviewTitle?: string): Promise<unknown> {
    const targets = await this.getWebviewTargets(webviewTitle);
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
          return await this.evaluateAcrossFrames(wv, expression);
        });
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
  async clickInWebviewBySelector(selector: string, webviewTitle?: string): Promise<void> {
    const safe = escapeSelector(selector);
    const expr = `(() => {
      const el = document.querySelector('${safe}');
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      if (typeof el.focus === 'function') el.focus();
      el.click();
      return true;
    })()`;
    const found = await this.tryInWebviews(expr, webviewTitle);
    if (!found) throw new Error(`Element not found in webview: ${selector}`);
  }

  /** Focus an element inside a webview by CSS selector. */
  async focusInWebviewBySelector(selector: string, webviewTitle?: string): Promise<void> {
    const safe = escapeSelector(selector);
    const expr = `(() => {
      const el = document.querySelector('${safe}');
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
      const el = document.querySelector('${safe}');
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
    const expr = `(() => document.querySelector('${safe}') ? true : null)()`;
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
      const el = document.querySelector('${safe}');
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
    const expr = `(() => document.querySelector('${safe}') ? true : null)()`;
    try {
      const v = await this.tryInWebviews(expr, webviewTitle);
      return v === true;
    } catch {
      return false;
    }
  }

  /** Return the full text content of all matching webviews, joined (including nested iframes). */
  async getWebviewBodyText(webviewTitle?: string): Promise<string> {
    const targets = await this.getWebviewTargets(webviewTitle);
    if (targets.length === 0) return '';
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
  async listWebviews(): Promise<Array<{ title: string; url: string }>> {
    const targets = await this.getWebviewTargets();
    return targets.map((t) => ({ title: t.title, url: t.url }));
  }

  // ─── Frame-aware evaluation helpers ──────────────────────────────────────
  //
  // VS Code custom editor webviews use deeply nested cross-origin iframes:
  //   main renderer → vscode-webview:// outer → inner iframe(s) with content
  // CDP lists the outer webview as a target, but the inner iframes are frames
  // within that target - not separate targets. To interact with elements in the
  // inner frames, we must enumerate all execution contexts and try each one.

  /**
   * Discover all execution context IDs within a connected CDP client.
   * Each frame (including cross-origin iframes) gets its own execution context.
   * Re-enabling Runtime triggers `executionContextCreated` for every existing context.
   */
  private async discoverFrameContextIds(client: CDP.Client): Promise<number[]> {
    const contextIds: number[] = [];
    const handler = (params: { context: { id: number } }) => {
      contextIds.push(params.context.id);
    };

    (client as any).on('Runtime.executionContextCreated', handler);
    try {
      await client.Runtime.disable();
      await client.Runtime.enable();
      // Allow context-created events to be delivered (they fire asynchronously)
      await delay(100);
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
  ): Promise<unknown> {
    const contextIds = await this.discoverFrameContextIds(client);

    for (const contextId of contextIds) {
      try {
        const r = await client.Runtime.evaluate({
          expression,
          returnByValue: true,
          awaitPromise: true,
          contextId,
        });
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
  ): Promise<unknown[]> {
    const contextIds = await this.discoverFrameContextIds(client);
    const results: unknown[] = [];

    for (const contextId of contextIds) {
      try {
        const r = await client.Runtime.evaluate({
          expression,
          returnByValue: true,
          awaitPromise: true,
          contextId,
        });
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
  private async tryInWebviews(expression: string, webviewTitle?: string): Promise<boolean> {
    const targets = await this.getWebviewTargets(webviewTitle);
    for (const target of targets) {
      try {
        const value = await this.withWebviewClient(target.id, async (wv) => {
          return await this.evaluateAcrossFrames(wv, expression);
        });
        if (value === true) return true;
      } catch { /* try next target */ }
    }
    return false;
  }

  /**
   * Like tryInWebviews but returns the raw value of the first non-null result.
   * Traverses all frames within each webview target.
   */
  private async tryInWebviewsRaw(expression: string, webviewTitle?: string): Promise<unknown> {
    const targets = await this.getWebviewTargets(webviewTitle);
    for (const target of targets) {
      try {
        const value = await this.withWebviewClient(target.id, async (wv) => {
          return await this.evaluateAcrossFrames(wv, expression);
        });
        if (value !== null && value !== undefined) return value;
      } catch { /* try next */ }
    }
    return null;
  }

  /**
   * List all CDP targets and return those that look like VS Code webviews.
   * If `titleFilter` is provided, only targets whose title contains the
   * substring (case-insensitive) are returned.
   */
  private async getWebviewTargets(
    titleFilter?: string,
  ): Promise<Array<{ id: string; url: string; title: string }>> {
    const targets = await CDP.List({ port: this.port });
    const webviews = targets.filter(
      (t: { type: string; url: string }) =>
        (t.type === 'page' || t.type === 'iframe') &&
        (t.url.startsWith('vscode-webview://') || t.url.includes('webviewPanel'))
    );
    if (!titleFilter) return webviews as Array<{ id: string; url: string; title: string }>;
    const needle = titleFilter.toLowerCase();
    return (webviews as Array<{ id: string; url: string; title: string }>).filter(
      (t) => (t.title ?? '').toLowerCase().includes(needle) || t.url.toLowerCase().includes(needle),
    );
  }


  /**
   * Connect to a webview target, run a callback, then disconnect.
   */
  private async withWebviewClient<T>(
    targetId: string,
    fn: (client: CDP.Client) => Promise<T>,
  ): Promise<T> {
    const wvClient = await CDP({ port: this.port, target: targetId });
    try {
      await wvClient.Runtime.enable();
      return await fn(wvClient);
    } finally {
      wvClient.close();
    }
  }

  /**
   * Try to click an element in any webview target. Returns true if found.
   */
  private async clickInWebview(safeSelector: string): Promise<boolean> {
    const expr = `(() => {
      const el = document.querySelector('${safeSelector}');
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      if (typeof el.focus === 'function') el.focus();
      el.click();
      return true;
    })()`;
    return this.tryInWebviews(expr);
  }

  /**
   * Try to focus an element in any webview target. Returns true if found.
   */
  private async focusInWebview(safeSelector: string): Promise<boolean> {
    const expr = `(() => {
      const el = document.querySelector('${safeSelector}');
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      if (typeof el.focus === 'function') el.focus();
      return true;
    })()`;
    return this.tryInWebviews(expr);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function escapeSelector(selector: string): string {
  return selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
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
};

function parseKeySpec(spec: string): ParsedKey {
  const parts = spec.split('+').map((p) => p.trim());
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

  const keyName = nonModifierParts[0] ?? '';
  const mapped = KEY_MAP[keyName.toLowerCase()];

  if (mapped) {
    return { ...mapped, modifiers };
  }

  // Single character key
  if (keyName.length === 1) {
    const upper = keyName.toUpperCase();
    const code = `Key${upper}`;
    return { key: keyName, code, keyCode: upper.charCodeAt(0), modifiers };
  }

  // Fallback
  return { key: keyName, code: keyName, keyCode: 0, modifiers };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
