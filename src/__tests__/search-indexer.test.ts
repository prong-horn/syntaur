import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildIndex } from '../search/indexer.js';
import { FuseProvider } from '../search/fuse-provider.js';
import type { SearchDoc } from '../search/types.js';

let root: string;
let projectsDir: string;

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'syntaur-search-'));
  projectsDir = join(root, 'projects');
  await mkdir(projectsDir, { recursive: true });

  // ── project "alpha" with workspace, nested tickets ─────
  const alpha = join(projectsDir, 'alpha');
  await write(
    join(alpha, 'project.md'),
    `---\nid: p-alpha\nslug: alpha\ntitle: Alpha\nprefix: ALP\nnextTicket: 3\nworkspace: alpha-ws\narchived: false\n---\n# Alpha project\n`,
  );
  const aDir = join(alpha, 'tickets', 'ALP-1-build-widget');
  await write(
    join(aDir, 'ticket.md'),
    `---\nid: ALP-1\nslug: build-widget\ntitle: Build Widget\ntemplate: feature\nstatus: in_progress\narchived: false\n---\n# Build Widget\n\nWe must construct the flux capacitor.\n`,
  );
  await write(
    join(aDir, 'plan.md'),
    `---\nticket: ALP-1\n---\n# Old Plan v1\n\nThe approved strawberry approach.\n`,
  );
  await write(
    join(aDir, 'plan-v2.md'),
    `---\nticket: ALP-1\n---\n# Plan v2\n\nThe approved strawberry approach.\n`,
  );
  await write(
    join(aDir, 'comments.md'),
    `---\nticket: ALP-1\nentryCount: 1\n---\n## c1\n**Recorded:** 2026-01-01\n**Author:** brennen\n**Type:** question\n\nIs the pineapple ready?\n`,
  );

  const choreDir = join(alpha, 'tickets', 'ALP-2-oneoff');
  await write(
    join(choreDir, 'ticket.md'),
    `---\nid: ALP-2\nslug: oneoff\ntitle: One Off\ntemplate: chore\nstatus: pending\narchived: false\n---\n# One Off\n\nStandalone kiwi task.\n`,
  );

  // ── archived ticket (excluded by default) ─────────────────────────────
  const arDir = join(alpha, 'tickets', 'ALP-3-old-task');
  await write(
    join(arDir, 'ticket.md'),
    `---\nid: ALP-3\nslug: old-task\ntitle: Old Task\ntemplate: chore\nstatus: completed\narchived: true\n---\n# Old Task\n\nArchived dragonfruit work.\n`,
  );

  // ── archived PROJECT "zeta" — its ticket must be excluded by default.
  const zeta = join(projectsDir, 'zeta');
  await write(
    join(zeta, 'project.md'),
    `---\nid: p-zeta\nslug: zeta\ntitle: Zeta\nprefix: ZET\nnextTicket: 2\nworkspace: zeta-ws\narchived: true\n---\n# Zeta project\n`,
  );
  const zDir = join(zeta, 'tickets', 'ZET-1-zeta-task');
  await write(
    join(zDir, 'ticket.md'),
    `---\nid: ZET-1\nslug: zeta-task\ntitle: Zeta Task\ntemplate: feature\nstatus: in_progress\narchived: false\n---\n# Zeta Task\n\nWork on the zeta papaya.\n`,
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
    const docs = await buildIndex({ projectsDir });
    const kinds = docs.map((d) => d.fileKind).sort();
    expect(kinds).toContain('ticket');
    expect(kinds).toContain('plan');
    expect(kinds).toContain('comments');
    const ticketDocs = docs.filter((d) => d.fileKind === 'ticket');
    expect(ticketDocs.map((d) => d.ticketSlug).sort()).toEqual(['build-widget', 'oneoff']);
  });

  it('indexes the plan role path (plan.md), not superseded revisions', async () => {
    const docs = await buildIndex({ projectsDir });
    const planDocs = docs.filter((d) => d.fileKind === 'plan');
    expect(planDocs).toHaveLength(1);
    expect(planDocs[0].path).toMatch(/plan\.md$/);
    expect(planDocs[0].body).toContain('strawberry');
    expect(planDocs[0].body).not.toContain('Plan v2');
  });

  it('excludes archived tickets unless includeArchived', async () => {
    const docs = await buildIndex({ projectsDir });
    expect(docs.some((d) => d.ticketSlug === 'old-task')).toBe(false);

    const withArchived = await buildIndex({ projectsDir, includeArchived: true });
    expect(withArchived.some((d) => d.ticketSlug === 'old-task')).toBe(true);
  });

  it('excludes an archived project’s tickets by default', async () => {
    const docs = await buildIndex({ projectsDir });
    expect(docs.some((d) => d.projectSlug === 'zeta')).toBe(false);
    expect(docs.some((d) => d.ticketSlug === 'zeta-task')).toBe(false);
  });

  it('includes an archived project’s content (archived:true stamped) when includeArchived', async () => {
    const docs = await buildIndex({ projectsDir, includeArchived: true });
    const zetaDocs = docs.filter((d) => d.projectSlug === 'zeta');
    expect(zetaDocs.length).toBeGreaterThan(0);
    for (const d of zetaDocs) {
      expect(d.archived).toBe(true);
    }
    expect(zetaDocs.some((d) => d.fileKind === 'ticket')).toBe(true);
  });

  it('marks project-nested tickets on indexed docs', async () => {
    const docs = await buildIndex({ projectsDir });
    const nested = find(docs, 'ticket', 'oneoff');
    expect(nested?.standalone).toBe(false);
    expect(nested?.projectSlug).toBe('alpha');
    expect(nested?.ticketId).toBe('ALP-2');
  });

  it('propagates ticket identity/filter fields onto sidecars', async () => {
    const docs = await buildIndex({ projectsDir });
    const comments = find(docs, 'comments', 'build-widget');
    expect(comments).toBeDefined();
    expect(comments?.ticketId).toBe('ALP-1');
    expect(comments?.ticketSlug).toBe('build-widget');
    expect(comments?.template).toBe('feature');
    expect(comments?.status).toBe('in_progress');
    expect(comments?.standalone).toBe(false);
  });
});

describe('FuseProvider.query', () => {
  async function provider() {
    const docs = await buildIndex({ projectsDir, includeArchived: true });
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
    expect(hits[0].section).toBe('Old Plan v1');
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
    expect(hits.some((h) => h.ticketSlug === 'oneoff')).toBe(true);
    expect(hits.some((h) => h.projectSlug === 'zeta')).toBe(false);
  });

  it('respects the template[] filter', async () => {
    const p = await provider();
    const hits = p.query({ query: 'task', template: ['chore'] }, 20);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.ticketId !== null)).toBe(true);
    for (const h of hits) {
      expect(['ALP-2', 'ALP-3']).toContain(h.ticketId);
    }
  });

  it('respects the status[] filter', async () => {
    const p = await provider();
    const hits = p.query({ query: 'task', status: ['pending'] }, 20);
    for (const h of hits) {
      if (h.ticketId) expect(h.ticketId).toBe('ALP-2');
    }
  });

  it('populates the precomputed route', async () => {
    const p = await provider();
    const hits = p.query({ query: 'pineapple' }, 20);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].route).toContain('?tab=comments');
  });
});
