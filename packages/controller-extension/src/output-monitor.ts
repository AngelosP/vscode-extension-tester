import * as vscode from 'vscode';

/**
 * Captures the full text written to every VS Code OutputChannel and
 * LogOutputChannel - including channels created by other extensions that
 * activated **before** the controller.
 *
 * Strategy (two layers, no double-capture):
 *
 * 1. **Prototype-level patch** - We create a disposable probe channel, walk
 *    to its `__proto__`, and patch `append`/`appendLine`/`replace`/`clear`
 *    there.  Because every OutputChannel instance delegates to the same
 *    prototype, this intercepts writes on channels that already exist -
 *    solving the activation-order race.  The prototype methods check
 *    `this.__extTesterWrapped`; if the flag is set the call is a no-op on
 *    our side (the instance-level wrapper handles it instead).
 *
 * 2. **Instance-level wrap** - For channels created *after* our patch
 *    (via the monkey-patched `createOutputChannel`), we additionally wrap
 *    the instance so we can intercept LogOutputChannel-only methods
 *    (`trace`/`debug`/`info`/`warn`/`error`) that live on a different
 *    prototype.  The instance is flagged `__extTesterWrapped = true` so the
 *    prototype layer skips it.
 */
export class OutputMonitor {
  private readonly channels = new Map<string, string[]>();
  /** Channels the user has explicitly opted in to. Empty = capture every channel. */
  private readonly explicit = new Set<string>();
  private patched = false;

  register(): vscode.Disposable[] {
    if (this.patched) return [];
    this.patched = true;

    const win = vscode.window as unknown as Record<string, unknown>;
    const originalCreate = win['createOutputChannel'] as (
      name: string,
      languageOrOptions?: string | { log: boolean },
    ) => vscode.OutputChannel;
    const originalCreateLog = win['createLogOutputChannel'] as
      | ((name: string, options?: { log: true }) => vscode.OutputChannel)
      | undefined;

    const self = this;

    // ── Layer 1: Prototype-level patches ─────────────────────────────────
    // Catches writes on channels created BEFORE our activation.
    this.patchPrototype(originalCreate, /* isLog */ false);
    if (originalCreateLog) {
      this.patchPrototype(
        (name: string) => originalCreateLog.call(vscode.window, name, { log: true }),
        /* isLog */ true,
      );
    }

    // ── Layer 2: createOutputChannel interception ────────────────────────
    // Wraps new channels at the instance level (sets __extTesterWrapped).
    win['createOutputChannel'] = function patchedCreateOutputChannel(
      name: string,
      languageOrOptions?: string | { log: boolean },
    ): vscode.OutputChannel {
      const isLog =
        typeof languageOrOptions === 'object' && languageOrOptions?.log === true;
      const channel = isLog && originalCreateLog
        ? originalCreateLog.call(vscode.window, name, { log: true })
        : originalCreate.call(
            vscode.window,
            name,
            typeof languageOrOptions === 'string' ? languageOrOptions : undefined,
          );
      self.wrap(channel, name);
      return channel;
    };

    if (originalCreateLog) {
      win['createLogOutputChannel'] = function patchedCreateLogOutputChannel(
        name: string,
        options?: { log: true },
      ): vscode.OutputChannel {
        const channel = originalCreateLog.call(vscode.window, name, options);
        self.wrap(channel, name);
        return channel;
      };
    }

    return [
      {
        dispose: (): void => {
          win['createOutputChannel'] = originalCreate;
          if (originalCreateLog) {
            win['createLogOutputChannel'] = originalCreateLog;
          }
          this.patched = false;
        },
      },
    ];
  }

  // ── Prototype patching ──────────────────────────────────────────────────

