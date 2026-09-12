import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { resolveTicketTarget } from '../utils/ticket-target.js';
import { resolveEngagementBinding } from '../utils/engagement-binding.js';
import { initSessionDb, resetSessionDb, closeSessionDb } from '../dashboard/session-db.js';
import { openEngagement, getOpenEngagement } from '../db/engagement-db.js';

/**
 * The headline regression for the engagement-attribution rewiring: two sessions
 * working two different tickets from ONE shared worktree/cwd must each
 * resolve their OWN ticket. Pre-rewiring, a single cwd-scoped context.json
 * scalar made the second grab clobber the first. Now the active ticket is
 * keyed on the session's open engagement, so the shared cwd is irrelevant.
 */

let tmpRoot: string;
let projectsDir: string;
let sharedWorktree: string;
let origHome: string | undefined;
let origSessionId: string | undefined;

const PROJECT = 'shared-proj';
const A_SLUG = 'ticket-a';
const B_SLUG = 'ticket-b';
const A_ID = 'TA-1';
const B_ID = 'TB-1';
const SESSION_A = 'session-alpha';
const SESSION_B = 'session-beta';

async function writeProject(slug: string): Promise<void> {
  const dir = resolve(projectsDir, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(dir, 'project.md'),
    ['---', `id: proj-${slug}`, `slug: ${slug}`, `title: ${slug}`, '---', '', `# ${slug}`, ''].join('\n'),
  );
}

async function writeTicket(slug: string, id: string): Promise<void> {
  const dir = resolve(projectsDir, PROJECT, 'tickets', `${id}-${slug}`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(dir, 'ticket.md'),
    [
      '---',
      `id: ${id}`,
      `slug: ${slug}`,
      `project: ${PROJECT}`,
      'title: Example',
      'status: in_progress',
      'priority: medium',
      'created: "2026-06-20T00:00:00Z"',
      'updated: "2026-06-20T00:00:00Z"',
      '---',
      '',
      '# Example',
      '',
    ].join('\n'),
  );
}

/** Resolve the active ticket AS a specific session sharing the one cwd. */
async function resolveAsSession(sessionId: string) {
  process.env.CLAUDE_CODE_SESSION_ID = sessionId; // STRONG provenance, per-process
  return resolveTicketTarget(undefined, {
    cwd: sharedWorktree,
    dir: projectsDir,
    resolveEngagement: () => resolveEngagementBinding(sharedWorktree),
  });
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'syntaur-engagement-attr-'));
  projectsDir = resolve(tmpRoot, 'projects');
  sharedWorktree = resolve(tmpRoot, 'worktree');
  await mkdir(projectsDir, { recursive: true });
  await mkdir(sharedWorktree, { recursive: true });

  origHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = tmpRoot;
  origSessionId = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;

  await writeProject(PROJECT);
  await writeTicket(A_SLUG, A_ID);
  await writeTicket(B_SLUG, B_ID);

  // A STALE, clobbering context.json in the shared worktree carrying the OLD
  // authoritative ticket scalars pointing at B. Pre-rewiring this is exactly
  // what made session A resolve B (the clobber). It must now be ignored entirely.
  await mkdir(resolve(sharedWorktree, '.syntaur'), { recursive: true });
  await writeFile(
    resolve(sharedWorktree, '.syntaur', 'context.json'),
    JSON.stringify({
      projectSlug: PROJECT,
      ticketSlug: B_SLUG,
      ticketId: B_ID,
      ticketDir: resolve(projectsDir, PROJECT, 'tickets', `${B_ID}-${B_SLUG}`),
      repository: '/repo',
      workspaceRoot: sharedWorktree,
    }),
  );

  resetSessionDb();
  initSessionDb(resolve(tmpRoot, 'syntaur.db'));
  // Two sessions, two tickets, ONE shared worktree/cwd.
  openEngagement({
    sessionId: SESSION_A,
    ticketId: A_ID,
    projectSlug: PROJECT,
    ticketSlug: A_SLUG,
    stage: 'implement',
    startedAt: '2026-06-20T01:00:00Z',
  });
  openEngagement({
    sessionId: SESSION_B,
    ticketId: B_ID,
    projectSlug: PROJECT,
    ticketSlug: B_SLUG,
    stage: 'plan',
    startedAt: '2026-06-20T02:00:00Z',
  });
});

afterEach(async () => {
  closeSessionDb();
  if (origHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = origHome;
  if (origSessionId === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = origSessionId;
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('two sessions, one worktree: engagement-keyed attribution', () => {
  it('each session resolves its OWN ticket from the shared cwd (no clobber)', async () => {
    const asA = await resolveAsSession(SESSION_A);
    expect(asA.ticketSlug).toBe(A_SLUG);
    expect(asA.id).toBe(A_ID);
    expect(asA.stage).toBe('implement');

    const asB = await resolveAsSession(SESSION_B);
    expect(asB.ticketSlug).toBe(B_SLUG);
    expect(asB.id).toBe(B_ID);
    expect(asB.stage).toBe('plan');

    // The shared cwd did not make one session's target leak into the other.
    expect(asA.ticketSlug).not.toBe(asB.ticketSlug);
  });

  it('a session with no open engagement fails-with-selector, even in a worktree another session owns', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'session-with-no-engagement';
    await expect(
      resolveTicketTarget(undefined, {
        cwd: sharedWorktree,
        dir: projectsDir,
        resolveEngagement: () => resolveEngagementBinding(sharedWorktree),
      }),
    ).rejects.toThrow(/No open engagement/);
  });

  it('targeted resolution (--project + slug) files against B without switching A’s open engagement', async () => {
    // Ambient is session A (engagement on ticket A).
    process.env.CLAUDE_CODE_SESSION_ID = SESSION_A;
    const before = getOpenEngagement(SESSION_A);
    expect(before?.ticket_id).toBe(A_ID);

    // Explicitly target B — Cases 1/2 win, the engagement seam is not consulted.
    const targeted = await resolveTicketTarget(B_SLUG, {
      project: PROJECT,
      dir: projectsDir,
      cwd: sharedWorktree,
      resolveEngagement: () => resolveEngagementBinding(sharedWorktree),
    });
    expect(targeted.ticketSlug).toBe(B_SLUG);

    // Session A's open engagement is untouched — still on A (no silent switch).
    const after = getOpenEngagement(SESSION_A);
    expect(after?.ticket_id).toBe(A_ID);
    expect(after?.id).toBe(before?.id);
  });
});
