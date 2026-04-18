import * as vscode from 'vscode';

/**
 * Monitors VS Code output channels and captures their content.
 */
export class OutputMonitor {
  private channelContents = new Map<string, string[]>();

  register(): vscode.Disposable[] {
    // VS Code's OutputChannel API doesn't expose a "read" method directly.
    // We use LogOutputChannel which has an onDidAppend event in newer versions.
    // For older versions, we proxy output channels created by the controller.
    return [];
  }

  /**
   * Create a monitored output channel that captures all appended text.
   */
  createMonitoredChannel(name: string): vscode.OutputChannel {
    const channel = vscode.window.createOutputChannel(name);
    this.channelContents.set(name, []);

    const originalAppend = channel.append.bind(channel);
    const originalAppendLine = channel.appendLine.bind(channel);

    channel.append = (value: string) => {
      this.appendContent(name, value);
      originalAppend(value);
    };

    channel.appendLine = (value: string) => {
      this.appendContent(name, value + '\n');
      originalAppendLine(value);
    };

    return channel;
  }

  /**
   * Get the content of a monitored output channel.
   */
  getContent(name: string): { name: string; content: string } {
    const lines = this.channelContents.get(name) ?? [];
    return { name, content: lines.join('') };
  }

  /**
   * List all known output channel names.
   */
  listChannels(): string[] {
    return Array.from(this.channelContents.keys());
  }

  clearAll(): void {
    for (const [name] of this.channelContents) {
      this.channelContents.set(name, []);
    }
  }

  private appendContent(name: string, value: string): void {
    let lines = this.channelContents.get(name);
    if (!lines) {
      lines = [];
      this.channelContents.set(name, lines);
    }
    lines.push(value);
  }
}
