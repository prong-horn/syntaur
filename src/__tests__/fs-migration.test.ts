import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  stat,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  migrateLegacyProjectFiles,
  migrateLegacyConfig,
  summarizeMigration,
} from '../utils/fs-migration.js';
import { parseProject } from '../dashboard/parser.js';

let sandbox: string;
let projectsDir: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-fsmig-'));
  projectsDir = resolve(sandbox, 'projects');
  await mkdir(projectsDir, { recursive: true });
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function seedProject(
  slug: string,
  files: Record<string, string>,
): Promise<void> {
  const dir = resolve(projectsDir, slug);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(resolve(dir, name), content, 'utf-8');
  }
}

describe('migrateLegacyProjectFiles', () => {
  it('renames mission.md → project.md when only the legacy file exists', async () => {
    await seedProject('proj-a', { 'mission.md': 'legacy body' });

    const result = await migrateLegacyProjectFiles(projectsDir);

    expect(result.renamedProjectFiles).toEqual(['proj-a/mission.md']);
    expect(existsSync(resolve(projectsDir, 'proj-a', 'mission.md'))).toBe(false);
    expect(existsSync(resolve(projectsDir, 'proj-a', 'project.md'))).toBe(true);
    const migrated = await readFile(
      resolve(projectsDir, 'proj-a', 'project.md'),
      'utf-8',
    );
    expect(migrated).toBe('legacy body');
  });

  it('skips a project that already has project.md (collision guard)', async () => {
    await seedProject('proj-both', {
      'mission.md': 'old body',
      'project.md': 'new body',
    });

    const result = await migrateLegacyProjectFiles(projectsDir);

    expect(result.renamedProjectFiles).toEqual([]);
    expect(existsSync(resolve(projectsDir, 'proj-both', 'mission.md'))).toBe(true);
    const project = await readFile(
      resolve(projectsDir, 'proj-both', 'project.md'),
      'utf-8',
    );
    expect(project).toBe('new body');
  });

  it('leaves projects that only have project.md untouched', async () => {
    await seedProject('proj-new', { 'project.md': 'already new' });

    const result = await migrateLegacyProjectFiles(projectsDir);

    expect(result.renamedProjectFiles).toEqual([]);
  });

  it('reports legacy agent.md and claude.md without deleting them', async () => {
    await seedProject('proj-extras', {
      'project.md': 'body',
      'agent.md': 'legacy agent instructions',
      'claude.md': 'legacy claude instructions',
    });

    const result = await migrateLegacyProjectFiles(projectsDir);

    expect(result.legacyExtras).toEqual(
      expect.arrayContaining(['proj-extras/agent.md', 'proj-extras/claude.md']),
    );
    expect(existsSync(resolve(projectsDir, 'proj-extras', 'agent.md'))).toBe(true);
    expect(existsSync(resolve(projectsDir, 'proj-extras', 'claude.md'))).toBe(true);
  });

  it('is idempotent — a second call after a first migration is a no-op', async () => {
    await seedProject('proj-a', { 'mission.md': 'body' });
    await migrateLegacyProjectFiles(projectsDir);
    const mtimeFirst = (
      await stat(resolve(projectsDir, 'proj-a', 'project.md'))
    ).mtimeMs;

    const second = await migrateLegacyProjectFiles(projectsDir);
    expect(second.renamedProjectFiles).toEqual([]);
    const mtimeSecond = (
      await stat(resolve(projectsDir, 'proj-a', 'project.md'))
    ).mtimeMs;
    expect(mtimeSecond).toBe(mtimeFirst);
  });

  it('returns empty arrays when projectsDir does not exist', async () => {
    const missing = resolve(sandbox, 'does-not-exist');
    const result = await migrateLegacyProjectFiles(missing);
    expect(result).toEqual({ renamedProjectFiles: [], legacyExtras: [] });
  });

  it('ignores dotfiles / hidden project dirs', async () => {
    const hiddenDir = resolve(projectsDir, '.cache');
    await mkdir(hiddenDir, { recursive: true });
    await writeFile(resolve(hiddenDir, 'mission.md'), 'x');

    const result = await migrateLegacyProjectFiles(projectsDir);
    expect(result.renamedProjectFiles).toEqual([]);
    expect(existsSync(resolve(hiddenDir, 'mission.md'))).toBe(true);
  });
});

