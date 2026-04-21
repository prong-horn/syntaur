import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

// Mock child_process BEFORE importing github-backup so execFile is stubbed.
// Each test can override gitHandler to simulate git behavior.
type GitCall = { args: string[]; cwd: string | undefined };
const gitCalls: GitCall[] = [];
let gitHandler: (args: string[], cwd: string | undefined) => Promise<{ stdout: string; stderr: string }> = async () => ({
  stdout: '',
  stderr: '',
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');

  function runGitMock(args: string[], opts?: { cwd?: string }): Promise<{ stdout: string; stderr: string }> {
    if (!Array.isArray(args)) {
      return Promise.reject(new Error('execFile mock expected args array'));
    }
    gitCalls.push({ args, cwd: opts?.cwd });
    return gitHandler(args, opts?.cwd);
  }

  const execFileMock = function (
    file: string,
    args: string[],
    optsOrCb: unknown,
    maybeCb?: unknown,
  ) {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as
      | ((err: Error | null, stdout: string, stderr: string) => void)
      | undefined;
    const opts = (typeof optsOrCb === 'object' && optsOrCb !== null ? optsOrCb : undefined) as
      | { cwd?: string }
      | undefined;
    if (file !== 'git') {
      if (cb) cb(new Error(`unexpected exec: ${file}`), '', '');
      return undefined as unknown as ReturnType<typeof actual.execFile>;
    }
    runGitMock(args, opts)
      .then((result) => cb && cb(null, result.stdout, result.stderr))
      .catch((err) => cb && cb(err, '', err?.message ?? ''));
    return undefined as unknown as ReturnType<typeof actual.execFile>;
  };

  // child_process.execFile has promisify.custom attached so promisify(execFile)
  // returns { stdout, stderr }. Our mock needs the same symbol.
  (execFileMock as unknown as { [k: symbol]: unknown })[promisify.custom] = (
    file: string,
    args: string[],
    opts?: { cwd?: string },
  ): Promise<{ stdout: string; stderr: string }> => {
    if (file !== 'git') return Promise.reject(new Error(`unexpected exec: ${file}`));
    return runGitMock(args, opts);
  };

  return {
    ...actual,
    execFile: execFileMock,
  };
});

import {
  VALID_CATEGORIES,
  parseCategories,
  parseCategoriesStrict,
  validateCategories,
  validateRepoUrl,
  resolveCategoryPath,
  getBackupStatus,
  backupToGithub,
  restoreFromGithub,
  safeRestoreCategory,
  readSanitizedConfig,
} from '../utils/github-backup.js';
import { readConfig, updateBackupConfig } from '../utils/config.js';