  /**
   * Create a throwaway probe channel, locate its prototype, and patch the
   * write methods so that ALL instances (past and future) are intercepted.
   */
  private patchPrototype(
    factory: (name: string) => vscode.OutputChannel,
    isLog: boolean,
  ): void {
    const PROBE = '__ext_tester_probe__';
    let probe: vscode.OutputChannel | undefined;
    try {
      probe = factory(PROBE);
    } catch {
      return; // factory failed - nothing to patch
    }

    const proto = Object.getPrototypeOf(probe);
    if (!proto || (proto as any).__extTesterPatched) {
      try { probe.dispose(); } catch { /* */ }
      return;
    }

    const self = this;

    // append
    const origAppend = proto.append as Function | undefined;
    if (typeof origAppend === 'function') {
      proto.append = function (this: any, value: string) {
        if (!this.__extTesterWrapped && this.name && this.name !== PROBE) {
          self.appendContent(this.name, value);
        }
        return origAppend.call(this, value);
      };
    }

    // appendLine
    const origAppendLine = proto.appendLine as Function | undefined;
    if (typeof origAppendLine === 'function') {
      proto.appendLine = function (this: any, value: string) {
        if (!this.__extTesterWrapped && this.name && this.name !== PROBE) {
          self.appendContent(this.name, value + '\n');
        }
        return origAppendLine.call(this, value);
      };
    }

    // replace
    const origReplace = proto.replace as Function | undefined;
    if (typeof origReplace === 'function') {
      proto.replace = function (this: any, value: string) {
        if (!this.__extTesterWrapped && this.name && this.name !== PROBE) {
          self.channels.set(this.name, [value]);
        }
        return origReplace.call(this, value);
      };
    }

    // clear
    const origClear = proto.clear as Function | undefined;
    if (typeof origClear === 'function') {
      proto.clear = function (this: any) {
        if (!this.__extTesterWrapped && this.name && this.name !== PROBE) {
          self.channels.set(this.name, []);
        }
        return origClear.call(this);
      };
    }

    // Log-level methods (LogOutputChannel only)
    if (isLog) {
      for (const method of ['trace', 'debug', 'info', 'warn', 'error'] as const) {
        const orig = proto[method] as Function | undefined;
        if (typeof orig === 'function') {
          proto[method] = function (this: any, message: string, ...args: unknown[]) {
            if (!this.__extTesterWrapped && this.name && this.name !== PROBE) {
              const formatted = args.length > 0
                ? `${message} ${args.map((a: unknown) => formatArg(a)).join(' ')}`
                : message;
              self.appendContent(this.name, `[${method}] ${formatted}\n`);
            }
            return orig.call(this, message, ...args);
          };
        }
      }
    }

    Object.defineProperty(proto, '__extTesterPatched', {
      value: true,
      enumerable: false,
      configurable: true,
    });
    try { probe.dispose(); } catch { /* */ }
  }

  // ── Instance-level wrapping (for channels created after our patch) ─────

  private wrap(channel: vscode.OutputChannel, name: string): void {
    if (!this.channels.has(name)) this.channels.set(name, []);

    const c = channel as vscode.OutputChannel & Record<string, unknown>;
    Object.defineProperty(c, '__extTesterWrapped', {
      value: true,
      enumerable: false,
      configurable: true,
    });

    const originalAppend = c.append.bind(c);
    const originalAppendLine = c.appendLine.bind(c);
    const replaceFn = c['replace'] as ((value: string) => void) | undefined;
    const originalReplace = replaceFn ? replaceFn.bind(c) : undefined;
    const originalClear = c.clear.bind(c);

    c.append = (value: string): void => {
      this.appendContent(name, value);
      originalAppend(value);
    };
    c.appendLine = (value: string): void => {
      this.appendContent(name, value + '\n');
      originalAppendLine(value);
    };
    if (originalReplace) {
      (c as { replace: (value: string) => void }).replace = (value: string): void => {
        this.channels.set(name, [value]);
        originalReplace(value);
      };
    }
    c.clear = (): void => {
      this.channels.set(name, []);
      originalClear();
    };

    for (const method of ['trace', 'debug', 'info', 'warn', 'error'] as const) {
      const original = c[method] as ((message: string, ...args: unknown[]) => void) | undefined;
      if (typeof original === 'function') {
        const bound = original.bind(c);
        c[method] = (message: string, ...args: unknown[]): void => {
          const formatted = args.length > 0
            ? `${message} ${args.map((a) => formatArg(a)).join(' ')}`
            : message;
          this.appendContent(name, `[${method}] ${formatted}\n`);
          bound(message, ...args);
        };
      }
    }
  }

  getContent(name: string): { name: string; content: string; captured: boolean } {
    const lines = this.channels.get(name);
    return {
      name,
      content: lines ? lines.join('') : '',
      captured: this.channels.has(name),
    };
  }

  listChannels(): string[] {
    return Array.from(this.channels.keys()).sort();
  }

  getCapturedChannels(): Array<{ name: string; content: string }> {
    const out: Array<{ name: string; content: string }> = [];
    for (const [name, lines] of this.channels) {
      if (this.explicit.size > 0 && !this.explicit.has(name)) continue;
      out.push({ name, content: lines.join('') });
    }
    return out;
  }

  startCapture(name: string): void {
    this.explicit.add(name);
    if (!this.channels.has(name)) this.channels.set(name, []);
  }

  stopCapture(name: string): void {
    this.explicit.delete(name);
  }

  clearAll(): void {
    for (const name of this.channels.keys()) {
      this.channels.set(name, []);
    }
  }

  getOffset(name: string): number {
    const lines = this.channels.get(name);
    if (!lines) return 0;
    let sum = 0;
    for (const l of lines) sum += l.length;
    return sum;
  }

  private appendContent(name: string, value: string): void {
    let lines = this.channels.get(name);
    if (!lines) {
      lines = [];
      this.channels.set(name, lines);
    }
    lines.push(value);
  }
}

function formatArg(a: unknown): string {
  if (a instanceof Error) return a.stack ?? a.message;
  if (typeof a === 'object') {
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  }
  return String(a);
}