describe('migrateLegacyConfig', () => {
  it('renames defaultMissionDir → defaultProjectDir in frontmatter', async () => {
    const configPath = resolve(sandbox, 'config.md');
    await writeFile(
      configPath,
      `---\nversion: "1.0"\ndefaultMissionDir: /tmp/my-projects\n---\nbody\n`,
      'utf-8',
    );

    const result = await migrateLegacyConfig(configPath);

    expect(result.renamedField).toBe(true);
    expect(result.resolvedProjectsDir).toBe('/tmp/my-projects');

    const updated = await readFile(configPath, 'utf-8');
    expect(updated).toContain('defaultProjectDir: /tmp/my-projects');
    expect(updated).not.toContain('defaultMissionDir');
    expect(updated).toContain('body');
  });

  it('is a no-op when only defaultProjectDir is present', async () => {
    const configPath = resolve(sandbox, 'config.md');
    const original = `---\nversion: "2.0"\ndefaultProjectDir: /tmp/p\n---\nbody\n`;
    await writeFile(configPath, original, 'utf-8');

    const result = await migrateLegacyConfig(configPath);

    expect(result.renamedField).toBe(false);
    expect(result.renamedDir).toBe(false);
    const after = await readFile(configPath, 'utf-8');
    expect(after).toBe(original);
  });

  it('strips a stale defaultMissionDir when both keys coexist', async () => {
    const configPath = resolve(sandbox, 'config.md');
    await writeFile(
      configPath,
      `---\nversion: "2.0"\ndefaultProjectDir: /tmp/keep\ndefaultMissionDir: /tmp/legacy\n---\n`,
      'utf-8',
    );

    const result = await migrateLegacyConfig(configPath);

    expect(result.renamedField).toBe(true);
    const after = await readFile(configPath, 'utf-8');
    expect(after).toContain('defaultProjectDir: /tmp/keep');
    expect(after).not.toContain('defaultMissionDir');
  });

  it('renames the on-disk missions directory when target does not exist', async () => {
    // This test uses its own side-sandbox so the beforeEach-created `projects/`
    // dir doesn't collide with the rename target.
    const side = await mkdtemp(join(tmpdir(), 'syntaur-fsmig-dir-'));
    try {
      const configPath = resolve(side, 'config.md');
      const missionsDir = resolve(side, 'missions');
      await mkdir(missionsDir, { recursive: true });
      await writeFile(resolve(missionsDir, 'sentinel'), 'x');
      await writeFile(
        configPath,
        `---\nversion: "1.0"\ndefaultMissionDir: ${missionsDir}\n---\n`,
        'utf-8',
      );

      const result = await migrateLegacyConfig(configPath);

      expect(result.renamedField).toBe(true);
      expect(result.renamedDir).toBe(true);
      const renamedProjectsDir = resolve(side, 'projects');
      expect(existsSync(renamedProjectsDir)).toBe(true);
      expect(existsSync(resolve(renamedProjectsDir, 'sentinel'))).toBe(true);
      expect(existsSync(missionsDir)).toBe(false);

      const after = await readFile(configPath, 'utf-8');
      expect(after).toContain(`defaultProjectDir: ${renamedProjectsDir}`);
    } finally {
      await rm(side, { recursive: true, force: true });
    }
  });

  it('skips directory rename when projects dir already exists', async () => {
    const configPath = resolve(sandbox, 'config.md');
    const missionsDir = resolve(sandbox, 'missions');
    const projectsDirPath = resolve(sandbox, 'projects');
    await mkdir(missionsDir, { recursive: true });
    await mkdir(projectsDirPath, { recursive: true });
    await writeFile(
      configPath,
      `---\ndefaultMissionDir: ${missionsDir}\n---\n`,
      'utf-8',
    );

    const result = await migrateLegacyConfig(configPath);

    // Field still renames (safe), but the on-disk dir is preserved.
    expect(result.renamedField).toBe(true);
    expect(result.renamedDir).toBe(false);
    expect(existsSync(missionsDir)).toBe(true);
    expect(existsSync(projectsDirPath)).toBe(true);
  });

  it('returns cleanly when config.md is missing', async () => {
    const result = await migrateLegacyConfig(resolve(sandbox, 'nope.md'));
    expect(result).toEqual({
      renamedField: false,
      renamedDir: false,
      resolvedProjectsDir: null,
    });
  });

  it('is idempotent across multiple calls', async () => {
    const configPath = resolve(sandbox, 'config.md');
    await writeFile(
      configPath,
      `---\ndefaultMissionDir: /tmp/a\n---\n`,
      'utf-8',
    );
    await migrateLegacyConfig(configPath);
    const afterFirst = await readFile(configPath, 'utf-8');
    const result = await migrateLegacyConfig(configPath);
    const afterSecond = await readFile(configPath, 'utf-8');
    expect(result.renamedField).toBe(false);
    expect(afterSecond).toBe(afterFirst);
  });
});

describe('summarizeMigration', () => {
  it('returns an empty string when nothing migrated', () => {
    const s = summarizeMigration(
      { renamedProjectFiles: [], legacyExtras: [] },
      { renamedField: false, renamedDir: false, resolvedProjectsDir: null },
    );
    expect(s).toBe('');
  });

  it('mentions every category of change concisely', () => {
    const s = summarizeMigration(
      {
        renamedProjectFiles: ['a/mission.md', 'b/mission.md', 'c/mission.md', 'd/mission.md'],
        legacyExtras: ['a/agent.md'],
      },
      { renamedField: true, renamedDir: true, resolvedProjectsDir: '/tmp/p' },
    );
    expect(s).toContain('4 projects');
    expect(s).toContain('a, b, c');
    expect(s).toContain('and 1 more');
    expect(s).toContain('defaultProjectDir');
    expect(s).toContain('renamed projects directory');
    expect(s).toContain('1 legacy');
  });
});

describe('parser alias: mission → project', () => {
  it('parseProject reads a legacy `mission:` field as slug', () => {
    const fm = `---\nid: p-123\nmission: legacy-slug\ntitle: Legacy Project\nstatus: pending\ncreated: "2026-01-01T00:00:00Z"\nupdated: "2026-01-01T00:00:00Z"\ntags: []\n---\n\n# Legacy Project\n`;
    const parsed = parseProject(fm);
    expect(parsed.slug).toBe('legacy-slug');
    expect(parsed.title).toBe('Legacy Project');
  });

  it('parseProject still prefers slug when both are present', () => {
    const fm = `---\nslug: new-slug\nmission: old-slug\ntitle: t\ncreated: ""\nupdated: ""\ntags: []\n---\n\nbody\n`;
    const parsed = parseProject(fm);
    expect(parsed.slug).toBe('new-slug');
  });
});
