import { WebSocketServer, WebSocket } from 'ws';
import type { CommandExecutor } from './command-executor.js';
import type { UIInterceptor } from './ui-interceptor.js';
import type { StateReader } from './state-reader.js';
import type { OutputMonitor } from './output-monitor.js';
import type { AuthHandler } from './auth-handler.js';

interface Services {
  commandExecutor: CommandExecutor;
  uiInterceptor: UIInterceptor;
  stateReader: StateReader;
  outputMonitor: OutputMonitor;
  authHandler: AuthHandler;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export class WSServer {
  private wss: WebSocketServer | undefined;
  private clients = new Set<WebSocket>();

  constructor(
    private readonly port: number,
    private readonly services: Services
  ) {}

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port: this.port }, () => resolve());
      this.wss.on('error', reject);
      this.wss.on('connection', (ws) => this.handleConnection(ws));
    });
  }

  stop(): void {
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    this.wss?.close();
    this.wss = undefined;
  }

  /** Broadcast an event notification to all connected clients. */
  broadcast(method: string, params?: unknown): void {
    const message = JSON.stringify({ jsonrpc: '2.0', method, params });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  private handleConnection(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    ws.on('message', async (data) => {
      try {
        const request = JSON.parse(data.toString()) as JsonRpcRequest;
        const result = await this.dispatch(request);
        ws.send(
          JSON.stringify({ jsonrpc: '2.0', id: request.id, result })
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const parsed = safeParse(data.toString());
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: parsed?.id ?? null,
            error: { code: -32603, message },
          })
        );
      }
    });
  }

  private async dispatch(request: JsonRpcRequest): Promise<unknown> {
    const { method, params } = request;
    const p = (params ?? {}) as Record<string, unknown>;

    switch (method) {
      // ─── Command execution ───
      case 'executeCommand': {
        return this.services.commandExecutor.execute(
          p['commandId'] as string,
          p['args'] as unknown[]
        );
      }

      // ─── Start command (fire-and-forget, for commands that show UI) ───
      case 'startCommand': {
        return this.services.commandExecutor.start(
          p['commandId'] as string,
          p['args'] as unknown[]
        );
      }

      // ─── Open file in editor (via code, no dialog) ───
      case 'openFile': {
        const vscode = require('vscode');
        const filePath = p['filePath'] as string;
        const uri = vscode.Uri.file(filePath);
        // Force VS Code to recognize the file on disk before opening
        // (file may have been created by an external process moments ago)
        const maxRetries = 10;
        for (let i = 0; i < maxRetries; i++) {
          try {
            await vscode.workspace.fs.stat(uri);
            break;
          } catch {
            if (i < maxRetries - 1) await delay(500);
            else throw new Error(`File not found: ${filePath}`);
          }
        }
        await vscode.commands.executeCommand('vscode.open', uri);
        return { opened: true };
      }

      // ─── Add folder to workspace (no reload) ───
      case 'addWorkspaceFolder': {
        const vscode = require('vscode');
        const folderPath = p['folderPath'] as string;
        const uri = vscode.Uri.file(folderPath);
        const index = vscode.workspace.workspaceFolders?.length ?? 0;
        const ok = vscode.workspace.updateWorkspaceFolders(index, null, { uri });
        if (!ok) throw new Error(`Failed to add workspace folder: ${folderPath}`);
        return { added: true, folderPath };
      }

      // ─── UI interaction ───
      case 'respondToQuickPick':
        return this.services.uiInterceptor.respondToQuickPick(
          p['label'] as string
        );
      case 'respondToInputBox':
        return this.services.uiInterceptor.respondToInputBox(
          p['value'] as string
        );
      case 'respondToDialog':
        return this.services.uiInterceptor.respondToDialog(
          p['button'] as string
        );

      // ─── State reading ───
      case 'getState':
        return this.services.stateReader.getState();
      case 'getNotifications':
        return this.services.stateReader.getNotifications();
      case 'getWebviewTabs':
        return this.services.stateReader.getWebviewTabs();
      case 'activateTab':
        return { label: await this.services.stateReader.activateTab(p['title'] as string) };

      // ─── Output monitoring ───
      case 'getOutputChannel':
        return this.services.outputMonitor.getContent(
          p['name'] as string
        );
      case 'getOutputChannels':
        return this.services.outputMonitor.listChannels();
      case 'readOutputChannel': {
        const name = p['name'] as string;
        const result = this.services.outputMonitor.getContent(name);
        return { name, content: result.content, captured: result.captured };
      }
      case 'getCapturedChannels':
        return this.services.outputMonitor.getCapturedChannels();
      case 'startCaptureChannel':
        this.services.outputMonitor.startCapture(p['name'] as string);
        return { status: 'ok' };
      case 'stopCaptureChannel':
        this.services.outputMonitor.stopCapture(p['name'] as string);
        return { status: 'ok' };
      case 'getOutputChannelOffset':
        return { offset: this.services.outputMonitor.getOffset(p['name'] as string) };

      // ─── Diagnostics ───
      case 'getDiagnostics':
        return this.services.outputMonitor.getDiagnostics();

      // ─── Auth ───
      case 'handleAuth':
        return this.services.authHandler.handleAuth(
          p['provider'] as string,
          p['credentials'] as Record<string, string>
        );

      // ─── Ping ───
      case 'ping':
        return { status: 'ok', timestamp: Date.now() };

      // ─── Close Dev Host window ───
      case 'closeWindow':
        setTimeout(() => {
          const vscode = require('vscode');
          vscode.commands.executeCommand('workbench.action.closeWindow');
        }, 500);
        return { status: 'closing' };

      // ─── Reset to clean state ───
      case 'resetState': {
        const vscode = require('vscode');
        // Close all editors
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        // Dismiss all notifications
        await vscode.commands.executeCommand('notifications.clearAll');
        // Close any open panels (terminal, output, etc.)
        await vscode.commands.executeCommand('workbench.action.closePanel');
        // Close any open sidebars
        await vscode.commands.executeCommand('workbench.action.closeSidebar');
        // Close any quick picks / input boxes
        await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
        // Clear tracked notifications
        this.services.stateReader.clearNotifications();
        return { status: 'reset' };
      }

      // ─── Input automation ───
      case 'typeText': {
        const vscode = require('vscode');
        const text = p['text'] as string;
        for (const char of text) {
          await vscode.commands.executeCommand('type', { text: char });
          await delay(20);
        }
        return { typed: text.length };
      }

      case 'pressKey': {
        const vscode = require('vscode');
        const key = p['key'] as string;
        const lower = key.toLowerCase();

        // Special cases that use the 'type' command
        if (lower === 'enter' || lower === 'return') {
          await vscode.commands.executeCommand('type', { text: '\n' });
        } else {
          const command = KEY_COMMAND_MAP[lower];
          if (command) {
            await vscode.commands.executeCommand(command);
          } else if (key.length === 1) {
            await vscode.commands.executeCommand('type', { text: key });
          } else {
            throw new Error(`Unknown key: "${key}". Use a VS Code command instead.`);
          }
        }
        return { pressed: key };
      }

      // ─── Agent tools ───
      case 'listCommands': {
        const vscode = require('vscode');
        const allCmds: string[] = await vscode.commands.getCommands(true);
        const cmdFilter = p['filter'] as string | undefined;
        return cmdFilter ? allCmds.filter((c: string) => c.includes(cmdFilter)) : allCmds;
      }

      case 'getFullState': {
        const state = await this.services.stateReader.getState();
        const channels = await this.services.outputMonitor.listChannels();
        return { ...state, outputChannels: channels };
      }

      case 'setLogLevel':
        return { status: 'ok', level: p['level'] };

      case 'getExtensionStatus': {
        const vscode = require('vscode');
        return vscode.extensions.all
          .filter((e: { id: string }) => !e.id.startsWith('vscode.'))
          .map((e: { id: string; isActive: boolean }) => ({ id: e.id, isActive: e.isActive }));
      }

      // ─── Settings ───
      case 'setSetting': {
        const vscode = require('vscode');
        const key = p['key'] as string;
        const value = p['value'];
        const target = (p['target'] as number) ?? vscode.ConfigurationTarget.Global;
        await vscode.workspace.getConfiguration().update(key, value, target);
        return { updated: true, key, value };
      }

      case 'getSetting': {
        const vscode = require('vscode');
        const key = p['key'] as string;
        const value = vscode.workspace.getConfiguration().get(key);
        return { key, value };
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }
}

function safeParse(data: string): { id?: number } | null {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Map key names (and combos) to VS Code commands.
 * This lets pressKey work without CDP.
 */
const KEY_COMMAND_MAP: Record<string, string> = {
  // Navigation
  'escape': 'workbench.action.closeQuickOpen',
  'esc': 'workbench.action.closeQuickOpen',
  'tab': 'tab',
  'shift+tab': 'outdent',
  'backspace': 'deleteLeft',
  'delete': 'deleteRight',
  'up': 'cursorUp',
  'down': 'cursorDown',
  'left': 'cursorLeft',
  'right': 'cursorRight',
  'arrowup': 'cursorUp',
  'arrowdown': 'cursorDown',
  'arrowleft': 'cursorLeft',
  'arrowright': 'cursorRight',
  'home': 'cursorHome',
  'end': 'cursorEnd',
  'pageup': 'cursorPageUp',
  'pagedown': 'cursorPageDown',
  'ctrl+home': 'cursorTop',
  'ctrl+end': 'cursorBottom',

  // Selection
  'shift+up': 'cursorUpSelect',
  'shift+down': 'cursorDownSelect',
  'shift+left': 'cursorLeftSelect',
  'shift+right': 'cursorRightSelect',
  'shift+home': 'cursorHomeSelect',
  'shift+end': 'cursorEndSelect',
  'ctrl+shift+home': 'cursorTopSelect',
  'ctrl+shift+end': 'cursorBottomSelect',
  'ctrl+shift+left': 'cursorWordLeftSelect',
  'ctrl+shift+right': 'cursorWordRightSelect',
  'ctrl+a': 'editor.action.selectAll',
  'ctrl+l': 'expandLineSelection',
  'ctrl+d': 'editor.action.addSelectionToNextFindMatch',

  // Word navigation
  'ctrl+left': 'cursorWordLeft',
  'ctrl+right': 'cursorWordRight',

  // Editing
  'ctrl+z': 'undo',
  'ctrl+shift+z': 'redo',
  'ctrl+y': 'redo',
  'ctrl+c': 'editor.action.clipboardCopyAction',
  'ctrl+v': 'editor.action.clipboardPasteAction',
  'ctrl+x': 'editor.action.clipboardCutAction',
  'ctrl+shift+k': 'editor.action.deleteLines',
  'ctrl+enter': 'editor.action.insertLineAfter',
  'shift+enter': 'editor.action.insertLineAfter',
  'ctrl+shift+enter': 'editor.action.insertLineBefore',
  'alt+up': 'editor.action.moveLinesUpAction',
  'alt+down': 'editor.action.moveLinesDownAction',
  'alt+shift+up': 'editor.action.copyLinesUpAction',
  'alt+shift+down': 'editor.action.copyLinesDownAction',
  'ctrl+]': 'editor.action.indentLines',
  'ctrl+[': 'editor.action.outdentLines',
  'ctrl+/': 'editor.action.commentLine',
  'ctrl+shift+a': 'editor.action.blockComment',

  // IntelliSense & suggestions
  'ctrl+space': 'editor.action.triggerSuggest',
  'ctrl+shift+space': 'editor.action.triggerParameterHints',

  // Search & replace
  'ctrl+f': 'actions.find',
  'ctrl+h': 'editor.action.startFindReplaceAction',
  'f3': 'editor.action.nextMatchFindAction',
  'shift+f3': 'editor.action.previousMatchFindAction',
  'ctrl+g': 'workbench.action.gotoLine',

  // Files & panels
  'ctrl+s': 'workbench.action.files.save',
  'ctrl+shift+s': 'workbench.action.files.saveAll',
  'ctrl+p': 'workbench.action.quickOpen',
  'ctrl+shift+p': 'workbench.action.showCommands',
  'ctrl+b': 'workbench.action.toggleSidebarVisibility',
  'ctrl+j': 'workbench.action.togglePanel',
  'ctrl+`': 'workbench.action.terminal.toggleTerminal',
  'ctrl+\\': 'workbench.action.splitEditor',
  'ctrl+w': 'workbench.action.closeActiveEditor',
  'ctrl+shift+t': 'workbench.action.reopenClosedEditor',
  'ctrl+tab': 'workbench.action.openNextRecentlyUsedEditor',
  'ctrl+shift+tab': 'workbench.action.openPreviousRecentlyUsedEditor',
  'ctrl+k ctrl+w': 'workbench.action.closeAllEditors',
  'ctrl+shift+n': 'workbench.action.newWindow',
  'ctrl+shift+e': 'workbench.view.explorer',
  'ctrl+shift+f': 'workbench.view.search',
  'ctrl+shift+g': 'workbench.view.scm',
  'ctrl+shift+d': 'workbench.view.debug',
  'ctrl+shift+x': 'workbench.view.extensions',

  // Code actions
  'f1': 'workbench.action.showCommands',
  'f2': 'editor.action.rename',
  'f5': 'workbench.action.debug.continue',
  'shift+f5': 'workbench.action.debug.stop',
  'f8': 'editor.action.marker.nextInFiles',
  'shift+f8': 'editor.action.marker.prevInFiles',
  'f9': 'editor.debug.action.toggleBreakpoint',
  'f10': 'workbench.action.debug.stepOver',
  'f11': 'workbench.action.debug.stepInto',
  'shift+f11': 'workbench.action.debug.stepOut',
  'f12': 'editor.action.revealDefinition',
  'alt+f12': 'editor.action.peekDefinition',
  'ctrl+.': 'editor.action.quickFix',
  'ctrl+shift+i': 'editor.action.formatDocument',
  'ctrl+k ctrl+f': 'editor.action.formatSelection',
  'ctrl+shift+o': 'workbench.action.gotoSymbol',
  'ctrl+t': 'workbench.action.showAllSymbols',

  // Zoom
  'ctrl+=': 'workbench.action.zoomIn',
  'ctrl+-': 'workbench.action.zoomOut',
  'ctrl+0': 'workbench.action.zoomReset',

  // Folding
  'ctrl+shift+[': 'editor.fold',
  'ctrl+shift+]': 'editor.unfold',
  'ctrl+k ctrl+0': 'editor.foldAll',
  'ctrl+k ctrl+j': 'editor.unfoldAll',

  // Multi-cursor
  'ctrl+alt+up': 'editor.action.insertCursorAbove',
  'ctrl+alt+down': 'editor.action.insertCursorBelow',
  'ctrl+shift+l': 'editor.action.selectHighlights',
};
