import CDP from 'chrome-remote-interface';

/**
 * Chrome DevTools Protocol client for sending real input events to VS Code.
 * Works with any focused element — regular editors, webview Monaco, dialogs, etc.
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

  // ─── Webview target helpers ─────────────────────────────────────────────

  /**
   * List all CDP targets and return those that look like VS Code webviews.
   */
  private async getWebviewTargets(): Promise<Array<{ id: string; url: string; title: string }>> {
    const targets = await CDP.List({ port: this.port });
    return targets.filter(
      (t: { type: string; url: string }) =>
        t.type === 'page' &&
        (t.url.startsWith('vscode-webview://') || t.url.includes('webviewPanel'))
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
    const targets = await this.getWebviewTargets();
    for (const target of targets) {
      try {
        const found = await this.withWebviewClient(target.id, async (wv) => {
          const result = await wv.Runtime.evaluate({
            expression: `(() => {
              const el = document.querySelector('${safeSelector}');
              if (!el) return null;
              el.scrollIntoView({ block: 'center' });
              el.focus();
              el.click();
              return true;
            })()`,
            returnByValue: true,
          });
          return result.result.value === true;
        });
        if (found) return true;
      } catch { /* target may have closed, skip */ }
    }
    return false;
  }

  /**
   * Try to focus an element in any webview target. Returns true if found.
   */
  private async focusInWebview(safeSelector: string): Promise<boolean> {
    const targets = await this.getWebviewTargets();
    for (const target of targets) {
      try {
        const found = await this.withWebviewClient(target.id, async (wv) => {
          const result = await wv.Runtime.evaluate({
            expression: `(() => {
              const el = document.querySelector('${safeSelector}');
              if (!el) return null;
              el.scrollIntoView({ block: 'center' });
              el.focus();
              return true;
            })()`,
            returnByValue: true,
          });
          return result.result.value === true;
        });
        if (found) return true;
      } catch { /* skip */ }
    }
    return false;
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
