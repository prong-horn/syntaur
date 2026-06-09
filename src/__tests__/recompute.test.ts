import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_DERIVE_CONFIG } from '../utils/config.js';
import { recomputeAndWrite, recomputeAll, recomputeDependents, type DeriveContext } from '../lifecycle/recompute.js';
import { parseAssignmentFrontmatter } from '../lifecycle/frontmatter.js';
import { planDigest } from '../lifecycle/facts.js';

const CONTEXT: DeriveContext = {
  derive: DEFAULT_DERIVE_CONFIG,
  terminalStatuses: new Set(['completed', 'failed']),
  knownStatusIds: new Set([
    'draft',
    'pending',
    'ready_for_planning',
    'ready_to_implement',
    'in_progress',
    'blocked',
    'review',
    'completed',
    'failed',
  ]),
};

const tmpDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

function assignmentContent(opts: {
  slug?: string;
  status?: string;
  body?: string;
  extraFm?: string;
  dependsOn?: string[];
  blockedReason?: string;
}): string {
  const deps =
    opts.dependsOn && opts.dependsOn.length > 0
      ? `dependsOn:\n${opts.dependsOn.map((d) => `  - ${d}`).join('\n')}`
      : 'dependsOn: []';
  return `---
id: ${opts.slug ?? 'test'}-id
slug: ${opts.slug ?? 'test'}
title: "Test"
status: ${opts.status ?? 'draft'}
priority: medium
created: "2026-06-09T10:00:00Z"
updated: "2026-06-09T10:00:00Z"
assignee: null
externalIds: []
${deps}
links: []
blockedReason: ${opts.blockedReason ? `"${opts.blockedReason}"` : 'null'}
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
${opts.extraFm ?? ''}
---

# Test
${opts.body ?? `
## Objective

Real objective text.

## Acceptance Criteria

- [ ] First real criterion
- [ ] Second real criterion
`}`;
}

async function makeAssignment(opts: Parameters<typeof assignmentContent>[0] = {}): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'syntaur-recompute-'));
  tmpDirs.push(dir);
  const path = join(dir, 'assignment.md');
  await writeFile(path, assignmentContent(opts));
  return { dir, path };
}

