import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadMemories, readMemory, writeMemory, appendMemory } from '../../src/agent/memory.js';

describe('memory', () => {
  const tmpDir = path.join(process.cwd(), '__test_memory_tmp__');
  const memoriesDir = path.join(tmpDir, 'tests', 'vscode-extension-tester', 'memories');

  beforeEach(() => {
    fs.mkdirSync(memoriesDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadMemories()', () => {
    it('should return empty string when no memories directory exists', () => {
      const result = loadMemories(path.join(tmpDir, 'nonexistent'));
      expect(result).toBe('');
    });

    it('should return empty string when no .md files exist', () => {
      const result = loadMemories(tmpDir);
      expect(result).toBe('');
    });

    it('should load and combine multiple memory files', () => {
      fs.writeFileSync(path.join(memoriesDir, 'analysis.md'), 'Analysis content', 'utf-8');
      fs.writeFileSync(path.join(memoriesDir, 'patterns.md'), 'Patterns content', 'utf-8');

      const result = loadMemories(tmpDir);

      expect(result).toContain('MEMORIES FROM PREVIOUS SESSIONS');
      expect(result).toContain('=== analysis.md ===');
      expect(result).toContain('Analysis content');
      expect(result).toContain('=== patterns.md ===');
      expect(result).toContain('Patterns content');
    });

    it('should skip empty files', () => {
      fs.writeFileSync(path.join(memoriesDir, 'empty.md'), '', 'utf-8');
      fs.writeFileSync(path.join(memoriesDir, 'filled.md'), 'Has content', 'utf-8');

      const result = loadMemories(tmpDir);

      expect(result).not.toContain('empty.md');
      expect(result).toContain('filled.md');
    });

    it('should skip non-md files', () => {
      fs.writeFileSync(path.join(memoriesDir, 'data.json'), '{"key":"value"}', 'utf-8');
      fs.writeFileSync(path.join(memoriesDir, 'notes.md'), 'Notes', 'utf-8');

      const result = loadMemories(tmpDir);

      expect(result).not.toContain('data.json');
      expect(result).toContain('notes.md');
    });
  });

  describe('readMemory()', () => {
    it('should return null when file does not exist', () => {
      const result = readMemory(tmpDir, 'nonexistent.md');
      expect(result).toBeNull();
    });

    it('should return file content when file exists', () => {
      fs.writeFileSync(path.join(memoriesDir, 'test.md'), 'test content', 'utf-8');
      const result = readMemory(tmpDir, 'test.md');
      expect(result).toBe('test content');
    });

    it('should sanitize filename to prevent path traversal', () => {
      // Attempting path traversal should be sanitized
      const result = readMemory(tmpDir, '../../../etc/passwd');
      expect(result).toBeNull();
    });
  });

  describe('writeMemory()', () => {
    it('should create file with content', () => {
      writeMemory(tmpDir, 'new.md', 'new content');

      const content = fs.readFileSync(path.join(memoriesDir, 'new.md'), 'utf-8');
      expect(content).toBe('new content');
    });

    it('should overwrite existing file', () => {
      fs.writeFileSync(path.join(memoriesDir, 'existing.md'), 'old content', 'utf-8');

      writeMemory(tmpDir, 'existing.md', 'new content');

      const content = fs.readFileSync(path.join(memoriesDir, 'existing.md'), 'utf-8');
      expect(content).toBe('new content');
    });

    it('should create the memories directory if it does not exist', () => {
      const newTmp = path.join(tmpDir, 'fresh');
      writeMemory(newTmp, 'test.md', 'content');

      const dir = path.join(newTmp, 'tests', 'vscode-extension-tester', 'memories');
      expect(fs.existsSync(path.join(dir, 'test.md'))).toBe(true);
    });

    it('should sanitize filename', () => {
      writeMemory(tmpDir, 'safe_file-name.md', 'content');

      expect(fs.existsSync(path.join(memoriesDir, 'safe_file-name.md'))).toBe(true);
    });
  });

  describe('appendMemory()', () => {
    it('should create file with header if it does not exist', () => {
      appendMemory(tmpDir, 'new-append.md', 'first entry');

      const content = fs.readFileSync(path.join(memoriesDir, 'new-append.md'), 'utf-8');
      expect(content).toContain('# new-append.md');
      expect(content).toContain('first entry');
    });

    it('should append to existing file with timestamp', () => {
      fs.writeFileSync(path.join(memoriesDir, 'log.md'), 'existing content', 'utf-8');

      appendMemory(tmpDir, 'log.md', 'new entry');

      const content = fs.readFileSync(path.join(memoriesDir, 'log.md'), 'utf-8');
      expect(content).toContain('existing content');
      expect(content).toContain('new entry');
      expect(content).toMatch(/---\s+\d{4}-\d{2}-\d{2}/); // timestamp pattern
    });

    it('should include ISO timestamp separator', () => {
      appendMemory(tmpDir, 'timestamped.md', 'entry');

      const content = fs.readFileSync(path.join(memoriesDir, 'timestamped.md'), 'utf-8');
      // ISO timestamp like 2026-04-18T12:00:00.000Z
      expect(content).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });
});
