import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildIndex } from '../search/indexer.js';
import { FuseProvider } from '../search/fuse-provider.js';
import type { SearchDoc } from '../search/types.js';

let root: string;
let projectsDir: string;
let assignmentsDir: string;

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'syntaur-search-'));
  projectsDir = join(root, 'projects');
  assignmentsDir = join(root, 'assignments');
  await mkdir(projectsDir, { recursive: true });
  await mkdir(assignmentsDir, { recursive: true });

  // ── project "alpha" with workspace, one nested assignment, one memory ─────
  const alpha = join(projectsDir, 'alpha');
  await write(
    join(alpha, 'project.md'),
    `---\nid: p-alpha\nslug: alpha\ntitle: Alpha\nworkspace: alpha-ws\narchived: false\n---\n# Alpha project\n`,
  );
  const aDir = join(alpha, 'assignments', 'build-widget');
  await write(
    join(aDir, 'assignment.md'),
    `---\nid: asg-001\nslug: build-widget\ntitle: Build Widget\ntype: feature\nstatus: in_progress\narchived: false\n---\n# Build Widget\n\nWe must construct the flux capacitor.\n`,
  );
  // latest plan = plan-v2.md (plan.md is v1, must NOT be indexed)
  await write(
    join(aDir, 'plan.md'),
    `---\nassignment: asg-001\n---\n# Old Plan v1\n\nObsolete approach.\n`,
  );
  await write(
    join(aDir, 'plan-v2.md'),
    `---\nassignment: asg-001\n---\n# Plan v2\n\nThe approved strawberry approach.\n`,
  );
  await write(
    join(aDir, 'comments.md'),
    `---\nassignment: asg-001\nentryCount: 1\n---\n## c1\n**Recorded:** 2026-01-01\n**Author:** brennen\n**Type:** question\n\nIs the pineapple ready?\n`,
  );
  await write(
    join(alpha, 'memories', 'shell-config.md'),
    `---\nname: Shell config\nscope: project\n---\n# Shell config\n\nAlways use zsh banana profile.\n`,
  );
  await write(
    join(alpha, 'memories', '_index.md'),
    `---\n---\n# index (should be skipped)\n`,
  );

  // ── standalone assignment ─────────────────────────────────────────────────
  const sDir = join(assignmentsDir, 'uuid-standalone');
  await write(
    join(sDir, 'assignment.md'),
    `---\nid: asg-standalone\nslug: oneoff\ntitle: One Off\ntype: chore\nstatus: pending\narchived: false\n---\n# One Off\n\nStandalone kiwi task.\n`,
  );

  // ── archived assignment (excluded by default) ─────────────────────────────
  const arDir = join(alpha, 'assignments', 'old-task');
  await write(
    join(arDir, 'assignment.md'),
    `---\nid: asg-arch\nslug: old-task\ntitle: Old Task\ntype: chore\nstatus: completed\narchived: true\n---\n# Old Task\n\nArchived dragonfruit work.\n`,
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function find(docs: SearchDoc[], fileKind: string, slug: string | null): SearchDoc | undefined {
  return docs.find((d) => d.fileKind === fileKind && (slug === null || d.assignmentSlug === slug || d.itemSlug === slug));
}

describe('buildIndex', () => {
  it('emits a doc per file kind across assignments, sidecars, memories', async () => {
    const docs = await buildIndex({ projectsDir, assignmentsDir });
    const kinds = docs.map((d) => d.fileKind).sort();
    expect(kinds).toContain('assignment');
    expect(kinds).toContain('plan');
    expect(kinds).toContain('comments');
    expect(kinds).toContain('memory');
    // assignment.md present for nested + standalone (archived excluded by default).
    // Note: assignmentSlug is the folder name (the walker's slug), so the
    // standalone folder "uuid-standalone" is the slug, not the frontmatter "oneoff".
    const assignmentDocs = docs.filter((d) => d.fileKind === 'assignment');
    expect(assignmentDocs.map((d) => d.assignmentSlug).sort()).toEqual([
      'build-widget',
      'uuid-standalone',
    ]);
  });

  it('indexes only the latest plan (plan-v2, not plan.md)', async () => {
    const docs = await buildIndex({ projectsDir, assignmentsDir });
    const planDocs = docs.filter((d) => d.fileKind === 'plan');
    expect(planDocs).toHaveLength(1);
    expect(planDocs[0].path).toMatch(/plan-v2\.md$/);
    expect(planDocs[0].body).toContain('strawberry');
    expect(planDocs[0].body).not.toContain('Obsolete');
  });

  it('excludes archived assignments unless includeArchived', async () => {
    const docs = await buildIndex({ projectsDir, assignmentsDir });
    expect(docs.some((d) => d.assignmentSlug === 'old-task')).toBe(false);

    const withArchived = await buildIndex({ projectsDir, assignmentsDir, includeArchived: true });
    expect(withArchived.some((d) => d.assignmentSlug === 'old-task')).toBe(true);
  });

  it('stamps the project workspace on every project-owned doc', async () => {
    const docs = await buildIndex({ projectsDir, assignmentsDir });
    const alphaDocs = docs.filter((d) => d.projectSlug === 'alpha');
    expect(alphaDocs.length).toBeGreaterThan(0);
    for (const d of alphaDocs) {
      expect(d.projectWorkspace).toBe('alpha-ws');
    }
    // standalone has no project workspace
    const standalone = find(docs, 'assignment', 'uuid-standalone');
    expect(standalone?.projectWorkspace).toBeNull();
    expect(standalone?.standalone).toBe(true);
  });

  it('propagates assignment identity/filter fields onto sidecars', async () => {
    const docs = await buildIndex({ projectsDir, assignmentsDir });
    const comments = find(docs, 'comments', 'build-widget');
    expect(comments).toBeDefined();
    expect(comments?.assignmentId).toBe('asg-001');
    expect(comments?.assignmentSlug).toBe('build-widget');
    expect(comments?.type).toBe('feature');
    expect(comments?.status).toBe('in_progress');
    expect(comments?.standalone).toBe(false);
  });

  it('sets projectSlug + itemSlug on a memory doc with assignment fields null', async () => {
    const docs = await buildIndex({ projectsDir, assignmentsDir });
    const memory = find(docs, 'memory', 'shell-config');
    expect(memory).toBeDefined();
    expect(memory?.projectSlug).toBe('alpha');
    expect(memory?.itemSlug).toBe('shell-config');
    expect(memory?.assignmentId).toBeNull();
    expect(memory?.assignmentSlug).toBeNull();
    // _index.md must be skipped
    expect(docs.some((d) => d.itemSlug === '_index')).toBe(false);
  });
});

describe('FuseProvider.query', () => {
  async function provider() {
    const docs = await buildIndex({ projectsDir, assignmentsDir, includeArchived: true });
    const p = new FuseProvider();
    p.index(docs);
    return p;
  }

  it('ranks an obvious body match first', async () => {
    const p = await provider();
    const hits = p.query({ query: 'flux capacitor' }, 20);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].snippet).toContain('flux capacitor');
    expect(hits[0].fileKind).toBe('assignment');
  });

  it('returns a NEUTRAL snippet (no ** or <mark>) with snippet-local matches', async () => {
    const p = await provider();
    const hits = p.query({ query: 'strawberry' }, 20);
    expect(hits.length).toBeGreaterThan(0);
    const hit = hits[0];
    expect(hit.snippet).not.toContain('**');
    expect(hit.snippet).not.toContain('<mark>');
    expect(hit.matches.length).toBeGreaterThan(0);
    // matches index into the snippet
    const m = hit.matches[0];
    expect(hit.snippet.slice(m.start, m.end).toLowerCase()).toContain('strawberry');
    expect(hit.line).toBeGreaterThanOrEqual(1);
  });

  it('attributes the nearest section heading', async () => {
    const p = await provider();
    const hits = p.query({ query: 'strawberry' }, 20);
    expect(hits[0].section).toBe('Plan v2');
  });

  it('respects the --in filter, including the plural alias resolution upstream', async () => {
    const p = await provider();
    // canonical kinds passed in (parseFileKinds already resolved 'plans' → 'plan')
    const onlyPlans = p.query({ query: 'approach', in: ['plan'] }, 20);
    expect(onlyPlans.length).toBeGreaterThan(0);
    expect(onlyPlans.every((h) => h.fileKind === 'plan')).toBe(true);
  });

  it('respects the project filter', async () => {
    const p = await provider();
    const hits = p.query({ query: 'task', project: 'alpha' }, 20);
    expect(hits.every((h) => h.projectSlug === 'alpha')).toBe(true);
    // the standalone "kiwi task" must be filtered out
    expect(hits.some((h) => h.assignmentSlug === 'oneoff')).toBe(false);
  });

  it('respects the type[] filter', async () => {
    const p = await provider();
    const hits = p.query({ query: 'task', type: ['chore'] }, 20);
    expect(hits.length).toBeGreaterThan(0);
    // a type filter only matches assignment-derived docs (memory/resource have
    // no type), and every assignment-derived hit must be of type chore.
    expect(hits.every((h) => h.assignmentId !== null)).toBe(true);
    for (const h of hits) {
      expect(['asg-standalone', 'asg-arch']).toContain(h.assignmentId);
    }
  });

  it('respects the status[] filter', async () => {
    const p = await provider();
    const hits = p.query({ query: 'task', status: ['pending'] }, 20);
    for (const h of hits) {
      if (h.assignmentId) expect(h.assignmentId).toBe('asg-standalone');
    }
  });

  it('populates the precomputed route', async () => {
    const p = await provider();
    const hits = p.query({ query: 'pineapple' }, 20);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].route).toContain('?tab=comments');
  });
});
