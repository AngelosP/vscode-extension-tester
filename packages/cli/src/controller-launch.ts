import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const LAUNCH_REQUEST_FILE = 'vscode-extension-tester-controller-launch.json';

export interface ControllerLaunchRequest {
  port: number;
  createdAt: number;
  expiresAt: number;
  profileName?: string;
  workspacePath?: string;
}

export function getControllerLaunchRequestPath(): string {
  return path.join(os.tmpdir(), LAUNCH_REQUEST_FILE);
}

export function writeControllerLaunchRequest(port: number, profileName?: string, workspacePath?: string): string {
  const request: ControllerLaunchRequest = {
    port,
    profileName,
    workspacePath,
    createdAt: Date.now(),
    expiresAt: Date.now() + 10 * 60 * 1000,
  };
  const requestPath = getControllerLaunchRequestPath();
  fs.writeFileSync(requestPath, `${JSON.stringify(request)}\n`, 'utf-8');
  return requestPath;
}

export function removeControllerLaunchRequest(requestPath: string | undefined): void {
  if (!requestPath) return;
  try {
    fs.rmSync(requestPath, { force: true });
  } catch {
    // best-effort cleanup
  }
}