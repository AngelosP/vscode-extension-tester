import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cp from 'node:child_process';
import type { ControllerClient } from '../runner/controller-client.js';
import type { ToolDefinition } from './llm.js';
import { CDP_PORT } from '../types.js';
import { readMemory, writeMemory, appendMemory } from './memory.js';
import { GherkinParser } from '../runner/gherkin-parser.js';
import { TestRunner } from '../runner/test-runner.js';

// ─── Tool Context ───────────────────────────────────────────────────────────────

export interface ToolContext {
  cwd: string;
  controllerClient?: ControllerClient;
  env: Record<string, string>;
  cdpPort?: number;
  targetPid?: number;
}

// ─── Tool Definitions ───────────────────────────────────────────────────────────

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'execute_command',
      description: 'Execute a VS Code command in the running extension. Returns the command result or error.',
      parameters: {
        type: 'object',
        properties: {
          commandId: { type: 'string', description: 'The VS Code command ID to execute' },
          args: { type: 'array', items: {}, description: 'Optional arguments to pass to the command' },
        },
        required: ['commandId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_command',
      description: 'Start a VS Code command without waiting for it to complete. Use this for commands that show InputBox or QuickPick dialogs, then use respond_to_inputbox or respond_to_quickpick to interact with the dialog.',
      parameters: {
        type: 'object',
        properties: {
          commandId: { type: 'string', description: 'The VS Code command ID to start' },
          args: { type: 'array', items: {}, description: 'Optional arguments to pass to the command' },
        },
        required: ['commandId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_state',
      description: 'Get the current VS Code state: active editor, terminals, notifications, and panels.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_commands',
      description: 'List all registered VS Code commands. Optionally filter by substring.',
      parameters: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: 'Optional substring to filter commands by' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_notifications',
      description: 'Get all accumulated VS Code notifications.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_output_channel',
      description: 'Read the content of a VS Code output channel by name.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The output channel name' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'respond_to_quickpick',
      description: 'Select an item from an open QuickPick dialog.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'The label of the item to select' },
        },
        required: ['label'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'respond_to_inputbox',
      description: 'Type a value into an open InputBox dialog.',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'string', description: 'The text to enter' },
        },
        required: ['value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'respond_to_dialog',
      description: 'Click a button on an open dialog.',
      parameters: {
        type: 'object',
        properties: {
          button: { type: 'string', description: 'The button label to click' },
        },
        required: ['button'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'select_popup_item',
      description: 'Select an item from an open popup menu, context menu, or dropdown overlay. Use this for any popup that is NOT a standard QuickPick or InputBox — e.g. right-click context menus, editor picker dropdowns, or split-button menus. Uses OS-level UI Automation (FlaUI) with CDP fallback.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'The label (or partial text) of the item to select' },
        },
        required: ['label'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_mouse',
      description: 'Move the OS mouse cursor to absolute screen coordinates. Prefer stable selectors or accessible names for clicks; use raw coordinates only when no semantic target exists.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Absolute screen X coordinate' },
          y: { type: 'number', description: 'Absolute screen Y coordinate' },
          reason: { type: 'string', description: 'Why raw coordinates are needed instead of a selector or accessible name' },
        },
        required: ['x', 'y'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click',
      description: 'Click using the most reliable target available: webview selector, accessible name, screen coordinates, or current mouse position. Supports left/right/middle and double-clicks.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', enum: ['webviewSelector', 'accessibleName', 'coordinates', 'currentPosition'], description: 'How to target the click' },
          selector: { type: 'string', description: 'CSS selector when target=webviewSelector' },
          webviewTitle: { type: 'string', description: 'Optional webview title substring to disambiguate' },
          name: { type: 'string', description: 'Accessible name/text when target=accessibleName' },
          controlType: { type: 'string', description: 'Optional accessibility control type, e.g. button, edit, menuitem' },
          x: { type: 'number', description: 'Absolute screen X coordinate when target=coordinates' },
          y: { type: 'number', description: 'Absolute screen Y coordinate when target=coordinates' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button' },
          clickCount: { type: 'number', description: '1 for click, 2 for double-click' },
          reason: { type: 'string', description: 'Why coordinates/current position are needed when using raw mouse targeting' },
        },
        required: ['target'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'press_key',
      description: 'Send a keyboard key or key combination to the focused target, using CDP real key events with controller fallback for VS Code command-style chords.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key or combo, e.g. Enter, Escape, Ctrl+S, Shift+Tab' },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'type_text',
      description: 'Type or insert text into the currently focused editor, input, or webview control using CDP with controller fallback.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to type' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_source_file',
      description: 'Read a source file from the extension project. Path is relative to the project root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the file (e.g. src/extension.ts)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_source_files',
      description: 'List files in the extension project directory. Returns file paths relative to project root.',
      parameters: {
        type: 'object',
        properties: {
          directory: { type: 'string', description: 'Directory to list (default: src/)' },
          pattern: { type: 'string', description: 'Glob-like filter pattern (e.g. "*.ts")' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_memory',
      description: 'Read a memory file from previous sessions. Returns stored knowledge about this extension.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Memory filename (e.g. extension-analysis.md)' },
        },
        required: ['filename'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_memory',
      description: 'Write or overwrite a memory file to persist knowledge for future sessions.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Memory filename (e.g. extension-analysis.md)' },
          content: { type: 'string', description: 'Full content to write' },
        },
        required: ['filename', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_memory',
      description: 'Append an entry to a memory file with a timestamp.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Memory filename' },
          entry: { type: 'string', description: 'The entry to append' },
        },
        required: ['filename', 'entry'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_feature_file',
      description: 'Read an existing .feature test file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the .feature file' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_feature_file',
      description: 'Write a .feature test file. Creates directories if needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path for the .feature file' },
          content: { type: 'string', description: 'Full Gherkin content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_test',
      description: 'Execute a specific .feature file and return the test results.',
      parameters: {
        type: 'object',
        properties: {
          featurePath: { type: 'string', description: 'Relative path to the .feature file to run' },
        },
        required: ['featurePath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_log_level',
      description: 'Change the controller extension log level for more detailed diagnostics.',
      parameters: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['error', 'warn', 'info', 'debug', 'trace'], description: 'Log level' },
        },
        required: ['level'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Get the git diff showing recent changes to the extension codebase.',
      parameters: {
        type: 'object',
        properties: {
          since: { type: 'string', description: 'Git ref to diff against (default: auto-detect)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_log',
      description: 'Get recent git commit log messages.',
      parameters: {
        type: 'object',
        properties: {
          count: { type: 'number', description: 'Number of commits to show (default: 10)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description: 'Signal that you have completed the task. Provide a summary of what was accomplished.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Summary of what was done' },
        },
        required: ['summary'],
      },
    },
  },
];

// ─── Tool Execution ─────────────────────────────────────────────────────────────

export async function executeToolCall(
  name: string,
  argsJson: string,
  ctx: ToolContext,
): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson);
  } catch {
    return `Error: Invalid JSON arguments: ${argsJson}`;
  }

  try {
    switch (name) {
      case 'execute_command':
        return await toolExecuteCommand(ctx, args);
      case 'start_command':
        return await toolStartCommand(ctx, args);
      case 'get_state':
        return await toolGetState(ctx);
      case 'list_commands':
        return await toolListCommands(ctx, args);
      case 'get_notifications':
        return await toolGetNotifications(ctx);
      case 'get_output_channel':
        return await toolGetOutputChannel(ctx, args);
      case 'respond_to_quickpick':
        return await toolRespondToQuickPick(ctx, args);
      case 'respond_to_inputbox':
        return await toolRespondToInputBox(ctx, args);
      case 'respond_to_dialog':
        return await toolRespondToDialog(ctx, args);
      case 'select_popup_item':
        return await toolSelectPopupItem(ctx, args);
      case 'move_mouse':
        return await toolMoveMouse(ctx, args);
      case 'click':
        return await toolClick(ctx, args);
      case 'press_key':
        return await toolPressKey(ctx, args);
      case 'type_text':
        return await toolTypeText(ctx, args);
      case 'read_source_file':
        return toolReadSourceFile(ctx, args);
      case 'list_source_files':
        return toolListSourceFiles(ctx, args);
      case 'read_memory':
        return toolReadMemory(ctx, args);
      case 'write_memory':
        return toolWriteMemory(ctx, args);
      case 'append_memory':
        return toolAppendMemory(ctx, args);
      case 'read_feature_file':
        return toolReadFeatureFile(ctx, args);
      case 'write_feature_file':
        return toolWriteFeatureFile(ctx, args);
      case 'run_test':
        return await toolRunTest(ctx, args);
      case 'set_log_level':
        return await toolSetLogLevel(ctx, args);
      case 'git_diff':
        return toolGitDiff(ctx, args);
      case 'git_log':
        return toolGitLog(ctx, args);
      case 'done':
        return `Task completed: ${args['summary']}`;
      default:
        return `Error: Unknown tool "${name}"`;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error executing ${name}: ${msg}`;
  }
}

// ─── Controller Tools (require Dev Host connection) ─────────────────────────────

function requireClient(ctx: ToolContext): ControllerClient {
  if (!ctx.controllerClient) {
    throw new Error('Dev Host not connected. Start the Extension Development Host (F5) first, or use --no-explore.');
  }
  return ctx.controllerClient;
}

async function toolExecuteCommand(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const client = requireClient(ctx);
  const result = await client.executeCommand(args['commandId'] as string, args['args'] as unknown[] | undefined);
  return JSON.stringify(result ?? { status: 'ok' });
}

async function toolStartCommand(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const client = requireClient(ctx);
  const result = await client.startCommand(args['commandId'] as string, args['args'] as unknown[] | undefined);
  return JSON.stringify(result ?? { status: 'ok' });
}

async function toolGetState(ctx: ToolContext): Promise<string> {
  const client = requireClient(ctx);
  const state = await client.getState();
  return JSON.stringify(state, null, 2);
}

async function toolListCommands(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const client = requireClient(ctx);
  const cmds = await client.listCommands(args['filter'] as string | undefined);
  return cmds.join('\n');
}

async function toolGetNotifications(ctx: ToolContext): Promise<string> {
  const client = requireClient(ctx);
  const notifications = await client.getNotifications();
  return JSON.stringify(notifications, null, 2);
}

async function toolGetOutputChannel(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const client = requireClient(ctx);
  const output = await client.getOutputChannel(args['name'] as string);
  return JSON.stringify(output);
}

async function toolRespondToQuickPick(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const client = requireClient(ctx);
  await client.respondToQuickPick(args['label'] as string);
  return 'QuickPick item selected';
}

async function toolRespondToInputBox(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const client = requireClient(ctx);
  await client.respondToInputBox(args['value'] as string);
  return 'InputBox value entered';
}

async function toolRespondToDialog(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const client = requireClient(ctx);
  await client.respondToDialog(args['button'] as string);
  return 'Dialog button clicked';
}

async function toolSelectPopupItem(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const label = args['label'] as string;
  // Delegate to the test runner's popup dispatch logic: FlaUI first, CDP fallback.
  // We import NativeUIClient and CdpClient lazily to avoid circular deps.
  const { NativeUIClient } = await import('../runner/native-ui-client.js');
  const { CdpClient } = await import('../runner/cdp-client.js');

  // Strategy 1: FlaUI (OS-level — works when popup steals focus from webview)
  const nativeUI = new NativeUIClient();
  nativeUI.targetPid = ctx.targetPid;
  try {
    await nativeUI.start();
    const selected = await nativeUI.selectFromDevHostPopup(label, 3000);
    nativeUI.stop();
    return `Selected popup item: ${selected}`;
  } catch {
    nativeUI.stop();
  }

  // Strategy 2: CDP (DOM-level — works for monaco-list overlays)
  const cdp = new CdpClient(ctx.cdpPort ?? CDP_PORT);
  try {
    await cdp.connect();
    await cdp.selectPopupMenuItem(label);
    cdp.disconnect();
    return `Selected popup item: ${label}`;
  } catch (err) {
    cdp.disconnect();
    throw err;
  }
}

async function toolMoveMouse(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const { NativeUIClient } = await import('../runner/native-ui-client.js');
  const nativeUI = new NativeUIClient();
  nativeUI.targetPid = ctx.targetPid;
  try {
    await nativeUI.start();
    await nativeUI.moveMouse(requiredNumber(args, 'x'), requiredNumber(args, 'y'));
    return `Mouse moved to ${args['x']}, ${args['y']}`;
  } finally {
    nativeUI.stop();
  }
}

async function toolClick(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const target = args['target'] as string;
  const button = normalizeButton(args['button']);
  const clickCount = args['clickCount'] === undefined ? 1 : requiredNumber(args, 'clickCount');

  if ((target === 'coordinates' || target === 'currentPosition') && !args['reason']) {
    throw new Error('Raw mouse targeting requires a reason. Prefer webviewSelector or accessibleName when possible.');
  }

  if (target === 'webviewSelector') {
    const selector = requiredString(args, 'selector');
    const { CdpClient } = await import('../runner/cdp-client.js');
    const cdp = new CdpClient(ctx.cdpPort ?? CDP_PORT);
    if (ctx.controllerClient) {
      cdp.onActivateTab = async (title: string) => {
        await ctx.controllerClient!.activateTab(title);
      };
    }
    try {
      await cdp.connect();
      await cdp.clickInWebviewBySelector(selector, args['webviewTitle'] as string | undefined, { button, clickCount });
      return `${button} click sent to webview selector: ${selector}`;
    } finally {
      cdp.disconnect();
    }
  }

  const { NativeUIClient } = await import('../runner/native-ui-client.js');
  const nativeUI = new NativeUIClient();
  nativeUI.targetPid = ctx.targetPid;
  try {
    await nativeUI.start();
    if (target === 'accessibleName') {
      const name = requiredString(args, 'name');
      await nativeUI.clickInDevHost(name, args['controlType'] as string | undefined, { button, clickCount });
      return `${button} click sent to accessible element: ${name}`;
    }
    if (target === 'coordinates') {
      await nativeUI.clickMouse(requiredNumber(args, 'x'), requiredNumber(args, 'y'), { button, clickCount });
      return `${button} click sent to ${args['x']}, ${args['y']}`;
    }
    if (target === 'currentPosition') {
      await nativeUI.clickMouse(undefined, undefined, { button, clickCount });
      return `${button} click sent at current mouse position`;
    }
    throw new Error(`Unknown click target: ${target}`);
  } finally {
    nativeUI.stop();
  }
}

async function toolPressKey(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const key = requiredString(args, 'key');

  if (!key.includes(' ')) {
    const { CdpClient } = await import('../runner/cdp-client.js');
    const cdp = new CdpClient(ctx.cdpPort ?? CDP_PORT);
    try {
      await cdp.connect();
      await cdp.pressKey(key);
      cdp.disconnect();
      return `Pressed key: ${key}`;
    } catch {
      cdp.disconnect();
    }
  }

  const client = requireClient(ctx);
  await client.pressKey(key);
  return `Pressed key via controller fallback: ${key}`;
}

async function toolTypeText(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const text = requiredString(args, 'text');
  const { CdpClient } = await import('../runner/cdp-client.js');
  const cdp = new CdpClient(ctx.cdpPort ?? CDP_PORT);
  try {
    await cdp.connect();
    await cdp.insertText(text);
    cdp.disconnect();
    return `Typed text (${text.length} chars)`;
  } catch {
    cdp.disconnect();
  }

  const client = requireClient(ctx);
  await client.typeText(text);
  return `Typed text via controller fallback (${text.length} chars)`;
}

async function toolSetLogLevel(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const client = requireClient(ctx);
  await client.setLogLevel(args['level'] as string);
  return `Log level set to ${args['level']}`;
}

// ─── Local Tools (no Dev Host needed) ───────────────────────────────────────────

function toolReadSourceFile(ctx: ToolContext, args: Record<string, unknown>): string {
  const relPath = args['path'] as string;
  const absPath = path.resolve(ctx.cwd, relPath);

  // Security: ensure path is within project
  if (!absPath.startsWith(ctx.cwd)) {
    return 'Error: Path is outside the project directory';
  }

  if (!fs.existsSync(absPath)) {
    return `Error: File not found: ${relPath}`;
  }

  const content = fs.readFileSync(absPath, 'utf-8');
  // Truncate very large files
  if (content.length > 10000) {
    return content.slice(0, 10000) + '\n\n... (truncated, file is ' + content.length + ' chars)';
  }
  return content;
}

function toolListSourceFiles(ctx: ToolContext, args: Record<string, unknown>): string {
  const dir = args['directory'] as string ?? 'src';
  const pattern = args['pattern'] as string | undefined;
  const absDir = path.resolve(ctx.cwd, dir);

  if (!absDir.startsWith(ctx.cwd)) {
    return 'Error: Path is outside the project directory';
  }

  if (!fs.existsSync(absDir)) {
    return `Error: Directory not found: ${dir}`;
  }

  const files = listFilesRecursive(absDir, 50);
  let result = files.map((f) => path.relative(ctx.cwd, f));

  if (pattern) {
    const regex = new RegExp(pattern.replace(/\*/g, '.*').replace(/\?/g, '.'), 'i');
    result = result.filter((f) => regex.test(f));
  }

  return result.join('\n') || '(no files found)';
}

function toolReadMemory(ctx: ToolContext, args: Record<string, unknown>): string {
  const content = readMemory(ctx.cwd, args['filename'] as string);
  return content ?? '(memory file not found)';
}

function toolWriteMemory(ctx: ToolContext, args: Record<string, unknown>): string {
  writeMemory(ctx.cwd, args['filename'] as string, args['content'] as string);
  return 'Memory file written';
}

function toolAppendMemory(ctx: ToolContext, args: Record<string, unknown>): string {
  appendMemory(ctx.cwd, args['filename'] as string, args['entry'] as string);
  return 'Entry appended to memory file';
}

function toolReadFeatureFile(ctx: ToolContext, args: Record<string, unknown>): string {
  const relPath = args['path'] as string;
  const absPath = path.resolve(ctx.cwd, relPath);

  if (!absPath.startsWith(ctx.cwd)) return 'Error: Path is outside the project directory';
  if (!fs.existsSync(absPath)) return `Error: File not found: ${relPath}`;

  return fs.readFileSync(absPath, 'utf-8');
}

function toolWriteFeatureFile(ctx: ToolContext, args: Record<string, unknown>): string {
  const relPath = args['path'] as string;
  const absPath = path.resolve(ctx.cwd, relPath);

  if (!absPath.startsWith(ctx.cwd)) return 'Error: Path is outside the project directory';

  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, args['content'] as string, 'utf-8');
  return `Feature file written: ${relPath}`;
}

async function toolRunTest(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const client = requireClient(ctx);
  const featurePath = path.resolve(ctx.cwd, args['featurePath'] as string);

  if (!fs.existsSync(featurePath)) {
    return `Error: Feature file not found: ${args['featurePath']}`;
  }

  const parser = new GherkinParser();
  const runner = new TestRunner(client, ctx.env, undefined, undefined, ctx.cdpPort, ctx.targetPid);
  const feature = await parser.parseFile(featurePath);
  const result = await runner.runFeature(feature);

  return JSON.stringify(result, null, 2);
}

function toolGitDiff(ctx: ToolContext, args: Record<string, unknown>): string {
  const since = args['since'] as string | undefined;
  const ref = since ?? detectGitRef(ctx.cwd);

  try {
    const output = cp.execSync(`git diff ${ref}`, {
      cwd: ctx.cwd,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (output.length > 15000) {
      return output.slice(0, 15000) + '\n\n... (truncated)';
    }
    return output || '(no changes)';
  } catch {
    return '(git diff failed - not a git repository or no commits)';
  }
}

function toolGitLog(ctx: ToolContext, args: Record<string, unknown>): string {
  const count = (args['count'] as number) ?? 10;
  try {
    return cp.execSync(`git log --oneline -${count}`, {
      cwd: ctx.cwd,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return '(git log failed)';
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function detectGitRef(cwd: string): string {
  try {
    const branch = cp.execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (branch === 'main' || branch === 'master') {
      return 'HEAD~1';
    }

    // Try origin/main, then origin/master
    for (const base of ['origin/main', 'origin/master', 'main', 'master']) {
      try {
        cp.execSync(`git rev-parse ${base}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        return base;
      } catch { /* try next */ }
    }

    return 'HEAD~1';
  } catch {
    return 'HEAD~1';
  }
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required string argument: ${name}`);
  }
  return value;
}

function requiredNumber(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Missing required number argument: ${name}`);
  }
  return value;
}

function normalizeButton(value: unknown): 'left' | 'right' | 'middle' {
  if (value === undefined) return 'left';
  if (value === 'left' || value === 'right' || value === 'middle') return value;
  throw new Error(`Unknown mouse button: ${String(value)}`);
}

function listFilesRecursive(dir: string, maxFiles: number): string[] {
  const results: string[] = [];
  const walk = (d: string) => {
    if (results.length >= maxFiles) return;
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      const full = path.join(d, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== 'out') {
        walk(full);
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  };
  walk(dir);
  return results;
}
