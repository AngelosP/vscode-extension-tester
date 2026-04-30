import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  getProfileDir,
  getProfileUserDataDir,
  getProfileExtensionsDir,
  getEffectiveProfileName,
  getProfileUserDataDirForName,
  validateProfileOptions,
  detectedUserDataDirMatchesProfile,
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

    it('should resolve profiles relative to an explicit cwd', () => {
      const root = path.join(process.cwd(), 'fixture-extension');
      const dir = getProfileDir('test', root);

      expect(dir).toBe(path.join(root, 'tests', 'vscode-extension-tester', 'profiles', 'test'));
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

  describe('shared profile option helpers', () => {
    it('should resolve the effective named profile from mutually exclusive options', () => {
      expect(getEffectiveProfileName({ reuseNamedProfile: 'existing' })).toBe('existing');
      expect(getEffectiveProfileName({ reuseOrCreateNamedProfile: 'new' })).toBe('new');
      expect(getEffectiveProfileName({ cloneNamedProfile: 'clone' })).toBe('clone');
    });

    it('should reject conflicting named profile options', () => {
      expect(() => validateProfileOptions({ reuseNamedProfile: 'a', cloneNamedProfile: 'b' })).toThrow(
        'Only one profile strategy can be used at a time',
      );
    });

    it('should compare detected user data paths against a named profile', () => {
      const root = path.join(process.cwd(), 'fixture-extension');
      const expected = getProfileUserDataDirForName('live', root);

      expect(detectedUserDataDirMatchesProfile(expected, 'live', root)).toBe(true);
      expect(detectedUserDataDirMatchesProfile(path.join(root, 'elsewhere'), 'live', root)).toBe(false);
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
