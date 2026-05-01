import { describe, expect, it } from 'vitest';
import type { Command } from 'commander';

const { createProgram } = await import('../src/cli.js');

function isHidden(command: Command | undefined): boolean {
  return Boolean((command as unknown as { _hidden?: boolean } | undefined)?._hidden);
}

describe('CLI command registration', () => {
  it('shows the renamed setup commands and hides deprecated aliases', () => {
    const program = createProgram();
    const commands = new Map(program.commands.map((command) => [command.name(), command]));
    const visibleCommandNames = program.commands
      .filter((command) => !isHidden(command))
      .map((command) => command.name());

    expect(visibleCommandNames).toEqual(expect.arrayContaining([
      'run',
      'live',
      'install-into-project',
      'install-testing-extension-to-vscode',
      'install-testing-extension-to-profiles',
      'uninstall',
      'tests',
      'profile',
    ]));
    expect(visibleCommandNames).not.toEqual(expect.arrayContaining(['init', 'install', 'update']));
    expect(isHidden(commands.get('init'))).toBe(true);
    expect(isHidden(commands.get('install'))).toBe(true);
    expect(isHidden(commands.get('update'))).toBe(true);
  });

  it('keeps install-into-project options visible in help', () => {
    const program = createProgram();
    const installIntoProject = program.commands.find((command) => command.name() === 'install-into-project');
    const help = program.helpInformation();

    expect(installIntoProject?.options.some((option) => option.long === '--features')).toBe(true);
    expect(help).toContain('install-into-project');
    expect(help).toContain('install-testing-extension-to-vscode');
    expect(help).toContain('install-testing-extension-to-profiles');
    expect(help).not.toMatch(/\n\s+init(?:\s|$)/);
    expect(help).not.toMatch(/\n\s+install(?:\s|$)/);
    expect(help).not.toMatch(/\n\s+update(?:\s|$)/);
  });
});