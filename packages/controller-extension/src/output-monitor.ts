import * as vscode from 'vscode';

/**
 * Captures output channel content.
 *
 * The controller's own channel is captured directly via `appendContent()`.
 *
 * For OTHER extensions' channels, VS Code provides no API to read their
 * content from the extension host. The `readChannel(name)` method works
 * around this by:
 *   1. Showing the output panel focused on the named channel
 *   2. Scanning `workspace.textDocuments` for the newly visible `output:` doc
 *   3. Reading its full text
 *
 * This is on-demand — called when a test assertion needs a channel's content.
 */
export class OutputMonitor {
  private readonly channels = new Map<string, string>();
  private readonly explicit = new Set<string>();
  readonly _diag: string[] = [];

  register(): vscode.Disposable[] {
    this._diag.push(`register() called at ${new Date().toISOString()}`);

    const disposables: vscode.Disposable[] = [];

    // Listen for output document changes (fires once a channel is shown)
    disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme !== 'output') return;
        const name = this.channelNameFromUri(e.document.uri);
        if (name) {
          this.channels.set(name, e.document.getText());
        }
      }),
    );

    disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => {
        if (doc.uri.scheme !== 'output') return;
        const name = this.channelNameFromUri(doc.uri);
        if (name) {
          this._diag.push(`output doc opened: "${name}" uri=${doc.uri.toString()}`);
          this.channels.set(name, doc.getText());
        }
      }),
    );

    this._diag.push('listeners registered');
    return disposables;
  }

  /**
   * Actively read a channel's content by showing it in the output panel.
   * This is the only reliable way to read channels from other extensions.
   */
  async readChannel(name: string): Promise<string> {
    // 1. Try to show the output channel by executing VS Code commands.
    //    The command `workbench.action.output.show` opens the output panel.
    //    Then we need to switch to the right channel.
    try {
      // First, enumerate available output channels by looking for known commands
      // and text documents. Show the output panel first.
      await vscode.commands.executeCommand('workbench.action.output.show');
      await delay(200);

      // Try to find and activate the channel by its name using the QuickPick
      // approach: execute 'workbench.action.output.show.' + channelId
      // We don't know the exact ID, so iterate all text documents looking for it.
      const found = this.findOutputDoc(name);
      if (found) {
        this.channels.set(name, found);
        return found;
      }

      // If not found yet, try typing the channel name into the output switcher
      // by executing the switch command
      await vscode.commands.executeCommand(
        'workbench.action.output.show',
      );
      await delay(300);

      // Scan again
      const found2 = this.findOutputDoc(name);
      if (found2) {
        this.channels.set(name, found2);
        return found2;
      }
    } catch (e: any) {
      this._diag.push(`readChannel("${name}") error: ${e?.message}`);
    }

    // 2. Fallback: check our buffer (controller's own channel)
    return this.channels.get(name) ?? '';
  }

  /**
   * Scan workspace.textDocuments for an output-scheme doc matching the name.
   */
  private findOutputDoc(name: string): string | undefined {
    const lower = name.toLowerCase();
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== 'output') continue;
      const uri = doc.uri.toString().toLowerCase();
      const docName = this.channelNameFromUri(doc.uri);
      if (
        docName?.toLowerCase() === lower ||
        uri.includes(lower.replace(/\s+/g, '-')) ||
        uri.includes(lower.replace(/\s+/g, ''))
      ) {
        this._diag.push(`findOutputDoc("${name}"): found uri=${doc.uri.toString()} len=${doc.getText().length}`);
        return doc.getText();
      }
    }

    // Log what we DID find for debugging
    const allOutputDocs = vscode.workspace.textDocuments.filter(d => d.uri.scheme === 'output');
    if (allOutputDocs.length > 0) {
      this._diag.push(`findOutputDoc("${name}"): not found. Available output docs:`);
      for (const d of allOutputDocs) {
        this._diag.push(`  ${d.uri.toString()} (${d.getText().length} chars)`);
      }
    } else {
      this._diag.push(`findOutputDoc("${name}"): no output docs in workspace.textDocuments`);
    }
    return undefined;
  }

  /**
   * Extract the channel name from an output document URI.
   */
  private channelNameFromUri(uri: vscode.Uri): string | undefined {
    const raw = uri.path || uri.fragment || uri.fsPath || '';

    // Pattern: "extension-output-<ext-id>-#<N>-<Channel Name>"
    const extMatch = raw.match(/-#\d+-(.+)$/);
    if (extMatch) return extMatch[1];

    // Pattern: just the channel name directly
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
    for (const name of this.channels.keys()) {
      this.channels.set(name, '');
    }
  }

  getOffset(name: string): number {
    return (this.channels.get(name) ?? '').length;
  }

  getDiagnostics(): { diag: string[]; channelSummary: Record<string, number> } {
    const channelSummary: Record<string, number> = {};
    for (const [name, content] of this.channels) {
      channelSummary[name] = content.length;
    }
    return { diag: this._diag, channelSummary };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
