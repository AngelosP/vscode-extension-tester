import * as fs from 'node:fs';
import * as path from 'node:path';

const MEMORIES_DIR = path.join('tests', 'vscode-extension-tester', 'memories');

/** Standard memory files the agent maintains */
export const MEMORY_FILES = [
  'extension-analysis.md',
  'test-patterns.md',
  'ui-flows.md',
] as const;

/**
 * Load all memory files and return combined content with headers.
 */
export function loadMemories(cwd: string): string {
  const dir = path.join(cwd, MEMORIES_DIR);
  if (!fs.existsSync(dir)) return '';

  const sections: string[] = [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  for (const file of files) {
    const content = fs.readFileSync(path.join(dir, file), 'utf-8').trim();
    if (content) {
      sections.push(`=== ${file} ===\n${content}`);
    }
  }

  return sections.length > 0
    ? `MEMORIES FROM PREVIOUS SESSIONS:\n\n${sections.join('\n\n')}`
    : '';
}

/**
 * Read a specific memory file. Returns null if not found.
 */
export function readMemory(cwd: string, filename: string): string | null {
  const filePath = path.join(cwd, MEMORIES_DIR, sanitizeFilename(filename));
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * Write (overwrite) a specific memory file.
 */
export function writeMemory(cwd: string, filename: string, content: string): void {
  const dir = path.join(cwd, MEMORIES_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sanitizeFilename(filename)), content, 'utf-8');
}

/**
 * Append an entry to a memory file with a timestamp separator.
 */
export function appendMemory(cwd: string, filename: string, entry: string): void {
  const dir = path.join(cwd, MEMORIES_DIR);
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, sanitizeFilename(filename));
  const timestamp = new Date().toISOString();
  const separator = `\n\n--- ${timestamp} ---\n`;

  if (fs.existsSync(filePath)) {
    fs.appendFileSync(filePath, separator + entry, 'utf-8');
  } else {
    fs.writeFileSync(filePath, `# ${filename}\n${separator}${entry}`, 'utf-8');
  }
}

/**
 * Ensure filename is safe (no path traversal).
 */
function sanitizeFilename(filename: string): string {
  return path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
}