describe('github-backup validation helpers', () => {
  describe('validateRepoUrl', () => {
    it('accepts https URLs', () => {
      expect(validateRepoUrl('https://github.com/foo/bar.git')).toBe(true);
    });

    it('accepts git@ SSH URLs', () => {
      expect(validateRepoUrl('git@github.com:foo/bar.git')).toBe(true);
    });

    it('rejects plain strings', () => {
      expect(validateRepoUrl('not-a-url')).toBe(false);
    });

    it('rejects empty strings', () => {
      expect(validateRepoUrl('')).toBe(false);
    });

    it('rejects ftp URLs', () => {
      expect(validateRepoUrl('ftp://foo.com/bar.git')).toBe(false);
    });
  });

  describe('validateCategories', () => {
    it('returns valid categories unchanged', () => {
      const result = validateCategories(['projects', 'playbooks']);
      expect(result).toEqual(['projects', 'playbooks']);
    });

    it('filters out unknown categories', () => {
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (msg: string) => warnings.push(msg);
      try {
        const result = validateCategories(['projects', 'bogus', 'todos']);
        expect(result).toEqual(['projects', 'todos']);
        expect(warnings.some((w) => w.includes('bogus'))).toBe(true);
      } finally {
        console.warn = originalWarn;
      }
    });

    it('returns empty array for all-invalid input', () => {
      const originalWarn = console.warn;
      console.warn = () => {};
      try {
        expect(validateCategories(['foo', 'bar'])).toEqual([]);
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  describe('parseCategories', () => {
    it('parses comma-separated string', () => {
      expect(parseCategories('projects, playbooks, todos')).toEqual([
        'projects',
        'playbooks',
        'todos',
      ]);
    });

    it('filters invalid entries', () => {
      expect(parseCategories('projects, fake, playbooks')).toEqual(['projects', 'playbooks']);
    });

    it('handles extra whitespace', () => {
      expect(parseCategories('  projects  ,  todos  ')).toEqual(['projects', 'todos']);
    });

    it('returns empty array for empty string', () => {
      expect(parseCategories('')).toEqual([]);
    });
  });

  it('VALID_CATEGORIES lists expected entries', () => {
    expect(VALID_CATEGORIES).toEqual(['projects', 'playbooks', 'todos', 'servers', 'config']);
  });
});

describe('github-backup category path resolution', () => {
  const originalHome = process.env.HOME;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'syntaur-backup-test-'));
    process.env.HOME = homeDir;
    await mkdir(resolve(homeDir, '.syntaur'), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('resolves projects path from configured defaultProjectDir', async () => {
    const customProjects = resolve(homeDir, 'custom-projects');
    await writeFile(
      resolve(homeDir, '.syntaur', 'config.md'),
      `---\nversion: "1.0"\ndefaultProjectDir: ${customProjects}\n---\n`,
    );

    const result = await resolveCategoryPath('projects');
    expect(result.sourcePath).toBe(customProjects);
    expect(result.repoPath).toBe('projects');
    expect(result.isFile).toBe(false);
  });

  it('resolves playbooks path under syntaur root', async () => {
    const result = await resolveCategoryPath('playbooks');
    expect(result.sourcePath).toBe(resolve(homeDir, '.syntaur', 'playbooks'));
    expect(result.repoPath).toBe('playbooks');
    expect(result.isFile).toBe(false);
  });

  it('resolves config as a single file', async () => {
    const result = await resolveCategoryPath('config');
    expect(result.sourcePath).toBe(resolve(homeDir, '.syntaur', 'config.md'));
    expect(result.repoPath).toBe('config.md');
    expect(result.isFile).toBe(true);
  });

  it('resolves todos and servers under syntaur root', async () => {
    const todos = await resolveCategoryPath('todos');
    const servers = await resolveCategoryPath('servers');
    expect(todos.sourcePath).toBe(resolve(homeDir, '.syntaur', 'todos'));
    expect(servers.sourcePath).toBe(resolve(homeDir, '.syntaur', 'servers'));
  });
});

describe('backup config round-trip', () => {
  const originalHome = process.env.HOME;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'syntaur-backup-config-'));
    process.env.HOME = homeDir;
    await mkdir(resolve(homeDir, '.syntaur'), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('persists repo URL and categories', async () => {
    await writeFile(
      resolve(homeDir, '.syntaur', 'config.md'),
      '---\nversion: "1.0"\ndefaultProjectDir: ~/projects\n---\n',
    );

    await updateBackupConfig({
      repo: 'git@github.com:foo/bar.git',
      categories: 'projects, playbooks',
    });

    const config = await readConfig();
    expect(config.backup).not.toBeNull();
    expect(config.backup?.repo).toBe('git@github.com:foo/bar.git');
    expect(config.backup?.categories).toBe('projects, playbooks');
    expect(config.backup?.lastBackup).toBeNull();
    expect(config.backup?.lastRestore).toBeNull();
  });

  it('updates lastBackup without losing other fields', async () => {
    await writeFile(
      resolve(homeDir, '.syntaur', 'config.md'),
      '---\nversion: "1.0"\ndefaultProjectDir: ~/projects\n---\n',
    );

    await updateBackupConfig({ repo: 'https://github.com/foo/bar.git', categories: 'projects' });
    const timestamp = '2026-04-16T12:00:00.000Z';
    await updateBackupConfig({ lastBackup: timestamp });

    const config = await readConfig();
    expect(config.backup?.repo).toBe('https://github.com/foo/bar.git');
    expect(config.backup?.categories).toBe('projects');
    expect(config.backup?.lastBackup).toBe(timestamp);
  });

  it('getBackupStatus returns defaults when no backup config set', async () => {
    await writeFile(
      resolve(homeDir, '.syntaur', 'config.md'),
      '---\nversion: "1.0"\ndefaultProjectDir: ~/projects\n---\n',
    );

    const status = await getBackupStatus();
    expect(status.repo).toBeNull();
    expect(status.categories).toBe('projects, playbooks, todos, servers, config');
    expect(status.lastBackup).toBeNull();
    expect(status.lastRestore).toBeNull();
    expect(status.locked).toBe(false);
  });

  it('getBackupStatus detects lock file', async () => {
    await writeFile(
      resolve(homeDir, '.syntaur', 'config.md'),
      '---\nversion: "1.0"\ndefaultProjectDir: ~/projects\n---\n',
    );
    await writeFile(resolve(homeDir, '.syntaur', '.backup-lock'), '12345');

    const status = await getBackupStatus();
    expect(status.locked).toBe(true);
  });
});

describe('parseCategoriesStrict', () => {
  it('throws on unknown category with valid list in the message', () => {
    expect(() => parseCategoriesStrict(['projects', 'bogus'])).toThrowError(
      /Unknown category.*"bogus".*Valid:.*projects/,
    );
  });

  it('returns valid categories when all are known', () => {
    expect(parseCategoriesStrict(['projects', 'todos'])).toEqual(['projects', 'todos']);
  });

  it('throws even if some entries are valid', () => {
    expect(() => parseCategoriesStrict(['projects', 'unknown1', 'unknown2'])).toThrow(
      /unknown1.*unknown2/,
    );
  });
});

describe('validateRepoUrl stricter rules', () => {
  it('rejects http:// URLs (only https and git@ allowed)', () => {
    expect(validateRepoUrl('http://foo.com/bar.git')).toBe(false);
  });
});

describe('backupToGithub flow', () => {
  const originalHome = process.env.HOME;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'syntaur-backup-flow-'));
    process.env.HOME = homeDir;
    await mkdir(resolve(homeDir, '.syntaur'), { recursive: true });
    await writeFile(
      resolve(homeDir, '.syntaur', 'config.md'),
      '---\nversion: "1.0"\ndefaultProjectDir: ~/projects\n---\n',
    );
    gitCalls.length = 0;
    // Default handler: git --version succeeds; other commands return empty.
    gitHandler = async () => ({ stdout: '', stderr: '' });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    gitCalls.length = 0;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('throws when no repo configured', async () => {
    await expect(backupToGithub()).rejects.toThrow(/No backup repo configured/);
  });

  it('throws when repo URL is invalid', async () => {
    await updateBackupConfig({ repo: 'bogus-url', categories: 'projects' });
    await expect(backupToGithub()).rejects.toThrow(/Invalid repo URL/);
  });

  it('throws when categories override is empty', async () => {
    await updateBackupConfig({ repo: 'git@github.com:x/y.git', categories: 'projects' });
    await expect(backupToGithub({ categories: [] })).rejects.toThrow(/No valid backup categories/);
  });

  it('is blocked by existing lock file', async () => {
    await updateBackupConfig({ repo: 'git@github.com:x/y.git', categories: 'projects' });
    await writeFile(resolve(homeDir, '.syntaur', '.backup-lock'), '99999');
    await expect(backupToGithub()).rejects.toThrow(/Backup operation already in progress/);
  });

  it('returns committed:false when git status shows no changes and persists lastBackup', async () => {
    await updateBackupConfig({ repo: 'git@github.com:x/y.git', categories: 'projects' });

    gitHandler = async (args, cwd) => {
      if (args[0] === '--version') return { stdout: 'git version 2', stderr: '' };
      if (args[0] === 'clone') {
        // Simulate a successful clone: create an empty .git dir
        await mkdir(resolve(String(cwd ?? args[args.length - 1]), '.git'), { recursive: true });
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'status' && args[1] === '--porcelain') {
        return { stdout: '', stderr: '' }; // no changes
      }
      return { stdout: '', stderr: '' };
    };

    const result = await backupToGithub();
    expect(result.success).toBe(true);
    expect(result.committed).toBe(false);
    expect(result.message).toMatch(/No changes/);

    const config = await readConfig();
    expect(config.backup?.lastBackup).toBe(result.timestamp);

    // Verify expected git commands were called
    const argLists = gitCalls.map((c) => c.args[0]);
    expect(argLists).toContain('--version');
    expect(argLists).toContain('clone');
    expect(argLists).toContain('add');
    expect(argLists).toContain('status');
    // No commit / push since no changes
    expect(argLists).not.toContain('commit');
    expect(argLists).not.toContain('push');
  });

  it('commits and pushes when there are changes', async () => {
    await updateBackupConfig({ repo: 'git@github.com:x/y.git', categories: 'projects' });

    gitHandler = async (args, cwd) => {
      if (args[0] === '--version') return { stdout: 'git version 2', stderr: '' };
      if (args[0] === 'clone') {
        await mkdir(resolve(String(cwd ?? args[args.length - 1]), '.git'), { recursive: true });
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'status' && args[1] === '--porcelain') {
        return { stdout: ' M projects/file.md\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };

    const result = await backupToGithub();
    expect(result.success).toBe(true);
    expect(result.committed).toBe(true);

    const gitCommands = gitCalls.map((c) => c.args[0]);
    expect(gitCommands).toContain('commit');
    expect(gitCommands).toContain('push');

    // Verify commit message includes timestamp
    const commitCall = gitCalls.find((c) => c.args[0] === 'commit');
    expect(commitCall?.args).toContain('-m');
    expect(commitCall?.args.join(' ')).toMatch(/Syntaur backup \d{4}-/);
  });

  it('reverts lastBackup when push fails', async () => {
    await updateBackupConfig({
      repo: 'git@github.com:x/y.git',
      categories: 'projects',
      lastBackup: '2020-01-01T00:00:00.000Z',
    });

    gitHandler = async (args, cwd) => {
      if (args[0] === '--version') return { stdout: 'git version 2', stderr: '' };
      if (args[0] === 'clone') {
        await mkdir(resolve(String(cwd ?? args[args.length - 1]), '.git'), { recursive: true });
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'status' && args[1] === '--porcelain') {
        return { stdout: ' M projects/x.md\n', stderr: '' };
      }
      if (args[0] === 'push') {
        throw new Error('remote rejected: non-fast-forward');
      }
      return { stdout: '', stderr: '' };
    };

    await expect(backupToGithub()).rejects.toThrow(/Push rejected/);

    const config = await readConfig();
    expect(config.backup?.lastBackup).toBe('2020-01-01T00:00:00.000Z');
  });
});

describe('restoreFromGithub flow', () => {
  const originalHome = process.env.HOME;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'syntaur-restore-flow-'));
    process.env.HOME = homeDir;
    await mkdir(resolve(homeDir, '.syntaur'), { recursive: true });
    await writeFile(
      resolve(homeDir, '.syntaur', 'config.md'),
      '---\nversion: "1.0"\ndefaultProjectDir: ~/projects\n---\n',
    );
    gitCalls.length = 0;
    gitHandler = async () => ({ stdout: '', stderr: '' });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    gitCalls.length = 0;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('skips config category (never overwrites local config.md)', async () => {
    await updateBackupConfig({ repo: 'git@github.com:x/y.git', categories: 'config' });

    // Mark local config with a sentinel
    const configPath = resolve(homeDir, '.syntaur', 'config.md');
    const before = await readFile(configPath, 'utf-8');

    gitHandler = async (args, cwd) => {
      if (args[0] === '--version') return { stdout: 'git version 2', stderr: '' };
      if (args[0] === 'clone') {
        const dest = String(cwd ?? args[args.length - 1]);
        await mkdir(resolve(dest, '.git'), { recursive: true });
        // Put a fake config.md in the clone
        await writeFile(resolve(dest, 'config.md'), '---\nbogus: overwrite\n---\n');
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };

    const result = await restoreFromGithub();
    expect(result.success).toBe(true);

    // Local config.md should still contain our original value (lastRestore updated in-place,
    // but the "bogus: overwrite" content from the fake repo should NOT be present).
    const after = await readFile(configPath, 'utf-8');
    expect(after).not.toContain('bogus: overwrite');
    // Before content should largely be preserved (defaultProjectDir still there)
    expect(after).toContain('defaultProjectDir:');
    // Original version should still match
    expect(before).toContain('defaultProjectDir:');
  });

  it('handles missing category in backup repo without throwing', async () => {
    await updateBackupConfig({ repo: 'git@github.com:x/y.git', categories: 'projects' });

    gitHandler = async (args, cwd) => {
      if (args[0] === '--version') return { stdout: 'git version 2', stderr: '' };
      if (args[0] === 'clone') {
        await mkdir(resolve(String(cwd ?? args[args.length - 1]), '.git'), { recursive: true });
        // Intentionally do not create 'projects/' in the clone
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };

    const result = await restoreFromGithub();
    expect(result.success).toBe(true);
  });

  it('persists lastRestore even on partial failure', async () => {
    await updateBackupConfig({ repo: 'git@github.com:x/y.git', categories: 'projects' });

    gitHandler = async (args, cwd) => {
      if (args[0] === '--version') return { stdout: 'git version 2', stderr: '' };
      if (args[0] === 'clone') {
        const dest = String(cwd ?? args[args.length - 1]);
        await mkdir(resolve(dest, '.git'), { recursive: true });
        await mkdir(resolve(dest, 'projects'), { recursive: true });
        await writeFile(resolve(dest, 'projects', 'readme.md'), '# hi\n');
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };

    const result = await restoreFromGithub();
    // Should succeed in copying the projects dir
    expect(result.success).toBe(true);

    const config = await readConfig();
    expect(config.backup?.lastRestore).toBe(result.timestamp);
  });

  it('leaves no staging/backup sibling dirs after successful restore', async () => {
    await updateBackupConfig({ repo: 'git@github.com:x/y.git', categories: 'projects' });

    gitHandler = async (args, cwd) => {
      if (args[0] === '--version') return { stdout: 'git version 2', stderr: '' };
      if (args[0] === 'clone') {
        const dest = String(cwd ?? args[args.length - 1]);
        await mkdir(resolve(dest, '.git'), { recursive: true });
        await mkdir(resolve(dest, 'projects', 'sub'), { recursive: true });
        await writeFile(resolve(dest, 'projects', 'sub', 'x.md'), 'data\n');
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };

    await restoreFromGithub();

    const config = await readConfig();
    const projectsPath = config.defaultProjectDir;
    const stagingPath = `${projectsPath}.syntaur-restore-staging`;
    const backupPath = `${projectsPath}.syntaur-restore-backup`;

    const { access } = await import('node:fs/promises');
    await expect(access(stagingPath)).rejects.toThrow();
    await expect(access(backupPath)).rejects.toThrow();
    // The restored data should be present
    await expect(access(resolve(projectsPath, 'sub', 'x.md'))).resolves.toBeUndefined();
  });

});

describe('safeRestoreCategory (direct)', () => {
  const originalHome = process.env.HOME;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'syntaur-safe-restore-'));
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('rolls back when cp fails (nonexistent source), preserving local data', async () => {
    const localPath = resolve(homeDir, 'data');
    await mkdir(localPath, { recursive: true });
    await writeFile(resolve(localPath, 'sentinel.md'), 'original\n');

    const nonexistentSrc = resolve(homeDir, 'definitely-not-here');

    await expect(safeRestoreCategory(localPath, nonexistentSrc, false)).rejects.toThrow();

    // Sentinel must be preserved
    const { access } = await import('node:fs/promises');
    await expect(access(resolve(localPath, 'sentinel.md'))).resolves.toBeUndefined();

    // Staging/backup siblings must be cleaned up
    await expect(access(`${localPath}.syntaur-restore-staging`)).rejects.toThrow();
    await expect(access(`${localPath}.syntaur-restore-backup`)).rejects.toThrow();
  });

  it('crash recovery: restores .syntaur-restore-backup when localPath is missing', async () => {
    const localPath = resolve(homeDir, 'data');
    const backupPath = `${localPath}.syntaur-restore-backup`;
    const repoSrc = resolve(homeDir, 'repo-src');

    // Simulate a prior crashed run: backup sibling exists, localPath does NOT
    await mkdir(backupPath, { recursive: true });
    await writeFile(resolve(backupPath, 'crashed-original.md'), 'data-from-crashed-run\n');

    // Prepare a valid repo source for the new restore
    await mkdir(repoSrc, { recursive: true });
    await writeFile(resolve(repoSrc, 'from-repo.md'), 'new\n');

    await safeRestoreCategory(localPath, repoSrc, false);

    const { access } = await import('node:fs/promises');
    // The backup sibling should have been renamed to localPath, then replaced by repo content.
    // Final state: localPath contains repo content, backup sibling is gone.
    await expect(access(resolve(localPath, 'from-repo.md'))).resolves.toBeUndefined();
    await expect(access(backupPath)).rejects.toThrow();
  });

  it('crash recovery: bails out when BOTH localPath and backup sibling exist', async () => {
    const localPath = resolve(homeDir, 'data');
    const backupPath = `${localPath}.syntaur-restore-backup`;
    const repoSrc = resolve(homeDir, 'repo-src');

    await mkdir(localPath, { recursive: true });
    await writeFile(resolve(localPath, 'current.md'), 'current\n');
    await mkdir(backupPath, { recursive: true });
    await writeFile(resolve(backupPath, 'stale.md'), 'stale\n');
    await mkdir(repoSrc, { recursive: true });

    await expect(safeRestoreCategory(localPath, repoSrc, false)).rejects.toThrow(
      /stale crash-recovery backup/,
    );

    // Both should still exist — we didn't destroy either
    const { access } = await import('node:fs/promises');
    await expect(access(resolve(localPath, 'current.md'))).resolves.toBeUndefined();
    await expect(access(resolve(backupPath, 'stale.md'))).resolves.toBeUndefined();
  });
});

describe('readSanitizedConfig', () => {
  const originalHome = process.env.HOME;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'syntaur-sanitize-'));
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('strips lastBackup and lastRestore timestamps', async () => {
    const configPath = resolve(homeDir, 'config.md');
    await writeFile(
      configPath,
      `---
version: "1.0"
defaultProjectDir: ~/projects
backup:
  repo: git@github.com:x/y.git
  categories: projects, playbooks
  lastBackup: 2026-04-16T12:00:00.000Z
  lastRestore: 2026-04-15T10:00:00.000Z
---

# body
`,
    );

    const sanitized = await readSanitizedConfig(configPath);

    expect(sanitized).toContain('lastBackup: null');
    expect(sanitized).toContain('lastRestore: null');
    expect(sanitized).not.toContain('2026-04-16T12:00:00.000Z');
    expect(sanitized).not.toContain('2026-04-15T10:00:00.000Z');

    // Other fields preserved
    expect(sanitized).toContain('repo: git@github.com:x/y.git');
    expect(sanitized).toContain('categories: projects, playbooks');
    expect(sanitized).toContain('defaultProjectDir: ~/projects');
    expect(sanitized).toContain('# body');
  });

  it('is idempotent: running twice produces same output', async () => {
    const configPath = resolve(homeDir, 'config.md');
    await writeFile(
      configPath,
      `---
version: "1.0"
backup:
  repo: git@github.com:x/y.git
  categories: projects
  lastBackup: 2026-01-01T00:00:00.000Z
  lastRestore: null
---
`,
    );

    const first = await readSanitizedConfig(configPath);
    await writeFile(configPath, first);
    const second = await readSanitizedConfig(configPath);

    expect(first).toBe(second);
  });
});

describe('backup self-diff prevention', () => {
  const originalHome = process.env.HOME;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'syntaur-no-selfdiff-'));
    process.env.HOME = homeDir;
    await mkdir(resolve(homeDir, '.syntaur'), { recursive: true });
    gitCalls.length = 0;
    gitHandler = async () => ({ stdout: '', stderr: '' });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    gitCalls.length = 0;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('sanitized config.md in the clone does NOT contain local timestamps', async () => {
    // Pre-seed config with a real lastBackup timestamp
    await writeFile(
      resolve(homeDir, '.syntaur', 'config.md'),
      `---
version: "1.0"
defaultProjectDir: ~/projects
backup:
  repo: git@github.com:x/y.git
  categories: config
  lastBackup: 2025-12-01T00:00:00.000Z
  lastRestore: null
---
`,
    );

    let clonedConfigContent: string | null = null;

    gitHandler = async (args, cwd) => {
      if (args[0] === '--version') return { stdout: 'git version 2', stderr: '' };
      if (args[0] === 'clone') {
        const dest = String(cwd ?? args[args.length - 1]);
        await mkdir(resolve(dest, '.git'), { recursive: true });
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'add') {
        // Capture the config.md content that was copied into the clone
        const dest = String(cwd);
        const { readFile } = await import('node:fs/promises');
        try {
          clonedConfigContent = await readFile(resolve(dest, 'config.md'), 'utf-8');
        } catch {
          // ignore
        }
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'status' && args[1] === '--porcelain') {
        return { stdout: ' A config.md\n', stderr: '' }; // simulate change
      }
      return { stdout: '', stderr: '' };
    };

    await backupToGithub();

    expect(clonedConfigContent).not.toBeNull();
    expect(clonedConfigContent).toContain('lastBackup: null');
    expect(clonedConfigContent).not.toContain('2025-12-01T00:00:00.000Z');
    // Local config has a real timestamp (updated by successful backup), NOT null.
    // Sanitization only applies to the copy in the clone, not the local file.
    const localConfig = await readFile(resolve(homeDir, '.syntaur', 'config.md'), 'utf-8');
    expect(localConfig).not.toContain('lastBackup: null');
    expect(localConfig).toMatch(/lastBackup: \d{4}-\d{2}-\d{2}T/);
  });
});