describe('recomputeAndWrite', () => {
  it('derives and writes status/phase/disposition + history entry on change', async () => {
    const { path } = await makeAssignment({ status: 'draft' });
    const result = await recomputeAndWrite(path, {
      cause: 'derive',
      by: 'system',
      projectDir: null,
      context: CONTEXT,
    });
    expect(result.changed).toBe(true);
    expect(result.status).toBe('ready_for_planning'); // real objective + ACs

    const fm = parseAssignmentFrontmatter(await readFile(path, 'utf-8'));
    expect(fm.status).toBe('ready_for_planning');
    expect(fm.phase).toBe('ready_for_planning');
    expect(fm.disposition).toBe('active');
    expect(fm.statusHistory).toHaveLength(1);
    expect(fm.statusHistory[0]).toMatchObject({
      from: 'draft',
      to: 'ready_for_planning',
      command: 'derive',
      by: 'system',
      phaseTo: 'ready_for_planning',
      dispositionTo: 'active',
    });
  });

  it('no-op stability: recompute twice ⇒ exactly one history entry', async () => {
    const { path } = await makeAssignment();
    const opts = { cause: 'derive', by: 'system', projectDir: null, context: CONTEXT };
    const r1 = await recomputeAndWrite(path, opts);
    const r2 = await recomputeAndWrite(path, opts);
    expect(r1.changed).toBe(true);
    expect(r2.changed).toBe(false);
    const fm = parseAssignmentFrontmatter(await readFile(path, 'utf-8'));
    expect(fm.statusHistory).toHaveLength(1);
  });

  it('terminal assignments defer entirely — no write, no entry', async () => {
    const { path } = await makeAssignment({ status: 'completed' });
    const before = await readFile(path, 'utf-8');
    const result = await recomputeAndWrite(path, {
      cause: 'derive',
      by: 'system',
      projectDir: null,
      context: CONTEXT,
    });
    expect(result.deferredTerminal).toBe(true);
    expect(result.changed).toBe(false);
    expect(await readFile(path, 'utf-8')).toBe(before);
  });

  it('phase change under an unchanged headline is recorded (from == to + phase keys)', async () => {
    const planContent = '# plan';
    const { dir, path } = await makeAssignment({
      status: 'draft',
      blockedReason: 'vendor down',
    });
    // first recompute: blocked headline, phase ready_for_planning
    const opts = { cause: 'derive', by: 'system', projectDir: null, context: CONTEXT };
    await recomputeAndWrite(path, opts);
    let fm = parseAssignmentFrontmatter(await readFile(path, 'utf-8'));
    expect(fm.status).toBe('blocked');
    expect(fm.phase).toBe('ready_for_planning');

    // now a plan lands + is approved → phase advances while headline stays blocked
    await writeFile(join(dir, 'plan.md'), planContent);
    let content = await readFile(path, 'utf-8');
    content = content.replace(
      'tags: []',
      `tags: []\nplanApproval:\n  file: plan.md\n  digest: ${planDigest(planContent)}\n  by: human\n  at: "2026-06-09T11:00:00Z"`,
    );
    await writeFile(path, content);

    const r = await recomputeAndWrite(path, opts);
    expect(r.changed).toBe(true);
    fm = parseAssignmentFrontmatter(await readFile(path, 'utf-8'));
    expect(fm.status).toBe('blocked'); // headline unchanged
    expect(fm.phase).toBe('ready_to_implement'); // phase advanced
    const last = fm.statusHistory[fm.statusHistory.length - 1];
    expect(last.from).toBe('blocked');
    expect(last.to).toBe('blocked');
    expect(last.phaseFrom).toBe('ready_for_planning');
    expect(last.phaseTo).toBe('ready_to_implement');
  });

  it('concurrent recomputes serialize via the lock (no duplicate entries)', async () => {
    const { path } = await makeAssignment();
    const opts = { cause: 'derive', by: 'system', projectDir: null, context: CONTEXT };
    const results = await Promise.all([
      recomputeAndWrite(path, opts),
      recomputeAndWrite(path, opts),
      recomputeAndWrite(path, opts),
    ]);
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    const fm = parseAssignmentFrontmatter(await readFile(path, 'utf-8'));
    expect(fm.statusHistory).toHaveLength(1);
  });

  it('stale lock is taken over', async () => {
    const { dir, path } = await makeAssignment();
    const lockPath = join(dir, '.derive.lock');
    await writeFile(lockPath, '99999 1'); // ancient mtime? mtime is now — simulate via utimes
    const { utimes } = await import('node:fs/promises');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    const result = await recomputeAndWrite(path, {
      cause: 'derive',
      by: 'system',
      projectDir: null,
      context: CONTEXT,
    });
    expect(result.changed).toBe(true);
  });
});

describe('recomputeDependents + recomputeAll', () => {
  it('reverse-dependency: dependent re-derives when its dep goes terminal', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'syntaur-proj-'));
    tmpDirs.push(projectDir);
    await mkdir(join(projectDir, 'assignments', 'dep-a'), { recursive: true });
    await mkdir(join(projectDir, 'assignments', 'dep-b'), { recursive: true });
    await writeFile(
      join(projectDir, 'assignments', 'dep-a', 'assignment.md'),
      assignmentContent({ slug: 'dep-a', status: 'completed' }),
    );
    await writeFile(
      join(projectDir, 'assignments', 'dep-b', 'assignment.md'),
      assignmentContent({ slug: 'dep-b', status: 'draft', dependsOn: ['dep-a'] }),
    );
    const results = await recomputeDependents(projectDir, 'dep-a', {
      cause: 'dep-terminal',
      by: 'system',
      context: CONTEXT,
    });
    expect(results).toHaveLength(1);
    expect(results[0].changed).toBe(true);
  });

  it('recomputeAll sweeps projects + standalone and reports a summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'syntaur-root-'));
    tmpDirs.push(root);
    const projectsDir = join(root, 'projects');
    const standaloneDir = join(root, 'assignments');
    await mkdir(join(projectsDir, 'p1', 'assignments', 'a1'), { recursive: true });
    await mkdir(join(standaloneDir, 'u1'), { recursive: true });
    await writeFile(
      join(projectsDir, 'p1', 'assignments', 'a1', 'assignment.md'),
      assignmentContent({ slug: 'a1' }),
    );
    await writeFile(join(standaloneDir, 'u1', 'assignment.md'), assignmentContent({ slug: 'u1', status: 'completed' }));

    const summary = await recomputeAll(projectsDir, standaloneDir, {
      cause: 'sweep',
      by: 'system',
      context: CONTEXT,
    });
    expect(summary.scanned).toBe(2);
    expect(summary.changed).toBe(1);
    expect(summary.deferredTerminal).toBe(1);
    expect(summary.warnings).toEqual([]);
  });
});
