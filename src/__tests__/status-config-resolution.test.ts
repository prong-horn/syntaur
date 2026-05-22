import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  scanAssignmentsByStatus,
  applyStatusResolutions,
  StatusResolutionError,
  type StatusResolution,
} from '../utils/status-config-resolution.js';

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

    expect(result).toEqual({ remapped: 1, deleted: 0 });
    const after = await readFile(path, 'utf-8');
    expect(getStatus(after)).toBe('draft');
    expect(getUpdated(after)).not.toBe(getUpdated(before));
    expect(after).toContain('title: a1');
    expect(after).toContain('priority: medium');
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

    expect(result).toEqual({ remapped: 0, deleted: 2 });
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

    expect(result).toEqual({ remapped: 1, deleted: 1 });
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
    expect(result).toEqual({ remapped: 0, deleted: 0 });
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

  it('rolls back remap writes on phase failure (restores originals from buffer)', async () => {
    // Seed two assignments; make the second's containing dir read-only AFTER
    // the buffer phase reads the original. We achieve this via two scans:
    // the buffer-reading happens with the dirs writable; then chmod restricts
    // before the write phase reaches the second file. But applyStatusResolutions
    // is one call — so we use the alphabetical ordering of the walker output
    // (a1 < a2) and pre-chmod a2's dir to readonly (0o555 — readable+executable
    // but not writable). The first write to a1 succeeds, then the second
    // write to a2's read-only dir fails (EACCES on macOS for replace).
    //
    // Subtlety: writeFile on an existing file inside a 0o555 dir CAN succeed
    // (the file exists; we're not unlinking). To force a failure, set the
    // *file itself* to 0o444 (read-only). writeFile then throws EACCES.

    const a1 = await seed(join(projectsDir, 'p1', 'assignments', 'a1'), 'a1', 'pending');
    const a2 = await seed(join(projectsDir, 'p1', 'assignments', 'a2'), 'a2', 'pending');
    const affected = await scanAssignmentsByStatus(projectsDir, null, ['pending']);
    // Confirm ordering: a1 < a2
    const sorted = affected.get('pending')!.slice().sort((x, y) => x.path.localeCompare(y.path));
    expect(sorted[0].path).toBe(a1);
    expect(sorted[1].path).toBe(a2);

    const original1 = await readFile(a1, 'utf-8');
    const original2 = await readFile(a2, 'utf-8');

    // Chmod a2's assignment.md to readonly so writeFile throws.
    const fs = await import('node:fs/promises');
    await fs.chmod(a2, 0o444);

    let restoredOriginal2 = false;
    try {
      await expect(
        applyStatusResolutions(
          [{ id: 'pending', mode: 'remap', target: 'draft' }],
          affected,
          new Set(['draft']),
        ),
      ).rejects.toMatchObject({ code: 'write-failed' });

      // a1 should be rolled back to original.
      expect(await readFile(a1, 'utf-8')).toBe(original1);
      // a2 should never have been mutated (write threw).
      expect(await readFile(a2, 'utf-8')).toBe(original2);
      restoredOriginal2 = true;
    } finally {
      // Restore perms before cleanup so afterEach can rm -rf.
      await fs.chmod(a2, 0o644).catch(() => {});
      if (!restoredOriginal2) {
        await fs.writeFile(a2, original2).catch(() => {});
      }
    }
  });
});