describe('deletion propagation', () => {
  const originalHome = process.env.HOME;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'syntaur-delete-prop-'));
    process.env.HOME = homeDir;
    await mkdir(resolve(homeDir, '.syntaur'), { recursive: true });
    await writeFile(
      resolve(homeDir, '.syntaur', 'config.md'),
      '---\nversion: "1.0"\ndefaultProjectDir: ~/projects\n---\n',
    );
    gitCalls.length = 0;
    gitHandler = async () => ({ stdout: '', stderr: '' });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    gitCalls.length = 0;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('clears remote category dir when local source is missing', async () => {
    await updateBackupConfig({ repo: 'git@github.com:x/y.git', categories: 'playbooks' });

    let remotePlaybooksPath: string | null = null;

    gitHandler = async (args, cwd) => {
      if (args[0] === '--version') return { stdout: 'git version 2', stderr: '' };
      if (args[0] === 'clone') {
        const dest = String(cwd ?? args[args.length - 1]);
        await mkdir(resolve(dest, '.git'), { recursive: true });
        // Pre-populate playbooks dir in the clone (simulates existing remote data)
        const playbooksDirInClone = resolve(dest, 'playbooks');
        await mkdir(playbooksDirInClone, { recursive: true });
        await writeFile(resolve(playbooksDirInClone, 'stale.md'), 'stale\n');
        remotePlaybooksPath = playbooksDirInClone;
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'status' && args[1] === '--porcelain') {
        // After copy, the playbooks dir in the clone should be GONE,
        // so status should show deletion
        const { access } = await import('node:fs/promises');
        if (remotePlaybooksPath) {
          try {
            await access(resolve(remotePlaybooksPath, 'stale.md'));
            return { stdout: '', stderr: '' }; // file still there = no deletion
          } catch {
            return { stdout: ' D playbooks/stale.md\n', stderr: '' }; // deletion detected
          }
        }
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };

    const result = await backupToGithub();
    expect(result.success).toBe(true);
    expect(result.committed).toBe(true); // deletion is a change

    // Verify the remote playbooks dir was cleared during the copy step
    const { access } = await import('node:fs/promises');
    if (remotePlaybooksPath) {
      await expect(access(resolve(remotePlaybooksPath, 'stale.md'))).rejects.toThrow();
    }
  });
});

