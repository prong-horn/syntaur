import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildIndex } from '../search/indexer.js';
import { FuseProvider } from '../search/fuse-provider.js';
import type { SearchDoc } from '../search/types.js';

let root: string;
let projectsDir: string;
let ticketsDir: string;

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'syntaur-search-'));
  projectsDir = join(root, 'projects');
  ticketsDir = join(root, 'tickets');
  await mkdir(projectsDir, { recursive: true });
  await mkdir(ticketsDir, { recursive: true });

  // ── project "alpha" with workspace, one nested ticket ─────
  const alpha = join(projectsDir, 'alpha');
  await write(
    join(alpha, 'project.md'),
    `---\nid: p-alpha\nslug: alpha\ntitle: Alpha\nworkspace: alpha-ws\narchived: false\n---\n# Alpha project\n`,
  );
  const aDir = join(alpha, 'tickets', 'build-widget');
  await write(
    join(aDir, 'ticket.md'),
    `---\nid: asg-001\nslug: build-widget\ntitle: Build Widget\ntype: feature\nstatus: in_progress\narchived: false\n---\n# Build Widget\n\nWe must construct the flux capacitor.\n`,
  );
  // latest plan = plan-v2.md (plan.md is v1, must NOT be indexed)
  await write(
    join(aDir, 'plan.md'),
    `---\nticket: asg-001\n---\n# Old Plan v1\n\nObsolete approach.\n`,
  );
  await write(
    join(aDir, 'plan-v2.md'),
    `---\nticket: asg-001\n---\n# Plan v2\n\nThe approved strawberry approach.\n`,
  );
  await write(
    join(aDir, 'comments.md'),
    `---\nticket: asg-001\nentryCount: 1\n---\n## c1\n**Recorded:** 2026-01-01\n**Author:** brennen\n**Type:** question\n\nIs the pineapple ready?\n`,
  );

  // ── standalone ticket ─────────────────────────────────────────────────
  const sDir = join(ticketsDir, 'uuid-standalone');
  await write(
    join(sDir, 'ticket.md'),
    `---\nid: asg-standalone\nslug: oneoff\ntitle: One Off\ntype: chore\nstatus: pending\narchived: false\n---\n# One Off\n\nStandalone kiwi task.\n`,
  );

  // ── archived ticket (excluded by default) ─────────────────────────────
  const arDir = join(alpha, 'tickets', 'old-task');
  await write(
    join(arDir, 'ticket.md'),
    `---\nid: asg-arch\nslug: old-task\ntitle: Old Task\ntype: chore\nstatus: completed\narchived: true\n---\n# Old Task\n\nArchived dragonfruit work.\n`,
  );

  // ── archived PROJECT "zeta" — its ticket must be excluded by default.
  const zeta = join(projectsDir, 'zeta');
  await write(
    join(zeta, 'project.md'),
    `---\nid: p-zeta\nslug: zeta\ntitle: Zeta\nworkspace: zeta-ws\narchived: true\n---\n# Zeta project\n`,
  );
  const zDir = join(zeta, 'tickets', 'zeta-task');
  await write(
    join(zDir, 'ticket.md'),
    `---\nid: asg-zeta\nslug: zeta-task\ntitle: Zeta Task\ntype: feature\nstatus: in_progress\narchived: false\n---\n# Zeta Task\n\nWork on the zeta papaya.\n`,
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function find(docs: SearchDoc[], fileKind: string, slug: string | null): SearchDoc | undefined {
  return docs.find((d) => d.fileKind === fileKind && (slug === null || d.ticketSlug === slug));
}

describe('buildIndex', () => {
  it('emits a doc per file kind across tickets and sidecars', async () => {
    const docs = await buildIndex({ projectsDir, ticketsDir });
    const kinds = docs.map((d) => d.fileKind).sort();
    expect(kinds).toContain('ticket');
    expect(kinds).toContain('plan');
    expect(kinds).toContain('comments');
    const ticketDocs = docs.filter((d) => d.fileKind === 'ticket');
    expect(ticketDocs.map((d) => d.ticketSlug).sort()).toEqual([
      'build-widget',
      'uuid-standalone',
    ]);
  });

  it('indexes only the latest plan (plan-v2, not plan.md)', async () => {
    const docs = await buildIndex({ projectsDir, ticketsDir });
    const planDocs = docs.filter((d) => d.fileKind === 'plan');
    expect(planDocs).toHaveLength(1);
    expect(planDocs[0].path).toMatch(/plan-v2\.md$/);
    expect(planDocs[0].body).toContain('strawberry');
    expect(planDocs[0].body).not.toContain('Obsolete');
  });

  it('excludes archived tickets unless includeArchived', async () => {
    const docs = await buildIndex({ projectsDir, ticketsDir });
    expect(docs.some((d) => d.ticketSlug === 'old-task')).toBe(false);

    const withArchived = await buildIndex({ projectsDir, ticketsDir, includeArchived: true });
    expect(withArchived.some((d) => d.ticketSlug === 'old-task')).toBe(true);
  });

  it('excludes an archived project’s tickets by default', async () => {
    const docs = await buildIndex({ projectsDir, ticketsDir });
    expect(docs.some((d) => d.projectSlug === 'zeta')).toBe(false);
    expect(docs.some((d) => d.ticketSlug === 'zeta-task')).toBe(false);
  });

  it('includes an archived project’s content (archived:true stamped) when includeArchived', async () => {
    const docs = await buildIndex({ projectsDir, ticketsDir, includeArchived: true });
    const zetaDocs = docs.filter((d) => d.projectSlug === 'zeta');
    expect(zetaDocs.length).toBeGreaterThan(0);
    for (const d of zetaDocs) {
      expect(d.archived).toBe(true);
    }
    expect(zetaDocs.some((d) => d.fileKind === 'ticket')).toBe(true);
  });

  it('marks standalone tickets on indexed docs', async () => {
    const docs = await buildIndex({ projectsDir, ticketsDir });
    const standalone = find(docs, 'ticket', 'uuid-standalone');
    expect(standalone?.standalone).toBe(true);
    expect(standalone?.projectSlug).toBeNull();
  });

  it('propagates ticket identity/filter fields onto sidecars', async () => {
    const docs = await buildIndex({ projectsDir, ticketsDir });
    const comments = find(docs, 'comments', 'build-widget');
    expect(comments).toBeDefined();
    expect(comments?.ticketId).toBe('asg-001');
    expect(comments?.ticketSlug).toBe('build-widget');
    expect(comments?.type).toBe('feature');
    expect(comments?.status).toBe('in_progress');
    expect(comments?.standalone).toBe(false);
  });
});

describe('FuseProvider.query', () => {
  async function provider() {
    const docs = await buildIndex({ projectsDir, ticketsDir, includeArchived: true });
    const p = new FuseProvider();
    p.index(docs);
    return p;
  }

  it('ranks an obvious body match first', async () => {
    const p = await provider();
    const hits = p.query({ query: 'flux capacitor' }, 20);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].snippet).toContain('flux capacitor');
    expect(hits[0].fileKind).toBe('ticket');
  });

  it('returns a NEUTRAL snippet (no ** or <mark>) with snippet-local matches', async () => {
    const p = await provider();
    const hits = p.query({ query: 'strawberry' }, 20);
    expect(hits.length).toBeGreaterThan(0);
    const hit = hits[0];
    expect(hit.snippet).not.toContain('**');
    expect(hit.snippet).not.toContain('<mark>');
    expect(hit.matches.length).toBeGreaterThan(0);
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
    const onlyPlans = p.query({ query: 'approach', in: ['plan'] }, 20);
    expect(onlyPlans.length).toBeGreaterThan(0);
    expect(onlyPlans.every((h) => h.fileKind === 'plan')).toBe(true);
  });

  it('respects the project filter', async () => {
    const p = await provider();
    const hits = p.query({ query: 'task', project: 'alpha' }, 20);
    expect(hits.every((h) => h.projectSlug === 'alpha')).toBe(true);
    expect(hits.some((h) => h.ticketSlug === 'oneoff')).toBe(false);
  });

  it('respects the type[] filter', async () => {
    const p = await provider();
    const hits = p.query({ query: 'task', type: ['chore'] }, 20);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.ticketId !== null)).toBe(true);
    for (const h of hits) {
      expect(['asg-standalone', 'asg-arch']).toContain(h.ticketId);
    }
  });

  it('respects the status[] filter', async () => {
    const p = await provider();
    const hits = p.query({ query: 'task', status: ['pending'] }, 20);
    for (const h of hits) {
      if (h.ticketId) expect(h.ticketId).toBe('asg-standalone');
    }
  });

  it('populates the precomputed route', async () => {
    const p = await provider();
    const hits = p.query({ query: 'pineapple' }, 20);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].route).toContain('?tab=comments');
  });
});
