import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  getProfileDir,
  getProfileUserDataDir,
  getProfileExtensionsDir,
  profileExists,
  listProfiles,
  deleteProfile,
} from '../src/profile.js';

// We need to test the unexported isValidProfileName via getProfileDir
// (it throws on invalid names)

describe('profile', () => {
  describe('getProfileDir()', () => {
    it('should return a valid path for a valid profile name', () => {
      const dir = getProfileDir('my-profile');
      expect(dir).toContain('my-profile');
      expect(path.isAbsolute(dir)).toBe(true);
    });

    it('should throw on invalid profile name with spaces', () => {
      expect(() => getProfileDir('my profile')).toThrow('Invalid profile name');
    });

    it('should throw on invalid profile name with special chars', () => {
      expect(() => getProfileDir('my@profile!')).toThrow('Invalid profile name');
    });

    it('should throw on empty profile name', () => {
      expect(() => getProfileDir('')).toThrow('Invalid profile name');
    });

    it('should throw on profile name starting with hyphen', () => {
      expect(() => getProfileDir('-invalid')).toThrow('Invalid profile name');
    });

    it('should accept alphanumeric names with hyphens and underscores', () => {
      expect(() => getProfileDir('valid-name')).not.toThrow();
      expect(() => getProfileDir('valid_name')).not.toThrow();
      expect(() => getProfileDir('ValidName123')).not.toThrow();
    });

    it('should include the profiles directory in the path', () => {
      const dir = getProfileDir('test');
      expect(dir).toContain(path.join('tests', 'vscode-extension-tester', 'profiles', 'test'));
    });
  });

  describe('getProfileUserDataDir()', () => {
    it('should return user-data subdirectory', () => {
      const dir = getProfileUserDataDir('/some/profile');
      expect(dir).toBe(path.join('/some/profile', 'user-data'));
    });
  });

  describe('getProfileExtensionsDir()', () => {
    it('should return extensions subdirectory', () => {
      const dir = getProfileExtensionsDir('/some/profile');
      expect(dir).toBe(path.join('/some/profile', 'extensions'));
    });
  });

  describe('profileExists()', () => {
    const tmpDir = path.join(process.cwd(), '__test_profile_tmp__');

    beforeEach(() => {
      // Create a fake profiles directory structure
      const profileDir = path.join(
        tmpDir,
        'tests',
        'vscode-extension-tester',
        'profiles',
        'existing',
        'user-data'
      );
      fs.mkdirSync(profileDir, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should return false for non-existing profile', () => {
      // profileExists uses process.cwd() internally, so we need to test differently
      // We can test that the function itself works by checking return type
      const result = profileExists('this-profile-definitely-does-not-exist-xyz');
      expect(result).toBe(false);
    });
  });

  describe('listProfiles()', () => {
    it('should return an array', () => {
      const result = listProfiles();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('deleteProfile()', () => {
    it('should throw when profile does not exist', () => {
      expect(() => deleteProfile('nonexistent-profile-xyz')).toThrow('not found');
    });
  });
});