describe('strict validation at runtime', () => {
  const originalHome = process.env.HOME;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'syntaur-strict-runtime-'));
    process.env.HOME = homeDir;
    await mkdir(resolve(homeDir, '.syntaur'), { recursive: true });
    gitCalls.length = 0;
    gitHandler = async () => ({ stdout: '', stderr: '' });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    gitCalls.length = 0;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('backupToGithub throws when stored categories contain unknown entry', async () => {
    // Hand-written config with an unknown category
    await writeFile(
      resolve(homeDir, '.syntaur', 'config.md'),
      `---
version: "1.0"
defaultProjectDir: ${resolve(homeDir, 'projects')}
backup:
  repo: git@github.com:x/y.git
  categories: projects, bogus
  lastBackup: null
  lastRestore: null
---
`,
    );

    await expect(backupToGithub()).rejects.toThrow(/Unknown categor.*bogus/);
  });

  it('restoreFromGithub throws when stored categories contain unknown entry', async () => {
    await writeFile(
      resolve(homeDir, '.syntaur', 'config.md'),
      `---
version: "1.0"
defaultProjectDir: ${resolve(homeDir, 'projects')}
backup:
  repo: git@github.com:x/y.git
  categories: projects, wrongcat
  lastBackup: null
  lastRestore: null
---
`,
    );

    await expect(restoreFromGithub()).rejects.toThrow(/Unknown categor.*wrongcat/);
  });

  it('backupToGithub trims whitespace-padded repo URL before clone', async () => {
    await writeFile(
      resolve(homeDir, '.syntaur', 'config.md'),
      '---\nversion: "1.0"\ndefaultProjectDir: ~/projects\n---\n',
    );
    // Manually persist a padded URL (simulate a pre-existing misconfiguration)
    await updateBackupConfig({ repo: '  git@github.com:x/y.git  ', categories: 'projects' });

    let cloneUrl: string | null = null;
    gitHandler = async (args, cwd) => {
      if (args[0] === '--version') return { stdout: 'git version 2', stderr: '' };
      if (args[0] === 'clone') {
        // The URL passed to clone should be trimmed
        cloneUrl = args[args.indexOf('clone') + args.slice(args.indexOf('clone')).findIndex((a) => a.startsWith('git@') || a.startsWith('https://'))];
        // Simpler: find the URL-looking arg
        cloneUrl = args.find((a) => a.startsWith('git@') || a.startsWith('https://')) ?? null;
        await mkdir(resolve(String(cwd ?? args[args.length - 1]), '.git'), { recursive: true });
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'status' && args[1] === '--porcelain') return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    };

    await backupToGithub();
    expect(cloneUrl).toBe('git@github.com:x/y.git');
  });
});
