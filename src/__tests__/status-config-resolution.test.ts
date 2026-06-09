import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  scanAssignmentsByStatus,
  applyStatusResolutions,
  verifyNoDriftedOrphans,
  StatusResolutionError,
  type StatusResolution,
} from '../utils/status-config-resolution.js';
import { parseAssignmentFrontmatter } from '../lifecycle/frontmatter.js';

let root: string;
let projectsDir: string;
let standaloneDir: string;

async function seed(
  dir: string,
  slug: string,
  status: string,
  extras: { updated?: string } = {},
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const md = `---
id: 11111111-1111-1111-1111-${slug.padEnd(12, '0').slice(0, 12)}
slug: ${slug}
title: ${slug}
status: ${status}
priority: medium
created: "2026-01-01T00:00:00Z"
updated: "${extras.updated ?? '2026-01-01T00:00:00Z'}"
assignee: null
externalIds: []
dependsOn: []
links: []
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# ${slug}
`;
  const p = join(dir, 'assignment.md');
  await writeFile(p, md);
  return p;
}

async function fileGone(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}

function getStatus(content: string): string {
  return content.match(/^status:\s*(\S+)/m)?.[1] ?? '';
}

function getUpdated(content: string): string {
  return content.match(/^updated:\s*"?([^"\n]+)"?/m)?.[1] ?? '';
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'syntaur-status-res-'));
  projectsDir = join(root, 'projects');
  standaloneDir = join(root, 'standalone');
  await mkdir(projectsDir, { recursive: true });
  await mkdir(standaloneDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('scanAssignmentsByStatus', () => {
  it('groups by status across project + standalone trees', async () => {
    await seed(join(projectsDir, 'p1', 'assignments', 'a1'), 'a1', 'pending');
    await seed(join(projectsDir, 'p1', 'assignments', 'a2'), 'a2', 'pending');
    await seed(join(projectsDir, 'p1', 'assignments', 'a3'), 'a3', 'in_progress');
    await seed(join(standaloneDir, 'uuid-1'), 'uuid-1', 'pending');

    const result = await scanAssignmentsByStatus(projectsDir, standaloneDir, ['pending', 'in_progress']);

    expect(result.get('pending')).toHaveLength(3);
    expect(result.get('in_progress')).toHaveLength(1);
    const pendingDisplays = result.get('pending')!.map((a) => a.display).sort();
    expect(pendingDisplays).toEqual(['(standalone) uuid-1', 'p1/a1', 'p1/a2']);
  });

  it('returns an empty array for queried ids that have zero matches', async () => {
    await seed(join(projectsDir, 'p1', 'assignments', 'a1'), 'a1', 'pending');

    const result = await scanAssignmentsByStatus(projectsDir, standaloneDir, ['pending', 'nonexistent']);

    expect(result.get('pending')).toHaveLength(1);
    expect(result.get('nonexistent')).toEqual([]);
  });

  it('treats standaloneDir=null as skip-standalone', async () => {
    await seed(join(projectsDir, 'p1', 'assignments', 'a1'), 'a1', 'pending');
    await seed(join(standaloneDir, 'uuid-1'), 'uuid-1', 'pending');

    const result = await scanAssignmentsByStatus(projectsDir, null, ['pending']);

    expect(result.get('pending')).toHaveLength(1);
    expect(result.get('pending')![0].assignmentSlug).toBe('a1');
  });
});

describe('applyStatusResolutions', () => {
  it('remap-only: rewrites status + updated, leaves other fields intact', async () => {
    const path = await seed(join(projectsDir, 'p1', 'assignments', 'a1'), 'a1', 'pending');
    const affected = await scanAssignmentsByStatus(projectsDir, null, ['pending']);

    const before = await readFile(path, 'utf-8');
    const result = await applyStatusResolutions(
      [{ id: 'pending', mode: 'remap', target: 'draft' }],
      affected,
      new Set(['draft', 'in_progress']),
    );

    expect(result.remapped).toBe(1);
    expect(result.deleted).toBe(0);
    expect(result.byId.get('pending')).toEqual({ mode: 'remap', count: 1, target: 'draft' });
    const after = await readFile(path, 'utf-8');
    expect(getStatus(after)).toBe('draft');
    expect(getUpdated(after)).not.toBe(getUpdated(before));
    expect(after).toContain('title: a1');
    expect(after).toContain('priority: medium');
  });

  it('remap appends a statusHistory entry (command: remap, correct from/to)', async () => {
    const path = await seed(join(projectsDir, 'p1', 'assignments', 'a1'), 'a1', 'pending');
    const affected = await scanAssignmentsByStatus(projectsDir, null, ['pending']);

    await applyStatusResolutions(
      [{ id: 'pending', mode: 'remap', target: 'draft' }],
      affected,
      new Set(['draft', 'in_progress']),
    );

    const fm = parseAssignmentFrontmatter(await readFile(path, 'utf-8'));
    expect(fm.statusHistory).toHaveLength(1);
    expect(fm.statusHistory[0]).toMatchObject({
      from: 'pending',
      to: 'draft',
      command: 'remap',
      by: null,
    });
    // the appended `at` matches the bumped `updated`
    expect(fm.statusHistory[0].at).toBe(fm.updated);
  });

  it('delete-only: removes assignment directories', async () => {
    const p1 = await seed(join(projectsDir, 'p1', 'assignments', 'a1'), 'a1', 'pending');
    const p2 = await seed(join(projectsDir, 'p1', 'assignments', 'a2'), 'a2', 'pending');
    const affected = await scanAssignmentsByStatus(projectsDir, null, ['pending']);

    const result = await applyStatusResolutions(
      [{ id: 'pending', mode: 'delete' }],
      affected,
      new Set(['draft']),
    );

    expect(result.remapped).toBe(0);
    expect(result.deleted).toBe(2);
    expect(result.byId.get('pending')).toEqual({ mode: 'delete', count: 2 });
    expect(await fileGone(p1)).toBe(true);
    expect(await fileGone(p2)).toBe(true);
  });

  it('mixed remap + delete across different status ids', async () => {
    const r1 = await seed(join(projectsDir, 'p1', 'assignments', 'r1'), 'r1', 'pending');
    const d1 = await seed(join(projectsDir, 'p1', 'assignments', 'd1'), 'd1', 'review');
    const affected = await scanAssignmentsByStatus(projectsDir, null, ['pending', 'review']);

    const result = await applyStatusResolutions(
      [
        { id: 'pending', mode: 'remap', target: 'draft' },
        { id: 'review', mode: 'delete' },
      ],
      affected,
      new Set(['draft']),
    );

    expect(result.remapped).toBe(1);
    expect(result.deleted).toBe(1);
    expect(getStatus(await readFile(r1, 'utf-8'))).toBe('draft');
    expect(await fileGone(d1)).toBe(true);
  });

  it('zero-affected resolution is a no-op (counts as 0)', async () => {
    const affected = await scanAssignmentsByStatus(projectsDir, null, ['pending']);
    const result = await applyStatusResolutions(
      [{ id: 'pending', mode: 'remap', target: 'draft' }],
      affected,
      new Set(['draft']),
    );
    expect(result.remapped).toBe(0);
    expect(result.deleted).toBe(0);
  });

  it('throws duplicate-id when two resolutions share the same id', async () => {
    await seed(join(projectsDir, 'p1', 'assignments', 'a1'), 'a1', 'pending');
    const affected = await scanAssignmentsByStatus(projectsDir, null, ['pending']);

    await expect(
      applyStatusResolutions(
        [
          { id: 'pending', mode: 'remap', target: 'draft' },
          { id: 'pending', mode: 'delete' },
        ],
        affected,
        new Set(['draft']),
      ),
    ).rejects.toThrow(StatusResolutionError);
  });

  it('throws stale-resolution when id was not scanned', async () => {
    await seed(join(projectsDir, 'p1', 'assignments', 'a1'), 'a1', 'pending');
    const affected = await scanAssignmentsByStatus(projectsDir, null, ['pending']);

    await expect(
      applyStatusResolutions(
        [{ id: 'unscanned', mode: 'delete' }],
        affected,
        new Set(['draft']),
      ),
    ).rejects.toMatchObject({ code: 'stale-resolution' });
  });

  it('throws invalid-target when target is not in validTargets', async () => {
    await seed(join(projectsDir, 'p1', 'assignments', 'a1'), 'a1', 'pending');
    const affected = await scanAssignmentsByStatus(projectsDir, null, ['pending']);

    await expect(
      applyStatusResolutions(
        [{ id: 'pending', mode: 'remap', target: 'brand-new-status' }],
        affected,
        new Set(['draft']),
      ),
    ).rejects.toMatchObject({ code: 'invalid-target' });
  });

  it('throws invalid-target when target equals source id', async () => {
    await seed(join(projectsDir, 'p1', 'assignments', 'a1'), 'a1', 'pending');
    const affected = await scanAssignmentsByStatus(projectsDir, null, ['pending']);

    await expect(
      applyStatusResolutions(
        [{ id: 'pending', mode: 'remap', target: 'pending' }],
        affected,
        new Set(['pending']),
      ),
    ).rejects.toMatchObject({ code: 'invalid-target' });
  });

  it('TOCTOU: skips a remap whose status drifted between scan and apply', async () => {
    const path = await seed(join(projectsDir, 'p1', 'assignments', 'a1'), 'a1', 'pending');
    await seed(join(projectsDir, 'p1', 'assignments', 'a2'), 'a2', 'pending');
    const affected = await scanAssignmentsByStatus(projectsDir, null, ['pending']);

    // Mutate the file under us — simulate a concurrent CLI write.
    const drifted = (await readFile(path, 'utf-8')).replace('status: pending', 'status: completed');
    await writeFile(path, drifted);

    const result = await applyStatusResolutions(
      [{ id: 'pending', mode: 'remap', target: 'draft' }],
      affected,
      new Set(['draft']),
    );

    expect(result.remapped).toBe(1); // a2 got remapped; a1 was skipped
    expect(getStatus(await readFile(path, 'utf-8'))).toBe('completed'); // untouched
  });

  it('TOCTOU: skips a delete whose status drifted between scan and apply', async () => {
    const driftedPath = await seed(join(projectsDir, 'p1', 'assignments', 'a1'), 'a1', 'pending');
    const stablePath = await seed(join(projectsDir, 'p1', 'assignments', 'a2'), 'a2', 'pending');
    const affected = await scanAssignmentsByStatus(projectsDir, null, ['pending']);

    const drifted = (await readFile(driftedPath, 'utf-8')).replace('status: pending', 'status: in_progress');
    await writeFile(driftedPath, drifted);

    const result = await applyStatusResolutions(
      [{ id: 'pending', mode: 'delete' }],
      affected,
      new Set(['draft']),
    );

    expect(result.deleted).toBe(1);
    expect(await fileGone(driftedPath)).toBe(false);
    expect(await fileGone(stablePath)).toBe(true);
  });

  it('rolls back remap writes on phase failure (proves write happened then restored from buffer via mtime check)', async () => {
    // Iterate the walker order (apply does NOT sort), so the FIRST entry
    // gets written and succeeds; the SECOND has assignment.md chmod 0o444
    // and writeFile throws EACCES. Buffer rollback must restore the first
    // file byte-for-byte. We additionally check that the first file's
    // mtime advanced — proving an actual write happened, not just that the
    // implementation skipped the loop without doing anything.
    const { stat, chmod, utimes } = await import('node:fs/promises');

    await seed(join(projectsDir, 'p1', 'assignments', 'a1'), 'a1', 'pending');
    await seed(join(projectsDir, 'p1', 'assignments', 'a2'), 'a2', 'pending');
    const affected = await scanAssignmentsByStatus(projectsDir, null, ['pending']);
    const list = affected.get('pending')!;
    expect(list).toHaveLength(2);

    const original1 = await readFile(list[0].path, 'utf-8');
    const original2 = await readFile(list[1].path, 'utf-8');

    // Backdate the first file's mtime so a successful write will move it forward.
    const past = new Date('2020-01-01T00:00:00Z');
    await utimes(list[0].path, past, past);
    const mtimeBefore = (await stat(list[0].path)).mtimeMs;

    await chmod(list[1].path, 0o444);

    try {
      await expect(
        applyStatusResolutions(
          [{ id: 'pending', mode: 'remap', target: 'draft' }],
          affected,
          new Set(['draft']),
        ),
      ).rejects.toMatchObject({ code: 'write-failed' });

      expect(await readFile(list[0].path, 'utf-8')).toBe(original1);
      expect(await readFile(list[1].path, 'utf-8')).toBe(original2);
      const mtimeAfter = (await stat(list[0].path)).mtimeMs;
      expect(mtimeAfter).toBeGreaterThan(mtimeBefore);
    } finally {
      await chmod(list[1].path, 0o644).catch(() => {});
    }
  });

  it('throws scan-failed on a non-ENOENT read error (e.g. permission denied)', async () => {
    const { chmod } = await import('node:fs/promises');
    const a1 = await seed(join(projectsDir, 'p1', 'assignments', 'a1'), 'a1', 'pending');
    // Strip ALL read perms so readFile throws EACCES.
    await chmod(a1, 0o000);
    try {
      await expect(
        scanAssignmentsByStatus(projectsDir, null, ['pending']),
      ).rejects.toMatchObject({ code: 'scan-failed' });
    } finally {
      await chmod(a1, 0o644).catch(() => {});
    }
  });
});

describe('verifyNoDriftedOrphans', () => {
  it('no-op when no assignment still references a dropped id', async () => {
    await seed(join(projectsDir, 'p1', 'assignments', 'a1'), 'a1', 'in_progress');
    // Nothing references 'pending'.
    await expect(
      verifyNoDriftedOrphans(projectsDir, null, ['pending']),
    ).resolves.toBeUndefined();
  });

  it('throws drift-detected when an assignment references a dropped id', async () => {
    await seed(join(projectsDir, 'p1', 'assignments', 'a1'), 'a1', 'in_progress');
    await seed(join(projectsDir, 'p1', 'assignments', 'a2'), 'a2', 'pending');
    await expect(
      verifyNoDriftedOrphans(projectsDir, null, ['pending']),
    ).rejects.toMatchObject({ code: 'drift-detected' });
  });

  it('catches cross-id drift (assignment moved A→B while both are being dropped)', async () => {
    // Seed under "review" (we'll claim we scanned this as "pending").
    const driftedPath = await seed(join(projectsDir, 'p1', 'assignments', 'a1'), 'a1', 'review');
    // applyStatusResolutions for [pending, review] would skip a1 for pending (status drifted)
    // and not even include it in 'review' (scan was for pending only).
    // verifyNoDriftedOrphans with both ids catches it.
    await expect(
      verifyNoDriftedOrphans(projectsDir, null, ['pending', 'review']),
    ).rejects.toMatchObject({ code: 'drift-detected' });
    // Ensure the file is still on its drifted status (we didn't mutate it).
    expect(getStatus(await readFile(driftedPath, 'utf-8'))).toBe('review');
  });
});
