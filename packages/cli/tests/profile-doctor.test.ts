import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { mockResolveVSCodeCli, mockGetVSCodeCliMetadata } = vi.hoisted(() => ({
  mockResolveVSCodeCli: vi.fn(),
  mockGetVSCodeCliMetadata: vi.fn(),
}));

vi.mock('../src/utils/vscode-cli.js', () => ({
  resolveVSCodeCli: mockResolveVSCodeCli,
  getVSCodeCliMetadata: mockGetVSCodeCliMetadata,
  formatVSCodeCliMissingMessage: () => 'VS Code CLI not found.',
}));

const { collectProfileDoctorReports } = await import('../src/profile.js');

describe('profile doctor', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-ext-test-profile-doctor-'));
    mockResolveVSCodeCli.mockReset();
    mockGetVSCodeCliMetadata.mockReset();
    mockResolveVSCodeCli.mockReturnValue({
      command: 'code.cmd',
      displayName: 'VS Code',
      source: 'path',
      variant: 'stable',
      requiresShell: true,
    });
    mockGetVSCodeCliMetadata.mockReturnValue({
      command: 'code.cmd',
      displayName: 'VS Code',
      source: 'path',
      variant: 'stable',
      version: '1.121.0',
      executablePath: 'C:\\VS Code\\Code.exe',
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports legacy metadata, controller presence, and GitHub auth markers without reading values', () => {
    const profileDir = path.join(tempDir, 'tests', 'vscode-extension-tester', 'profiles', 'auth');
    const userDataDir = path.join(profileDir, 'user-data');
    const extensionsDir = path.join(profileDir, 'extensions');
    fs.mkdirSync(path.join(userDataDir, 'User', 'globalStorage'), { recursive: true });
    fs.mkdirSync(path.join(extensionsDir, 'controller'), { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'profile.json'), JSON.stringify({ name: 'auth', created: '2026-05-01T00:00:00.000Z' }), 'utf-8');
    fs.writeFileSync(path.join(extensionsDir, 'controller', 'package.json'), JSON.stringify({ publisher: 'vscode-extension-tester', name: 'vscode-extension-tester-controller' }), 'utf-8');
    fs.writeFileSync(
      path.join(userDataDir, 'User', 'globalStorage', 'state.vscdb'),
      'secret://{"extensionId":"vscode.github-authentication","key":"github.auth"} encrypted-value-redacted',
      'utf-8',
    );

    const [report] = collectProfileDoctorReports(['auth'], tempDir);

    expect(report.controllerInstalled).toBe(true);
    expect(report.auth.githubAuthSecretMarkers).toBe(1);
    expect(report.warnings).toContain('Profile has legacy metadata; run `vscode-ext-test profile doctor --fix` to stamp the current VS Code install.');
    expect(JSON.stringify(report)).not.toContain('encrypted-value-redacted');
  });

  it('accepts GitHub runtime session logs when the legacy state marker is absent', () => {
    const profileDir = path.join(tempDir, 'tests', 'vscode-extension-tester', 'profiles', 'github-runtime');
    const userDataDir = path.join(profileDir, 'user-data');
    fs.mkdirSync(path.join(userDataDir, 'User', 'globalStorage'), { recursive: true });
    const githubLogDir = path.join(userDataDir, 'logs', '20260521T131719', 'window1', 'exthost', 'vscode.github-authentication');
    const copilotLogDir = path.join(userDataDir, 'logs', '20260521T131719', 'window1', 'exthost', 'GitHub.copilot-chat');
    fs.mkdirSync(githubLogDir, { recursive: true });
    fs.mkdirSync(copilotLogDir, { recursive: true });
    fs.mkdirSync(path.join(profileDir, 'extensions'), { recursive: true });
    fs.writeFileSync(path.join(userDataDir, 'User', 'globalStorage', 'state.vscdb'), 'github-authentication metadata only', 'utf-8');
    fs.writeFileSync(
      path.join(githubLogDir, 'GitHub Authentication.log'),
      'Login success!\nGot 1 verified sessions.\nGot 1 sessions for read:user,repo,user:email,workflow...',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(copilotLogDir, 'GitHub Copilot Chat.log'),
      'Got Copilot token for user-redacted',
      'utf-8',
    );

    const [report] = collectProfileDoctorReports(['github-runtime'], tempDir);

    expect(report.auth.githubAuthSecretMarkers).toBe(0);
    expect(report.auth.githubAuthLogLastSessionCount).toBe(1);
    expect(report.auth.githubAuthLogLoginSuccess).toBe(true);
    expect(report.auth.copilotTokenSeen).toBe(true);
    expect(report.warnings).not.toContain('No GitHub/Copilot authentication session found for this profile. If this profile should use Copilot, open it and sign in to GitHub.');
  });

  it('treats latest Copilot sign-in failure as unhealthy even with old auth markers', () => {
    const profileDir = path.join(tempDir, 'tests', 'vscode-extension-tester', 'profiles', 'stale-auth');
    const userDataDir = path.join(profileDir, 'user-data');
    const githubLogDir = path.join(userDataDir, 'logs', '20260521T133949', 'window1', 'exthost', 'vscode.github-authentication');
    const copilotLogDir = path.join(userDataDir, 'logs', '20260521T133949', 'window1', 'exthost', 'GitHub.copilot-chat');
    fs.mkdirSync(path.join(userDataDir, 'User', 'globalStorage'), { recursive: true });
    fs.mkdirSync(path.join(profileDir, 'extensions'), { recursive: true });
    fs.mkdirSync(githubLogDir, { recursive: true });
    fs.mkdirSync(copilotLogDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDataDir, 'User', 'globalStorage', 'state.vscdb'),
      'secret://{"extensionId":"vscode.github-authentication","key":"github.auth"}',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(githubLogDir, 'GitHub Authentication.log'),
      'Got 0 sessions for read:user,repo,user:email,workflow...',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(copilotLogDir, 'GitHub Copilot Chat.log'),
      'You are not signed in to GitHub. Please sign in to use Copilot.\nPermissiveAuthRequiredError: Permissive authentication is required',
      'utf-8',
    );

    const [report] = collectProfileDoctorReports(['stale-auth'], tempDir);

    expect(report.auth.githubAuthSecretMarkers).toBe(1);
    expect(report.auth.githubAuthLogLastSessionCount).toBe(0);
    expect(report.auth.copilotNotSignedInSeen).toBe(true);
    expect(report.auth.copilotPermissiveAuthErrorSeen).toBe(true);
    expect(report.warnings).toContain('No GitHub/Copilot authentication session found for this profile. If this profile should use Copilot, open it and sign in to GitHub.');
  });

  it('fix mode backs up and resets storage after safeStorage decrypt errors', () => {
    const profileDir = path.join(tempDir, 'tests', 'vscode-extension-tester', 'profiles', 'corrupt-auth');
    const userDataDir = path.join(profileDir, 'user-data');
    const globalStorageDir = path.join(userDataDir, 'User', 'globalStorage');
    const logDir = path.join(userDataDir, 'logs', '20260521T131719', 'window1');
    fs.mkdirSync(globalStorageDir, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });
    fs.mkdirSync(path.join(profileDir, 'extensions'), { recursive: true });
    fs.writeFileSync(path.join(userDataDir, 'Local State'), '{"os_crypt":{"encrypted_key":"redacted"}}', 'utf-8');
    fs.writeFileSync(path.join(globalStorageDir, 'state.vscdb'), 'encrypted-profile-state', 'utf-8');
    fs.writeFileSync(
      path.join(logDir, 'renderer.log'),
      'Error while decrypting the ciphertext provided to safeStorage.decryptString.',
      'utf-8',
    );

    const [report] = collectProfileDoctorReports(['corrupt-auth'], tempDir, true);

    expect(report.repairs.length).toBeGreaterThan(0);
    expect(report.manifest?.authStorageResetAt).toBeTruthy();
    expect(fs.existsSync(path.join(userDataDir, 'Local State'))).toBe(false);
    expect(fs.existsSync(path.join(globalStorageDir, 'state.vscdb'))).toBe(false);
    expect(fs.existsSync(path.join(profileDir, '.doctor-backups'))).toBe(true);
    expect(report.warnings).toContain('VS Code secret storage was reset for this profile. Open the profile and sign in to GitHub once so Copilot auth can be stored cleanly.');
  });

  it('fix mode stamps current VS Code metadata for an existing profile', () => {
    const profileDir = path.join(tempDir, 'tests', 'vscode-extension-tester', 'profiles', 'legacy');
    fs.mkdirSync(path.join(profileDir, 'user-data'), { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'profile.json'), JSON.stringify({ name: 'legacy', created: '2026-05-01T00:00:00.000Z' }), 'utf-8');

    const [report] = collectProfileDoctorReports(['legacy'], tempDir, true);

    expect(report.manifest?.vscodeCli?.version).toBe('1.121.0');
    expect(fs.existsSync(path.join(profileDir, 'extensions'))).toBe(true);
  });

  it('fix mode creates a missing profile without reporting it as missing', () => {
    const [report] = collectProfileDoctorReports(['new-profile'], tempDir, true);

    expect(report.exists).toBe(true);
    expect(report.errors).not.toContain('Profile directory is missing.');
    expect(fs.existsSync(path.join(
      tempDir,
      'tests',
      'vscode-extension-tester',
      'profiles',
      'new-profile',
      'profile.json',
    ))).toBe(true);
  });
});