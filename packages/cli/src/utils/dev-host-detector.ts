import * as cp from 'node:child_process';
import * as path from 'node:path';

interface DevHostInfo {
  pid: number;
  extensionPath: string;
}

/**
 * Detect a running Extension Development Host by scanning process command lines
 * for the --extensionDevelopmentPath flag.
 */
export async function detectDevHost(extensionPath?: string): Promise<DevHostInfo | null> {
  if (process.platform === 'win32') {
    return detectWindows(extensionPath);
  }
  return detectUnix(extensionPath);
}

/**
 * Poll for a Dev Host to appear, with timeout.
 */
export async function waitForDevHost(timeoutMs: number, extensionPath?: string): Promise<DevHostInfo> {
  const deadline = Date.now() + timeoutMs;
  console.log('Waiting for Extension Development Host...');

  while (Date.now() < deadline) {
    const host = await detectDevHost(extensionPath);
    if (host) {
      console.log(`Found Extension Development Host (PID: ${host.pid})`);
      return host;
    }
    await delay(1000);
  }

  throw new Error(
    `Extension Development Host not found within ${Math.round(timeoutMs / 1000)}s. ` +
    'Make sure you have started a debug session (F5) for your extension.'
  );
}

async function detectWindows(extensionPath?: string): Promise<DevHostInfo | null> {
  try {
    const output = cp.execSync(
      'wmic process where "name like \'%Code%\'" get ProcessId,CommandLine /format:csv',
      { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return parseProcessOutput(output, extensionPath);
  } catch {
    // Fallback: try PowerShell
    try {
      const output = cp.execSync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -like \'*Code*\' } | Select-Object ProcessId, CommandLine | ConvertTo-Csv -NoTypeInformation"',
        { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      return parseProcessOutput(output, extensionPath);
    } catch {
      return null;
    }
  }
}

async function detectUnix(extensionPath?: string): Promise<DevHostInfo | null> {
  try {
    const output = cp.execSync('ps aux', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return parseProcessOutput(output, extensionPath);
  } catch {
    return null;
  }
}

function parseProcessOutput(output: string, extensionPath?: string): DevHostInfo | null {
  const expected = extensionPath ? normalizePath(extensionPath) : undefined;
  const hosts: DevHostInfo[] = [];
  const lines = output.split('\n');
  for (const line of lines) {
    const devPathMatch = line.match(/--extensionDevelopmentPath(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s,"']+))/);
    if (devPathMatch) {
      const pidMatch = line.match(/(\d{2,})/);
      if (pidMatch) {
        hosts.push({
          pid: parseInt(pidMatch[1], 10),
          extensionPath: devPathMatch[1] ?? devPathMatch[2] ?? devPathMatch[3],
        });
      }
    }
  }
  if (!expected) return hosts[0] ?? null;
  return hosts.find((host) => normalizePath(host.extensionPath) === expected) ?? null;
}

function normalizePath(value: string): string {
  return path.resolve(value).toLowerCase().replace(/\\/g, '/').replace(/\/+$/g, '');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
