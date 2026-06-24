import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
} from '../dashboard/session-db.js';
import { getSessionById } from '../dashboard/agent-sessions.js';
import { runSessionRegister, runSessionStop } from '../commands/session.js';
import type { SessionRegisterDeps } from '../commands/session.js';

let testDir: string;
let cwd: string;

const DEPS: SessionRegisterDeps = {
  autoTrack: 'all',
  fallbackPid: () => 4242,
  pidStartedAt: () => 'Thu Jun 11 10:00:00 2026',
  headSha: async () => 'abc1234',
  now: () => '2026-06-11T10:00:00.000Z',
};

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: 'real-session-1',
    transcript_path: '/tmp/transcripts/real-session-1.jsonl',
    cwd,
    ...overrides,
  });
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-register-test-'));
  cwd = join(testDir, 'workspace');
  await mkdir(cwd, { recursive: true });
  resetSessionDb();
  initSessionDb(resolve(testDir, 'test.db'));
});

afterEach(async () => {
  closeSessionDb();
  await rm(testDir, { recursive: true, force: true });
});

describe('runSessionRegister', () => {
  it('registers a standalone row when no context.json exists (gate removed)', async () => {
    const result = await runSessionRegister(payload(), { agent: 'claude' }, DEPS);

    expect(result.registered).toBe(true);
    expect(result.merged).toBe(false);
    const row = getSessionById('real-session-1');
    expect(row).not.toBeNull();
    expect(row!.status).toBe('active');
    expect(row!.projectSlug).toBeNull();
    expect(row!.assignmentSlug).toBeNull();
    expect(row!.agent).toBe('claude');
    expect(row!.path).toBe(cwd);
    expect(row!.transcriptPath).toBe('/tmp/transcripts/real-session-1.jsonl');
    expect(row!.pid).toBe(4242);
    expect(row!.pidStartedAt).toBe('Thu Jun 11 10:00:00 2026');
    expect(row!.originalHeadSha).toBe('abc1234');
    expect(row!.started).toBe('2026-06-11T10:00:00.000Z');
  });

  it('never creates .syntaur/ when context.json is absent', async () => {
    await runSessionRegister(payload(), {}, DEPS);
    expect(existsSync(join(cwd, '.syntaur'))).toBe(false);
  });

  it('uses --pid over the fallback pid', async () => {
    await runSessionRegister(payload(), { pid: '777' }, DEPS);
    expect(getSessionById('real-session-1')!.pid).toBe(777);
  });

  it('registers an UNATTRIBUTED row even when context.json carries assignment scalars, but still merges session fields into context.json', async () => {
    // The SessionStart hook no longer auto-binds the assignment from the cwd
    // context.json scalar (that cwd-scalar auto-bind is the
    // multi-assignment-in-one-worktree clobber being eliminated). The row binds
    // its assignment via the explicit grab flow / engagement edge, NOT here.
    await mkdir(join(cwd, '.syntaur'), { recursive: true });
    await writeFile(
      join(cwd, '.syntaur', 'context.json'),
      JSON.stringify({
        projectSlug: 'proj-1',
        assignmentSlug: 'assn-1',
        branch: 'feat/x',
        sessionId: 'previous-session',
        transcriptPath: '/tmp/stale.jsonl',
      }),
    );

    const result = await runSessionRegister(payload(), {}, DEPS);

    expect(result.merged).toBe(true);
    expect(result.registered).toBe(true);
    const row = getSessionById('real-session-1');
    // UNATTRIBUTED despite the context.json scalars.
    expect(row!.projectSlug).toBeNull();
    expect(row!.assignmentSlug).toBeNull();

    // The context.json field-merge (sessionId/transcriptPath) still runs and
    // still preserves the other marker fields.
    const ctx = JSON.parse(await readFile(join(cwd, '.syntaur', 'context.json'), 'utf-8'));
    expect(ctx.sessionId).toBe('real-session-1');
    expect(ctx.transcriptPath).toBe('/tmp/transcripts/real-session-1.jsonl');
    expect(ctx.branch).toBe('feat/x'); // other fields preserved
    expect(ctx.projectSlug).toBe('proj-1'); // context scalar untouched (markers, not auth)
  });

  it('nulls a stale transcriptPath when the payload omits transcript_path', async () => {
    await mkdir(join(cwd, '.syntaur'), { recursive: true });
    await writeFile(
      join(cwd, '.syntaur', 'context.json'),
      JSON.stringify({ sessionId: 'old', transcriptPath: '/tmp/stale.jsonl' }),
    );

    await runSessionRegister(payload({ transcript_path: undefined }), {}, DEPS);

    const ctx = JSON.parse(await readFile(join(cwd, '.syntaur', 'context.json'), 'utf-8'));
    expect(ctx.sessionId).toBe('real-session-1');
    expect(ctx.transcriptPath).toBeNull();
  });

  it('resolves latestSessionSummaryPath to the newest summary.md by mtime', async () => {
    const assignmentDir = join(testDir, 'assignment');
    const oldDir = join(assignmentDir, 'sessions', 'older');
    const newDir = join(assignmentDir, 'sessions', 'newer');
    await mkdir(oldDir, { recursive: true });
    await mkdir(newDir, { recursive: true });
    await writeFile(join(oldDir, 'summary.md'), '# old');
    await writeFile(join(newDir, 'summary.md'), '# new');
    const past = new Date(Date.now() - 60_000);
    await utimes(join(oldDir, 'summary.md'), past, past);

    await mkdir(join(cwd, '.syntaur'), { recursive: true });
    await writeFile(
      join(cwd, '.syntaur', 'context.json'),
      JSON.stringify({ assignmentDir }),
    );

    await runSessionRegister(payload(), {}, DEPS);

    const ctx = JSON.parse(await readFile(join(cwd, '.syntaur', 'context.json'), 'utf-8'));
    expect(ctx.latestSessionSummaryPath).toBe(join(newDir, 'summary.md'));
  });

  it('sets latestSessionSummaryPath to null when no sessions/ dir exists', async () => {
    await mkdir(join(cwd, '.syntaur'), { recursive: true });
    await writeFile(
      join(cwd, '.syntaur', 'context.json'),
      JSON.stringify({ assignmentDir: join(testDir, 'assignment') }),
    );

    await runSessionRegister(payload(), {}, DEPS);

    const ctx = JSON.parse(await readFile(join(cwd, '.syntaur', 'context.json'), 'utf-8'));
    expect(ctx.latestSessionSummaryPath).toBeNull();
  });

  it('returns silently on malformed stdin', async () => {
    const result = await runSessionRegister('{not json', {}, DEPS);
    expect(result.registered).toBe(false);
    expect(result.merged).toBe(false);
    expect(result.sessionId).toBeNull();
  });

  it('rejects unsafe session ids', async () => {
    const result = await runSessionRegister(
      payload({ session_id: '../../etc/passwd' }),
      {},
      DEPS,
    );
    expect(result.registered).toBe(false);
  });

  it('returns silently when cwd is missing', async () => {
    const result = await runSessionRegister(
      JSON.stringify({ session_id: 'real-session-1' }),
      {},
      DEPS,
    );
    expect(result.registered).toBe(false);
  });

  it('autoTrack=off skips the DB write but still merges context.json', async () => {
    await mkdir(join(cwd, '.syntaur'), { recursive: true });
    await writeFile(join(cwd, '.syntaur', 'context.json'), JSON.stringify({ branch: 'b' }));

    const result = await runSessionRegister(payload(), {}, { ...DEPS, autoTrack: 'off' });

    expect(result.merged).toBe(true);
    expect(result.registered).toBe(false);
    expect(getSessionById('real-session-1')).toBeNull();
    const ctx = JSON.parse(await readFile(join(cwd, '.syntaur', 'context.json'), 'utf-8'));
    expect(ctx.sessionId).toBe('real-session-1');
  });

  it('autoTrack=workspaces-only skips the DB write when no context.json exists', async () => {
    const result = await runSessionRegister(payload(), {}, { ...DEPS, autoTrack: 'workspaces-only' });
    expect(result.registered).toBe(false);
    expect(getSessionById('real-session-1')).toBeNull();
  });

  it('autoTrack=workspaces-only registers when a context.json exists', async () => {
    await mkdir(join(cwd, '.syntaur'), { recursive: true });
    await writeFile(join(cwd, '.syntaur', 'context.json'), JSON.stringify({ projectSlug: 'p' }));

    const result = await runSessionRegister(payload(), {}, { ...DEPS, autoTrack: 'workspaces-only' });
    expect(result.registered).toBe(true);
    // The context.json presence gates the DB write, but the registered row is
    // still UNATTRIBUTED — the binding does not come from the context scalar.
    expect(getSessionById('real-session-1')!.projectSlug).toBeNull();
  });

  it('is idempotent — re-registration upserts onto the existing row', async () => {
    await runSessionRegister(payload(), {}, DEPS);
    await runSessionRegister(payload(), {}, DEPS);
    const row = getSessionById('real-session-1');
    expect(row).not.toBeNull();
    expect(row!.status).toBe('active');
  });
});

