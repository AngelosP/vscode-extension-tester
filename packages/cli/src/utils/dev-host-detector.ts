import * as cp from 'node:child_process';

interface DevHostInfo {
  pid: number;
  extensionPath: string;
}

/**
 * Detect a running Extension Development Host by scanning process command lines
 * for the --extensionDevelopmentPath flag.
 */
export async function detectDevHost(): Promise<DevHostInfo | null> {
  if (process.platform === 'win32') {
    return detectWindows();
  }
  return detectUnix();
}

/**
 * Poll for a Dev Host to appear, with timeout.
 */
export async function waitForDevHost(timeoutMs: number): Promise<DevHostInfo> {
  const deadline = Date.now() + timeoutMs;
  console.log('Waiting for Extension Development Host...');

  while (Date.now() < deadline) {
    const host = await detectDevHost();
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

async function detectWindows(): Promise<DevHostInfo | null> {
  try {
    const output = cp.execSync(
      'wmic process where "name like \'%Code%\'" get ProcessId,CommandLine /format:csv',
      { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return parseProcessOutput(output);
  } catch {
    // Fallback: try PowerShell
    try {
      const output = cp.execSync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -like \'*Code*\' } | Select-Object ProcessId, CommandLine | ConvertTo-Csv -NoTypeInformation"',
        { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      return parseProcessOutput(output);
    } catch {
      return null;
    }
  }
}

async function detectUnix(): Promise<DevHostInfo | null> {
  try {
    const output = cp.execSync('ps aux', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return parseProcessOutput(output);
  } catch {
    return null;
  }
}

function parseProcessOutput(output: string): DevHostInfo | null {
  const lines = output.split('\n');
  for (const line of lines) {
    const devPathMatch = line.match(/--extensionDevelopmentPath[=\s]["']?([^\s"']+)/);
    if (devPathMatch) {
      const pidMatch = line.match(/(\d{2,})/);
      if (pidMatch) {
        return {
          pid: parseInt(pidMatch[1], 10),
          extensionPath: devPathMatch[1],
        };
      }
    }
  }
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
