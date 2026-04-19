import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MODEL_CASCADE } from '../../src/agent/llm.js';

describe('llm', () => {
  describe('MODEL_CASCADE', () => {
    it('should have at least 2 models in the cascade', () => {
      expect(MODEL_CASCADE.length).toBeGreaterThanOrEqual(2);
    });

    it('should prefer Claude/Anthropic first', () => {
      expect(MODEL_CASCADE[0]).toContain('anthropic');
    });

    it('should have all entries as non-empty strings', () => {
      for (const model of MODEL_CASCADE) {
        expect(model).toBeTruthy();
        expect(typeof model).toBe('string');
      }
    });

    it('should contain known model providers', () => {
      const providers = MODEL_CASCADE.map((m) => m.split('/')[0]);
      expect(providers).toContain('anthropic');
      expect(providers).toContain('openai');
    });
  });
});
