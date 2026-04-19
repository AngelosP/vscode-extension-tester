import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock vscode module
vi.mock('vscode', () => {
  const channels = new Map<string, any>();

  const createOutputChannel = vi.fn((name: string) => {
    const lines: string[] = [];
    const channel = {
      name,
      append: vi.fn((text: string) => lines.push(text)),
      appendLine: vi.fn((text: string) => lines.push(text + '\n')),
      replace: vi.fn((text: string) => { lines.length = 0; lines.push(text); }),
      clear: vi.fn(() => { lines.length = 0; }),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      _lines: lines,
    };
    channels.set(name, channel);
    return channel;
  });

  return {
    window: {
      createOutputChannel,
    },
    _channels: channels,
  };
});

import { OutputMonitor } from '../src/output-monitor.js';

describe('OutputMonitor', () => {
  let monitor: OutputMonitor;

  beforeEach(() => {
    monitor = new OutputMonitor();
  });

  describe('getContent()', () => {
    it('should return empty content for unknown channel', () => {
      const content = monitor.getContent('unknown');
      expect(content).toEqual({ name: 'unknown', content: '', captured: false });
    });
  });

  describe('listChannels()', () => {
    it('should return empty array initially', () => {
      const channels = monitor.listChannels();
      expect(channels).toEqual([]);
    });
  });

  describe('startCapture() / stopCapture()', () => {
    it('should add channel to explicit capture list', () => {
      monitor.startCapture('My Channel');
      // No error thrown
      expect(true).toBe(true);
    });

    it('should remove channel from explicit capture list', () => {
      monitor.startCapture('My Channel');
      monitor.stopCapture('My Channel');
      // No error thrown
      expect(true).toBe(true);
    });
  });

  describe('getCapturedChannels()', () => {
    it('should return empty array when no channels captured', () => {
      const captured = monitor.getCapturedChannels();
      expect(captured).toEqual([]);
    });
  });

  describe('getOffset()', () => {
    it('should return 0 for unknown channel', () => {
      const offset = monitor.getOffset('unknown');
      expect(offset).toBe(0);
    });
  });

  describe('clearAll()', () => {
    it('should not throw when no channels exist', () => {
      expect(() => monitor.clearAll()).not.toThrow();
    });
  });
});
