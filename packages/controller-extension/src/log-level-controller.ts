import * as vscode from 'vscode';

export type LogLevelName = 'Trace' | 'Debug' | 'Info' | 'Warning' | 'Error' | 'Off';

export interface GlobalLogLevelResult {
  status: 'ok';
  scope: 'global';
  actualLevel: LogLevelName;
}

export interface ChannelLogLevelResult {
  status: 'applied';
  scope: 'channel';
  channel: string;
  channelCommand: string;
}

export type SetLogLevelResult = GlobalLogLevelResult | ChannelLogLevelResult;

const SHOW_OUTPUT_PREFIX = 'workbench.action.output.show.';
const LEVEL_COMMANDS: Record<LogLevelName, string> = {
  Off: 'workbench.action.output.activeOutputLogLevel.0',
  Trace: 'workbench.action.output.activeOutputLogLevel.1',
  Debug: 'workbench.action.output.activeOutputLogLevel.2',
  Info: 'workbench.action.output.activeOutputLogLevel.3',
  Warning: 'workbench.action.output.activeOutputLogLevel.4',
  Error: 'workbench.action.output.activeOutputLogLevel.5',
};

export class LogLevelController {
  async setLogLevel(levelValue: string, channel?: string): Promise<SetLogLevelResult> {
    const level = parseLogLevel(levelValue);
    if (channel) {
      const channelCommand = await this.findChannelCommand(channel);
      await vscode.commands.executeCommand(channelCommand);
      await vscode.commands.executeCommand(LEVEL_COMMANDS[level]);
      return { status: 'applied', scope: 'channel', channel, channelCommand };
    }

    await vscode.commands.executeCommand('_extensionTests.setLogLevel', level.toLowerCase());
    const actualLevel = await this.getGlobalLogLevel();
    if (actualLevel !== level) {
      throw new Error(
        `VS Code did not apply global log level ${level}; actual level is ${actualLevel}. ` +
        'The runner must use the workbench log-level fallback for this Dev Host.',
      );
    }
    return { status: 'ok', scope: 'global', actualLevel };
  }

  async getGlobalLogLevel(): Promise<LogLevelName> {
    const level = await vscode.commands.executeCommand<string>('_extensionTests.getLogLevel');
    return parseLogLevel(level);
  }

  private async findChannelCommand(channel: string, timeoutMs = 10_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let matches: string[] = [];
    do {
      const commands = await vscode.commands.getCommands(true);
      matches = commands.filter((command) => commandMatchesChannel(command, channel));
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        throw new Error(`Output channel "${channel}" is ambiguous. Matching commands: ${matches.join(', ')}`);
      }
      if (Date.now() < deadline) await delay(100);
    } while (Date.now() < deadline);

    if (matches.length > 1) {
      throw new Error(`Output channel "${channel}" is ambiguous. Matching commands: ${matches.join(', ')}`);
    }
    throw new Error(
      `Log output channel "${channel}" was not found within ${timeoutMs}ms. ` +
      'Activate the extension so VS Code registers the channel before setting its log level.',
    );
  }
}

export function parseLogLevel(value: string): LogLevelName {
  const normalized = String(value ?? '').trim().toLowerCase();
  switch (normalized) {
    case 'trace': return 'Trace';
    case 'debug': return 'Debug';
    case 'info': return 'Info';
    case 'warning':
    case 'warn': return 'Warning';
    case 'error': return 'Error';
    case 'off': return 'Off';
    default:
      throw new Error(`Unsupported log level "${value}". Use Trace, Debug, Info, Warning, Error, or Off.`);
  }
}

function commandMatchesChannel(command: string, channel: string): boolean {
  if (!command.startsWith(SHOW_OUTPUT_PREFIX)) return false;
  const channelId = command.slice(SHOW_OUTPUT_PREFIX.length);
  const logFileName = channel.replace(/[\\/:*?"<>|]/g, '');
  return channelId === channel
    || channelId.endsWith(`-${channel}`)
    || channelId.endsWith(`.${logFileName}.log`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
