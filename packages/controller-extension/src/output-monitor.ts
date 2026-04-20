import * as vscode from 'vscode';

/**
 * Captures the controller extension's own output channel content.
 *
 * For OTHER extensions' output channels, the CLI reads them directly via CDP
 * (Chrome DevTools Protocol) — accessing VS Code's renderer internals to
 * discover channel backing files and reading them from the filesystem.
 * The extension host cannot read other extensions' output channels due to
 * API sandboxing.
 *
 * This class provides:
 * - `appendContent()` — direct write to the buffer (used by extension.ts)
 * - Passive capture via `onDidChangeTextDocument` for `output:` scheme docs
 *   (fires only for channels that have been shown in the output panel)
 * - `startCapture(name)` — allow-list mode for targeted channel capture
 */
export class OutputMonitor {
  private readonly channels = new Map<string, string>();
  private readonly explicit = new Set<string>();
  readonly _diag: string[] = [];

  register(): vscode.Disposable[] {
    this._diag.push(`register() called at ${new Date().toISOString()}`);
    const disposables: vscode.Disposable[] = [];

    // Passive capture: fires for output docs that are shown in the panel
    disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme !== 'output') return;
        const name = this.channelNameFromUri(e.document.uri);
        if (name) this.channels.set(name, e.document.getText());
      }),
      vscode.workspace.onDidOpenTextDocument((doc) => {
        if (doc.uri.scheme !== 'output') return;
        const name = this.channelNameFromUri(doc.uri);
        if (name) {
          this._diag.push(`output doc opened: "${name}"`);
          this.channels.set(name, doc.getText());
        }
      }),
    );

    this._diag.push('listeners registered');
    return disposables;
  }

  private channelNameFromUri(uri: vscode.Uri): string | undefined {
    const raw = uri.path || uri.fragment || uri.fsPath || '';
    const extMatch = raw.match(/-#\d+-(.+)$/);
    if (extMatch) return extMatch[1];
    if (raw && !raw.includes('/')) return raw;
    return uri.authority || raw || undefined;
  }

  /** Write directly to the buffer — for the controller's own channel. */
  appendContent(name: string, value: string): void {
    const existing = this.channels.get(name) ?? '';
    this.channels.set(name, existing + value);
  }

  getContent(name: string): { name: string; content: string; captured: boolean } {
    const content = this.channels.get(name);
    return { name, content: content ?? '', captured: this.channels.has(name) };
  }

  listChannels(): string[] {
    return Array.from(this.channels.keys()).sort();
  }

  getCapturedChannels(): Array<{ name: string; content: string }> {
    const out: Array<{ name: string; content: string }> = [];
    for (const [name, content] of this.channels) {
      if (this.explicit.size > 0 && !this.explicit.has(name)) continue;
      out.push({ name, content });
    }
    return out;
  }

  startCapture(name: string): void {
    this.explicit.add(name);
    if (!this.channels.has(name)) this.channels.set(name, '');
  }

  stopCapture(name: string): void {
    this.explicit.delete(name);
  }

  clearAll(): void {
    for (const name of this.channels.keys()) this.channels.set(name, '');
  }

  getOffset(name: string): number {
    return (this.channels.get(name) ?? '').length;
  }

  getDiagnostics(): { diag: string[]; channelSummary: Record<string, number> } {
    const channelSummary: Record<string, number> = {};
    for (const [name, content] of this.channels) channelSummary[name] = content.length;
    return { diag: this._diag, channelSummary };
  }
}
