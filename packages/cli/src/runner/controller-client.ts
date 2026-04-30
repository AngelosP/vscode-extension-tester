import WebSocket from 'ws';
import type {
  ControllerRequest,
  ControllerResponse,
  VSCodeState,
  NotificationInfo,
  ProgressState,
  QuickInputSelectResult,
  QuickInputState,
  QuickInputTextResult,
  ExtensionHostScriptResult,
} from '../types.js';
import { WS_CONNECT_TIMEOUT_MS } from '../types.js';

/**
 * WebSocket client for communicating with the controller extension
 * running inside the VS Code instance under test.
 */
export class ControllerClient {
  private ws?: WebSocket;
  private requestId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly port: number, private readonly requestTimeoutMs: number = 30_000) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Connection timed out after ${WS_CONNECT_TIMEOUT_MS}ms`));
      }, WS_CONNECT_TIMEOUT_MS);

      this.ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
      this.ws.on('open', () => { clearTimeout(timeout); resolve(); });
      this.ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
      this.ws.on('message', (data) => this.handleMessage(data.toString()));
      this.ws.on('close', () => {
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error('Connection closed'));
        }
        this.pending.clear();
      });
    });
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = undefined;
  }

  async executeCommand(commandId: string, args?: unknown[]): Promise<unknown> {
    return this.send('executeCommand', { commandId, args });
  }

  async startCommand(commandId: string, args?: unknown[]): Promise<unknown> {
    return this.send('startCommand', { commandId, args });
  }

  async runExtensionHostScript(script: string, timeoutMs = this.requestTimeoutMs): Promise<ExtensionHostScriptResult> {
    return this.send(
      'runExtensionHostScript',
      { script, timeoutMs },
      Math.max(this.requestTimeoutMs, timeoutMs + 1_000),
    ) as Promise<ExtensionHostScriptResult>;
  }

  async respondToQuickPick(label: string): Promise<unknown> {
    return this.send('respondToQuickPick', { label });
  }

  async respondToInputBox(value: string): Promise<unknown> {
    return this.send('respondToInputBox', { value });
  }

  async respondToDialog(button: string): Promise<unknown> {
    return this.send('respondToDialog', { button });
  }

  async getQuickInputState(): Promise<QuickInputState> {
    return this.send('getQuickInputState') as Promise<QuickInputState>;
  }

  async selectQuickInputItem(label: string): Promise<QuickInputSelectResult> {
    return this.send('selectQuickInputItem', { label }) as Promise<QuickInputSelectResult>;
  }

  async submitQuickInputText(value: string): Promise<QuickInputTextResult> {
    return this.send('submitQuickInputText', { value }) as Promise<QuickInputTextResult>;
  }

  async clickNotificationAction(message: string, action: string): Promise<unknown> {
    return this.send('clickNotificationAction', { message, action });
  }

  async getProgressState(): Promise<ProgressState> {
    return this.send('getProgressState') as Promise<ProgressState>;
  }

  async getState(): Promise<VSCodeState> {
    return this.send('getState') as Promise<VSCodeState>;
  }

  async getNotifications(): Promise<NotificationInfo[]> {
    return this.send('getNotifications') as Promise<NotificationInfo[]>;
  }

  async getOutputChannel(name: string): Promise<{ name: string; content: string }> {
    return this.send('getOutputChannel', { name }) as Promise<{ name: string; content: string }>;
  }

  async getOutputChannels(): Promise<string[]> {
    return this.send('getOutputChannels') as Promise<string[]>;
  }

  /** Return every captured channel and its full content. */
  async getCapturedChannels(): Promise<Array<{ name: string; content: string }>> {
    return this.send('getCapturedChannels') as Promise<Array<{ name: string; content: string }>>;
  }

  /** Declare an output channel that should be captured. Switches to allow-list mode. */
  async startCaptureChannel(name: string): Promise<void> {
    await this.send('startCaptureChannel', { name });
  }

  /** Stop capturing a previously declared channel. */
  async stopCaptureChannel(name: string): Promise<void> {
    await this.send('stopCaptureChannel', { name });
  }

  /** Get the current byte offset of a captured channel - used for per-step diffs. */
  async getOutputChannelOffset(name: string): Promise<number> {
    const res = (await this.send('getOutputChannelOffset', { name })) as { offset: number };
    return res.offset;
  }

  /** Get output monitor diagnostics (patching results, Proxy status, etc). */
  async getDiagnostics(): Promise<{ diag: string[]; channelSummary: Record<string, number> }> {
    return this.send('getDiagnostics') as Promise<{ diag: string[]; channelSummary: Record<string, number> }>;
  }

  /** Get all output channel contents as a combined string. */
  async getAllOutputContent(): Promise<string> {
    const channels = await this.getOutputChannels();
    const parts: string[] = [];
    for (const name of channels) {
      const ch = await this.getOutputChannel(name);
      if (ch.content) parts.push(`[${name}]\n${ch.content}`);
    }
    return parts.join('\n');
  }

  async handleAuth(provider: string, credentials: Record<string, string>): Promise<unknown> {
    return this.send('handleAuth', { provider, credentials });
  }

  /** Return info about all open webview / custom-editor tabs. */
  async getWebviewTabs(): Promise<Array<{ label: string; isActive: boolean; viewType?: string }>> {
    return this.send('getWebviewTabs') as Promise<Array<{ label: string; isActive: boolean; viewType?: string }>>;
  }

  /** Activate (bring to front) a tab whose label contains the given substring. */
  async activateTab(title: string): Promise<string> {
    const res = (await this.send('activateTab', { title })) as { label: string };
    return res.label;
  }

  async ping(): Promise<unknown> {
    return this.send('ping');
  }

  async closeWindow(): Promise<void> {
    try {
      await this.send('closeWindow');
    } catch {
      // Dev Host may close before we get a response - that's fine
    }
  }

  async listCommands(filter?: string): Promise<string[]> {
    return this.send('listCommands', { filter }) as Promise<string[]>;
  }

  async getFullState(): Promise<unknown> {
    return this.send('getFullState');
  }

  async setLogLevel(level: string): Promise<void> {
    await this.send('setLogLevel', { level });
  }

  async getExtensionStatus(): Promise<Array<{ id: string; isActive: boolean }>> {
    return this.send('getExtensionStatus') as Promise<Array<{ id: string; isActive: boolean }>>;
  }

  async typeText(text: string): Promise<void> {
    await this.send('typeText', { text });
  }

  async openFile(filePath: string): Promise<void> {
    await this.send('openFile', { filePath });
  }

  async addWorkspaceFolder(folderPath: string): Promise<unknown> {
    return this.send('addWorkspaceFolder', { folderPath });
  }

  async pressKey(key: string): Promise<void> {
    await this.send('pressKey', { key });
  }

  async setSetting(key: string, value: unknown, target?: number): Promise<unknown> {
    return this.send('setSetting', { key, value, target });
  }

  async getSetting(key: string): Promise<{ key: string; value: unknown }> {
    return this.send('getSetting', { key }) as Promise<{ key: string; value: unknown }>;
  }

  async resetState(): Promise<void> {
    await this.send('resetState');
  }

  private send(method: string, params?: unknown, requestTimeoutMs = this.requestTimeoutMs): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected'));
        return;
      }
      const id = ++this.requestId;
      const request: ControllerRequest = { jsonrpc: '2.0', id, method, params };
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        if (p) { this.pending.delete(id); p.reject(new Error(`Request ${method} timed out`)); }
      }, requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(request));
    });
  }

  private handleMessage(data: string): void {
    try {
      const response = JSON.parse(data) as ControllerResponse;
      if (response.id !== undefined) {
        const p = this.pending.get(response.id);
        if (p) {
          this.pending.delete(response.id);
          clearTimeout(p.timer);
          if (response.error) p.reject(new Error(response.error.message));
          else p.resolve(response.result);
        }
      }
    } catch { /* ignore malformed */ }
  }
}