describe('runSessionStop', () => {
  it('marks the EXACT ending session (stdin .session_id), not the context.json scalar', async () => {
    await runSessionRegister(payload({ session_id: 'mine' }), {}, DEPS);
    await runSessionRegister(payload({ session_id: 'cotenant' }), {}, DEPS);
    await mkdir(join(cwd, '.syntaur'), { recursive: true });
    await writeFile(
      join(cwd, '.syntaur', 'context.json'),
      JSON.stringify({ sessionId: 'cotenant' }),
    );

    const result = await runSessionStop(JSON.stringify({ session_id: 'mine', cwd }));

    expect(result.stopped).toBe(true);
    expect(result.sessionId).toBe('mine');
    expect(getSessionById('mine')!.status).toBe('stopped');
    expect(getSessionById('cotenant')!.status).toBe('active');
  });

  it('falls back to the context.json scalar when stdin carries no id', async () => {
    await runSessionRegister(payload({ session_id: 'from-context' }), {}, DEPS);
    await mkdir(join(cwd, '.syntaur'), { recursive: true });
    await writeFile(
      join(cwd, '.syntaur', 'context.json'),
      JSON.stringify({ sessionId: 'from-context' }),
    );

    const result = await runSessionStop(JSON.stringify({ cwd }));

    expect(result.stopped).toBe(true);
    expect(getSessionById('from-context')!.status).toBe('stopped');
  });

  it('is a silent no-op when no id can be resolved', async () => {
    const result = await runSessionStop(JSON.stringify({ cwd }));
    expect(result.stopped).toBe(false);
    expect(result.sessionId).toBeNull();
  });

  it('sets ended on the stopped row', async () => {
    await runSessionRegister(payload({ session_id: 'ending' }), {}, DEPS);
    await runSessionStop(JSON.stringify({ session_id: 'ending', cwd }));
    expect(getSessionById('ending')!.ended).toBeTruthy();
  });

  it('register after stop REVIVES the row (a new SessionStart for the id is live-process evidence — the resume case)', async () => {
    await runSessionRegister(payload({ session_id: 'resumed' }), {}, DEPS);
    await runSessionStop(JSON.stringify({ session_id: 'resumed', cwd }));
    await runSessionRegister(payload({ session_id: 'resumed' }), {}, DEPS);
    expect(getSessionById('resumed')!.status).toBe('active');
  });

  it('register never revives a completed row', async () => {
    await runSessionRegister(payload({ session_id: 'done-for-good' }), {}, DEPS);
    const { updateSessionStatus } = await import('../dashboard/agent-sessions.js');
    await updateSessionStatus('', 'done-for-good', 'completed');
    await runSessionRegister(payload({ session_id: 'done-for-good' }), {}, DEPS);
    expect(getSessionById('done-for-good')!.status).toBe('completed');
  });
});
