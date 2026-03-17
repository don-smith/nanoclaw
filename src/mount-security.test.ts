import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock config to control allowlist path
vi.mock('./config.js', () => ({
  MOUNT_ALLOWLIST_PATH: '/tmp/test-mount-allowlist.json',
}));

import {
  generateAllowlistTemplate,
  loadMountAllowlist,
  validateAdditionalMounts,
  validateMount,
} from './mount-security.js';

const ALLOWLIST_PATH = '/tmp/test-mount-allowlist.json';

function writeAllowlist(allowlist: object): void {
  fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(allowlist));
}

function resetAllowlistCache(): void {
  // The module caches the allowlist — re-importing won't help since vitest
  // caches modules. We need to clear the internal state by loading a fresh
  // module. The simplest way: call loadMountAllowlist after deleting the file
  // and resetting the cached state via the module's own mechanism.
  //
  // Since the module uses module-level let variables (cachedAllowlist,
  // allowlistLoadError) we reset them by reimporting. vi.resetModules()
  // combined with dynamic import achieves this, but for simplicity we use
  // a workaround: the cache is only set once, so we isolate tests by using
  // vi.resetModules() in beforeEach.
}

// We need fresh module state for each test because of the internal cache
let mod: typeof import('./mount-security.js');

// Create temp directories for testing
const tmpRoot = path.join(os.tmpdir(), 'mount-security-test');
const allowedDir = path.join(tmpRoot, 'allowed-projects');
const blockedDir = path.join(tmpRoot, '.ssh');
const subDir = path.join(allowedDir, 'my-repo');
const secretDir = path.join(allowedDir, 'credentials');

beforeEach(async () => {
  // Create test directories
  fs.mkdirSync(allowedDir, { recursive: true });
  fs.mkdirSync(blockedDir, { recursive: true });
  fs.mkdirSync(subDir, { recursive: true });
  fs.mkdirSync(secretDir, { recursive: true });

  // Clean up allowlist file
  if (fs.existsSync(ALLOWLIST_PATH)) {
    fs.unlinkSync(ALLOWLIST_PATH);
  }

  // Reset module to clear cached allowlist
  vi.resetModules();
  mod = await import('./mount-security.js');
});

