import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
  getSessionDb,
} from '../dashboard/session-db.js';
import { appendSession, runSessionMaintenance } from '../dashboard/agent-sessions.js';
import { getOpenEngagement } from '../db/engagement-db.js';

/**
 * The dashboard tick's session-maintenance pass (plan Task 4): reconcile FIRST,
 * then sweep. The order is the whole point — a session bound to an assignment
 * that has finished must be reconciled to `completed` on the tick, not left for
 * the six-hour stale sweep to call `stopped`. `completed` and `stopped` are
 * different facts, and only the ordering decides which one a finished
 * assignment's session gets.
 */

let dir: string;
let projectsDir: string;
let prevHome: string | undefined;
const HOUR = 60 * 60 * 1000;

async function writeAssignment(slug: string, status: string): Promise<void> {
  const d = resolve(projectsDir, 'proj', 'assignments', slug);
  await mkdir(d, { recursive: true });
  await writeFile(
    join(d, 'assignment.md'),
    ['---', `slug: ${slug}`, `status: ${status}`, 'project: proj', '---', '', `# ${slug}`].join('\n'),
    'utf-8',
  );
}

/** Register a session bound to an assignment, then age its heartbeat. */
async function seed(sessionId: string, slug: string, ageMs: number): Promise<void> {
  await appendSession('', {
    projectSlug: 'proj',
    assignmentSlug: slug,
    agent: 'claude',
    sessionId,
    started: new Date(Date.now() - ageMs).toISOString(),
    status: 'active',
    path: '/w/repo',
  });
  getSessionDb()
    .prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?')
    .run(new Date(Date.now() - ageMs).toISOString().replace('T', ' ').slice(0, 19), sessionId);
}

const statusOf = (id: string): string =>
  (getSessionDb().prepare('SELECT status FROM sessions WHERE session_id = ?').get(id) as {
    status: string;
  }).status;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'syntaur-maint-'));
  projectsDir = resolve(dir, 'projects');
  prevHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = resolve(dir, 'home');
  resetSessionDb();
  initSessionDb(resolve(dir, 'syntaur.db'));
});

afterEach(async () => {
  closeSessionDb();
  if (prevHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = prevHome;
  await rm(dir, { recursive: true, force: true });
});

describe('runSessionMaintenance', () => {
  it('reconciles a session on a finished assignment BEFORE the sweep can call it stale', async () => {
    await writeAssignment('done-task', 'completed');
    // Old enough that the sweep would take it if it got there first.
    await seed('sess-done', 'done-task', 9 * HOUR);

    const result = await runSessionMaintenance(projectsDir, undefined, { idleMs: 6 * HOUR });

    expect(result.reconciled).toBe(1);
    // `completed` — the assignment finished. If the sweep had run first this
    // would read `stopped`, which is a different and wrong fact.
    expect(statusOf('sess-done')).toBe('completed');
    expect(result.swept).toEqual([]);
  });

  it('still sweeps a stale session whose assignment is NOT finished', async () => {
    await writeAssignment('live-task', 'in_progress');
    await seed('sess-stale', 'live-task', 9 * HOUR);

    const result = await runSessionMaintenance(projectsDir, undefined, { idleMs: 6 * HOUR });

    expect(result.reconciled).toBe(0);
    expect(result.swept).toEqual(['sess-stale']);
    expect(statusOf('sess-stale')).toBe('stopped');
    expect(getOpenEngagement('sess-stale')).toBeNull();
  });

  it('leaves a fresh session on a live assignment alone', async () => {
    await writeAssignment('live-task', 'in_progress');
    await seed('sess-fresh', 'live-task', 1 * HOUR);

    const result = await runSessionMaintenance(projectsDir, undefined, { idleMs: 6 * HOUR });

    expect(result).toMatchObject({ reconciled: 0, swept: [] });
    expect(statusOf('sess-fresh')).toBe('active');
  });
});

describe('runSessionMaintenance failure isolation (review round 2, finding 2)', () => {
  it('still sweeps when the reconcile throws', async () => {
    await writeAssignment('live-task', 'in_progress');
    await seed('sess-stale-2', 'live-task', 9 * HOUR);
    const logged: unknown[] = [];

    // A corrupt assignment.md or a transient FS error must not cost the tick its
    // sweep: before the reconcile was added, the tick ALWAYS swept, and adding a
    // step must not take that away.
    const result = await runSessionMaintenance(projectsDir, undefined, { idleMs: 6 * HOUR }, {
      reconcile: async () => {
        throw new Error('EIO: corrupt assignment.md');
      },
      log: (_m, err) => logged.push(err),
    });

    expect(result.reconciled).toBe(0);
    expect(result.swept).toEqual(['sess-stale-2']);
    expect(statusOf('sess-stale-2')).toBe('stopped');
    // The failure is reported, not swallowed silently.
    expect(logged).toHaveLength(1);
    expect((logged[0] as Error).message).toMatch(/corrupt assignment.md/);
  });
});
