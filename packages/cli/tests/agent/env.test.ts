import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadEnv, getAgentConfig, getUserDataSummary } from '../../src/agent/env.js';

describe('env', () => {
  describe('loadEnv()', () => {
    const tmpDir = path.join(process.cwd(), '__test_env_tmp__');
    const envDir = path.join(tmpDir, 'tests', 'vscode-extension-tester');
    const envFile = path.join(envDir, '.env');

    beforeEach(() => {
      fs.mkdirSync(envDir, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should return empty object when no .env file exists', () => {
      fs.rmSync(envFile, { force: true });
      const result = loadEnv(path.join(tmpDir, 'nonexistent'));
      expect(result).toEqual({});
    });

    it('should parse simple key=value pairs', () => {
      fs.writeFileSync(envFile, 'KEY1=value1\nKEY2=value2', 'utf-8');
      const result = loadEnv(tmpDir);
      expect(result).toEqual({ KEY1: 'value1', KEY2: 'value2' });
    });

    it('should skip comments and empty lines', () => {
      fs.writeFileSync(envFile, '# This is a comment\n\nKEY=value\n  \n# another', 'utf-8');
      const result = loadEnv(tmpDir);
      expect(result).toEqual({ KEY: 'value' });
    });

    it('should strip surrounding double quotes', () => {
      fs.writeFileSync(envFile, 'KEY="quoted value"', 'utf-8');
      const result = loadEnv(tmpDir);
      expect(result['KEY']).toBe('quoted value');
    });

    it('should strip surrounding single quotes', () => {
      fs.writeFileSync(envFile, "KEY='quoted value'", 'utf-8');
      const result = loadEnv(tmpDir);
      expect(result['KEY']).toBe('quoted value');
    });

    it('should handle escape sequences in double-quoted values', () => {
      fs.writeFileSync(envFile, 'KEY="line1\\nline2"', 'utf-8');
      const result = loadEnv(tmpDir);
      expect(result['KEY']).toBe('line1\nline2');
    });

    it('should handle values with = signs', () => {
      fs.writeFileSync(envFile, 'KEY=value=with=equals', 'utf-8');
      const result = loadEnv(tmpDir);
      expect(result['KEY']).toBe('value=with=equals');
    });

    it('should trim keys and values', () => {
      fs.writeFileSync(envFile, '  KEY  =  value  ', 'utf-8');
      const result = loadEnv(tmpDir);
      expect(result['KEY']).toBe('value');
    });

    it('should skip lines without = sign', () => {
      fs.writeFileSync(envFile, 'NOEQUALS\nKEY=value', 'utf-8');
      const result = loadEnv(tmpDir);
      expect(result).toEqual({ KEY: 'value' });
    });
  });

  describe('getAgentConfig()', () => {
    it('should return defaults when env is empty', () => {
      const config = getAgentConfig({});
      expect(config.model).toBeUndefined();
      expect(config.maxIterations).toBe(20);
      expect(config.logLevel).toBe('info');
      expect(config.instructions).toBeUndefined();
    });

    it('should use MODEL from env', () => {
      const config = getAgentConfig({ MODEL: 'gpt-4o' });
      expect(config.model).toBe('gpt-4o');
    });

    it('should parse MAX_AGENT_ITERATIONS', () => {
      const config = getAgentConfig({ MAX_AGENT_ITERATIONS: '50' });
      expect(config.maxIterations).toBe(50);
    });

    it('should use LOG_LEVEL from env', () => {
      const config = getAgentConfig({ LOG_LEVEL: 'debug' });
      expect(config.logLevel).toBe('debug');
    });

    it('should use AGENT_INSTRUCTIONS from env', () => {
      const config = getAgentConfig({ AGENT_INSTRUCTIONS: 'Be thorough' });
      expect(config.instructions).toBe('Be thorough');
    });
  });

  describe('getUserDataSummary()', () => {
    it('should return "(none)" when env has only agent keys', () => {
      const result = getUserDataSummary({
        MODEL: 'gpt-4o',
        MAX_AGENT_ITERATIONS: '20',
        LOG_LEVEL: 'info',
      });
      expect(result).toBe('(none)');
    });

    it('should include non-agent keys', () => {
      const result = getUserDataSummary({
        MY_VAR: 'hello',
        OTHER: 'world',
      });
      expect(result).toContain('MY_VAR=hello');
      expect(result).toContain('OTHER=world');
    });

    it('should mask sensitive values', () => {
      const result = getUserDataSummary({
        API_KEY: 'secret123',
        PASSWORD: 'mysecret',
        DB_TOKEN: 'tok_abc',
        USERNAME: 'john',
      });
      expect(result).toContain('API_KEY=***');
      expect(result).toContain('PASSWORD=***');
      expect(result).toContain('DB_TOKEN=***');
      expect(result).toContain('USERNAME=john');
    });

    it('should exclude AGENT_INSTRUCTIONS from output', () => {
      const result = getUserDataSummary({
        AGENT_INSTRUCTIONS: 'some long text',
        MY_VAR: 'visible',
      });
      expect(result).not.toContain('AGENT_INSTRUCTIONS');
      expect(result).toContain('MY_VAR=visible');
    });
  });
});