afterEach(() => {
  // Clean up
  if (fs.existsSync(ALLOWLIST_PATH)) {
    fs.unlinkSync(ALLOWLIST_PATH);
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('loadMountAllowlist', () => {
  it('returns null when allowlist file does not exist', () => {
    const result = mod.loadMountAllowlist();
    expect(result).toBeNull();
  });

  it('loads a valid allowlist', () => {
    writeAllowlist({
      allowedRoots: [{ path: allowedDir, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const result = mod.loadMountAllowlist();
    expect(result).not.toBeNull();
    expect(result!.allowedRoots).toHaveLength(1);
    expect(result!.allowedRoots[0].path).toBe(allowedDir);
  });

  it('merges default blocked patterns with user patterns', () => {
    writeAllowlist({
      allowedRoots: [],
      blockedPatterns: ['custom-secret'],
      nonMainReadOnly: false,
    });

    const result = mod.loadMountAllowlist();
    expect(result).not.toBeNull();
    // Should include both default patterns (.ssh, .env, etc.) and custom
    expect(result!.blockedPatterns).toContain('.ssh');
    expect(result!.blockedPatterns).toContain('.env');
    expect(result!.blockedPatterns).toContain('custom-secret');
  });

  it('caches the allowlist on subsequent calls', () => {
    writeAllowlist({
      allowedRoots: [{ path: allowedDir, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const first = mod.loadMountAllowlist();
    // Delete file — should still return cached
    fs.unlinkSync(ALLOWLIST_PATH);
    const second = mod.loadMountAllowlist();
    expect(second).toBe(first);
  });

  it('returns null for invalid JSON', () => {
    fs.writeFileSync(ALLOWLIST_PATH, 'not json');
    const result = mod.loadMountAllowlist();
    expect(result).toBeNull();
  });

  it('returns null when allowedRoots is not an array', () => {
    writeAllowlist({
      allowedRoots: 'not-an-array',
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const result = mod.loadMountAllowlist();
    expect(result).toBeNull();
  });

  it('returns null when blockedPatterns is not an array', () => {
    writeAllowlist({
      allowedRoots: [],
      blockedPatterns: 'not-an-array',
      nonMainReadOnly: false,
    });

    const result = mod.loadMountAllowlist();
    expect(result).toBeNull();
  });

  it('returns null when nonMainReadOnly is not a boolean', () => {
    writeAllowlist({
      allowedRoots: [],
      blockedPatterns: [],
      nonMainReadOnly: 'yes',
    });

    const result = mod.loadMountAllowlist();
    expect(result).toBeNull();
  });
});

describe('validateMount', () => {
  describe('allowlist checks', () => {
    it('rejects all mounts when no allowlist exists', () => {
      const result = mod.validateMount(
        { hostPath: allowedDir, readonly: true },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('No mount allowlist configured');
    });

    it('allows mount under an allowed root', () => {
      writeAllowlist({
        allowedRoots: [{ path: allowedDir, allowReadWrite: false }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });

      const result = mod.validateMount(
        { hostPath: subDir, readonly: true },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.effectiveReadonly).toBe(true);
    });

    it('rejects mount outside any allowed root', () => {
      writeAllowlist({
        allowedRoots: [{ path: allowedDir, allowReadWrite: false }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });

      const result = mod.validateMount(
        { hostPath: os.tmpdir(), readonly: true },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not under any allowed root');
    });

    it('rejects mount when host path does not exist', () => {
      writeAllowlist({
        allowedRoots: [{ path: allowedDir, allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });

      const result = mod.validateMount(
        { hostPath: path.join(allowedDir, 'nonexistent'), readonly: true },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('does not exist');
    });
  });

  describe('blocked patterns', () => {
    it('rejects paths matching default blocked patterns', () => {
      writeAllowlist({
        allowedRoots: [{ path: tmpRoot, allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });

      const result = mod.validateMount(
        { hostPath: blockedDir, readonly: true },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('.ssh');
    });

    it('rejects paths matching custom blocked patterns', () => {
      writeAllowlist({
        allowedRoots: [{ path: tmpRoot, allowReadWrite: true }],
        blockedPatterns: ['credentials'],
        nonMainReadOnly: false,
      });

      const result = mod.validateMount(
        { hostPath: secretDir, readonly: true },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('credentials');
    });

    it('blocks paths with default pattern "credentials" in path component', () => {
      writeAllowlist({
        allowedRoots: [{ path: tmpRoot, allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });

      // "credentials" is a default blocked pattern
      const result = mod.validateMount(
        { hostPath: secretDir, readonly: true },
        true,
      );
      expect(result.allowed).toBe(false);
    });
  });

  describe('container path validation', () => {
    it('derives container path from hostPath basename when not specified', () => {
      writeAllowlist({
        allowedRoots: [{ path: allowedDir, allowReadWrite: false }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });

      const result = mod.validateMount(
        { hostPath: subDir, readonly: true },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.resolvedContainerPath).toBe('my-repo');
    });

    it('uses explicit container path when provided', () => {
      writeAllowlist({
        allowedRoots: [{ path: allowedDir, allowReadWrite: false }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });

      const result = mod.validateMount(
        {
          hostPath: subDir,
          containerPath: 'custom-name',
          readonly: true,
        },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.resolvedContainerPath).toBe('custom-name');
    });

    it('rejects container path with traversal', () => {
      writeAllowlist({
        allowedRoots: [{ path: allowedDir, allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });

      const result = mod.validateMount(
        {
          hostPath: subDir,
          containerPath: '../escape',
          readonly: true,
        },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('..');
    });

    it('rejects absolute container path', () => {
      writeAllowlist({
        allowedRoots: [{ path: allowedDir, allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });

      const result = mod.validateMount(
        {
          hostPath: subDir,
          containerPath: '/etc/passwd',
          readonly: true,
        },
        true,
      );
      expect(result.allowed).toBe(false);
    });

    it('falls back to hostPath basename when container path is empty', () => {
      writeAllowlist({
        allowedRoots: [{ path: allowedDir, allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });

      const result = mod.validateMount(
        { hostPath: subDir, containerPath: '', readonly: true },
        true,
      );
      // Empty string is falsy, so falls back to basename of hostPath
      expect(result.allowed).toBe(true);
      expect(result.resolvedContainerPath).toBe('my-repo');
    });
  });

  describe('read-write permissions', () => {
    it('defaults to read-only when mount does not request read-write', () => {
      writeAllowlist({
        allowedRoots: [{ path: allowedDir, allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });

      const result = mod.validateMount(
        { hostPath: subDir, readonly: true },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.effectiveReadonly).toBe(true);
    });

    it('defaults to read-only when readonly is undefined', () => {
      writeAllowlist({
        allowedRoots: [{ path: allowedDir, allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });

      const result = mod.validateMount({ hostPath: subDir }, true);
      expect(result.allowed).toBe(true);
      expect(result.effectiveReadonly).toBe(true);
    });

    it('grants read-write to main group when root allows it', () => {
      writeAllowlist({
        allowedRoots: [{ path: allowedDir, allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });

      const result = mod.validateMount(
        { hostPath: subDir, readonly: false },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.effectiveReadonly).toBe(false);
    });

    it('forces read-only when root does not allow read-write', () => {
      writeAllowlist({
        allowedRoots: [{ path: allowedDir, allowReadWrite: false }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });

      const result = mod.validateMount(
        { hostPath: subDir, readonly: false },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.effectiveReadonly).toBe(true);
    });

    it('forces read-only for non-main when root does not allow read-write, even with nonMainReadOnly false', () => {
      writeAllowlist({
        allowedRoots: [{ path: allowedDir, allowReadWrite: false }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });

      const result = mod.validateMount(
        { hostPath: subDir, readonly: false },
        false,
      );
      expect(result.allowed).toBe(true);
      expect(result.effectiveReadonly).toBe(true);
    });

    it('grants read-write to non-main group when allowReadWrite overrides nonMainReadOnly', () => {
      writeAllowlist({
        allowedRoots: [{ path: allowedDir, allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: true,
      });

      const result = mod.validateMount(
        { hostPath: subDir, readonly: false },
        false,
      );
      expect(result.allowed).toBe(true);
      expect(result.effectiveReadonly).toBe(false);
    });

    it('grants read-write to non-main group when nonMainReadOnly is false', () => {
      writeAllowlist({
        allowedRoots: [{ path: allowedDir, allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });

      const result = mod.validateMount(
        { hostPath: subDir, readonly: false },
        false,
      );
      expect(result.allowed).toBe(true);
      expect(result.effectiveReadonly).toBe(false);
    });

    it('forces read-only for non-main when root disallows read-write regardless of nonMainReadOnly', () => {
      writeAllowlist({
        allowedRoots: [{ path: allowedDir, allowReadWrite: false }],
        blockedPatterns: [],
        nonMainReadOnly: true,
      });

      const result = mod.validateMount(
        { hostPath: subDir, readonly: false },
        false,
      );
      expect(result.allowed).toBe(true);
      expect(result.effectiveReadonly).toBe(true);
    });
  });

  describe('tilde expansion', () => {
    it('expands ~ in allowed root paths', () => {
      const homeSubDir = path.join(os.homedir(), 'mount-security-test-dir');
      fs.mkdirSync(homeSubDir, { recursive: true });

      try {
        writeAllowlist({
          allowedRoots: [
            { path: '~/mount-security-test-dir', allowReadWrite: false },
          ],
          blockedPatterns: [],
          nonMainReadOnly: false,
        });

        const result = mod.validateMount(
          { hostPath: homeSubDir, readonly: true },
          true,
        );
        expect(result.allowed).toBe(true);
      } finally {
        fs.rmSync(homeSubDir, { recursive: true, force: true });
      }
    });

    it('expands ~ in mount host paths', () => {
      const homeSubDir = path.join(os.homedir(), 'mount-security-test-dir');
      fs.mkdirSync(homeSubDir, { recursive: true });

      try {
        writeAllowlist({
          allowedRoots: [{ path: homeSubDir, allowReadWrite: false }],
          blockedPatterns: [],
          nonMainReadOnly: false,
        });

        const result = mod.validateMount(
          { hostPath: '~/mount-security-test-dir', readonly: true },
          true,
        );
        expect(result.allowed).toBe(true);
      } finally {
        fs.rmSync(homeSubDir, { recursive: true, force: true });
      }
    });
  });
});

describe('validateAdditionalMounts', () => {
  it('returns empty array when no mounts pass validation', () => {
    // No allowlist file → all rejected
    const result = mod.validateAdditionalMounts(
      [{ hostPath: allowedDir, readonly: true }],
      'test-group',
      false,
    );
    expect(result).toEqual([]);
  });

  it('returns validated mounts with /workspace/extra/ prefix', () => {
    writeAllowlist({
      allowedRoots: [{ path: allowedDir, allowReadWrite: false }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const result = mod.validateAdditionalMounts(
      [{ hostPath: subDir, readonly: true }],
      'test-group',
      false,
    );
    expect(result).toHaveLength(1);
    expect(result[0].containerPath).toBe('/workspace/extra/my-repo');
    expect(result[0].readonly).toBe(true);
  });

  it('filters out invalid mounts and keeps valid ones', () => {
    writeAllowlist({
      allowedRoots: [{ path: allowedDir, allowReadWrite: false }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const result = mod.validateAdditionalMounts(
      [
        { hostPath: subDir, readonly: true }, // valid
        { hostPath: '/nonexistent/path', readonly: true }, // invalid
      ],
      'test-group',
      false,
    );
    expect(result).toHaveLength(1);
    expect(result[0].containerPath).toBe('/workspace/extra/my-repo');
  });

  it('passes isMain through to validateMount for permission checks', () => {
    writeAllowlist({
      allowedRoots: [{ path: allowedDir, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });

    // Non-main with allowReadWrite: true should get read-write (override behavior)
    const nonMainResult = mod.validateAdditionalMounts(
      [{ hostPath: subDir, readonly: false }],
      'non-main-group',
      false,
    );
    expect(nonMainResult).toHaveLength(1);
    expect(nonMainResult[0].readonly).toBe(false);

    // Main should also get read-write
    // Need to reset module for fresh cache
  });
});

describe('generateAllowlistTemplate', () => {
  it('generates valid JSON', () => {
    const template = mod.generateAllowlistTemplate();
    const parsed = JSON.parse(template);
    expect(parsed.allowedRoots).toBeInstanceOf(Array);
    expect(parsed.blockedPatterns).toBeInstanceOf(Array);
    expect(typeof parsed.nonMainReadOnly).toBe('boolean');
  });

  it('includes example roots with mixed permissions', () => {
    const parsed = JSON.parse(mod.generateAllowlistTemplate());
    const rwRoot = parsed.allowedRoots.find(
      (r: { allowReadWrite: boolean }) => r.allowReadWrite === true,
    );
    const roRoot = parsed.allowedRoots.find(
      (r: { allowReadWrite: boolean }) => r.allowReadWrite === false,
    );
    expect(rwRoot).toBeDefined();
    expect(roRoot).toBeDefined();
  });
});
