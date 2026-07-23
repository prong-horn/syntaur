import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createAgentSessionsRouter } from '../dashboard/api-agent-sessions.js';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
} from '../dashboard/session-db.js';
import { getOpenEngagement, hasAnyEngagement } from '../db/engagement-db.js';
import { createPtyTokenRegistry } from '../dashboard/pty-token.js';
import type { SessionResolution } from '../dashboard/daemon-join.js';
import type { JobState } from '../daemon/types.js';

const originalHome = process.env.HOME;
const originalSyntaurHome = process.env.SYNTAUR_HOME;

let tmpHome: string;
let projectsDir: string;
let assignmentsDir: string;
let server: Server;
let baseUrl: string;

async function writeAssignment(projectSlug: string, assignmentSlug: string, id: string): Promise<void> {
  const dir = resolve(projectsDir, projectSlug, 'assignments', assignmentSlug);
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(projectsDir, projectSlug, 'project.md'),
    `---\nslug: ${projectSlug}\ntitle: ${projectSlug}\ncreated: "2026-01-01"\nupdated: "2026-01-01"\n---\n# ${projectSlug}\n`,
  );
  await writeFile(
    resolve(dir, 'assignment.md'),
    `---\nid: ${id}\nslug: ${assignmentSlug}\ntitle: "${assignmentSlug}"\nproject: ${projectSlug}\nstatus: in_progress\n---\n# ${assignmentSlug}\n`,
  );
}

function post(body: unknown): Promise<Response> {
  return fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'syntaur-api-sessions-'));
  await mkdir(join(tmpHome, '.syntaur'), { recursive: true });
  process.env.HOME = tmpHome;
  process.env.SYNTAUR_HOME = join(tmpHome, '.syntaur');
  projectsDir = resolve(tmpHome, 'projects');
  assignmentsDir = resolve(tmpHome, 'assignments');
  await mkdir(projectsDir, { recursive: true });
  await mkdir(assignmentsDir, { recursive: true });

  resetSessionDb();
  initSessionDb(resolve(tmpHome, '.syntaur', 'sessions.db'));

  const app = express();
  app.use(express.json());
  app.use('/api/agent-sessions', createAgentSessionsRouter(projectsDir, undefined, assignmentsDir));
  await new Promise<void>((ready) => {
    server = app.listen(0, () => ready());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agent-sessions`;
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  closeSessionDb();
  resetSessionDb();
  process.env.HOME = originalHome;
  if (originalSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = originalSyntaurHome;
  await rm(tmpHome, { recursive: true, force: true });
});

describe('POST /api/agent-sessions — engagement-opening gate (L)', () => {
  it('(a) rejects a malformed sessionId with 400 and opens no engagement', async () => {
    const res = await post({ agent: 'claude', sessionId: 'bad id!' /* space + ! */ });
    expect(res.status).toBe(400);
    expect(hasAnyEngagement('bad id!')).toBe(false);
  });

  it('(b) returns 404 for a binding to a non-existent assignment and opens no engagement', async () => {
    await writeAssignment('proj', 'real', 'id-real');
    const res = await post({
      agent: 'claude',
      sessionId: 'sess-ghost',
      projectSlug: 'proj',
      assignmentSlug: 'ghost', // does not exist
    });
    expect(res.status).toBe(404);
    expect(hasAnyEngagement('sess-ghost')).toBe(false);
  });

  it('(c) registers a valid assignment binding (201) and stores the resolved assignment_id (M1)', async () => {
    await writeAssignment('proj', 'real', 'id-real');
    const res = await post({
      agent: 'claude',
      sessionId: 'sess-ok',
      projectSlug: 'proj',
      assignmentSlug: 'real',
    });
    expect(res.status).toBe(201);
    const open = getOpenEngagement('sess-ok');
    expect(open).not.toBeNull();
    expect(open!.assignment_id).toBe('id-real'); // M1: id resolved at registration
    expect(open!.project_slug).toBe('proj');
    expect(open!.assignment_slug).toBe('real');
  });

  it('(d) allows a registration-only POST (no assignmentSlug) with a valid sessionId', async () => {
    const res = await post({ agent: 'claude', sessionId: 'sess-bare' });
    expect(res.status).toBe(201);
  });

  it('(e) a project-only POST (no assignmentSlug) registers UNBOUND — opens no project-bound engagement', async () => {
    await writeAssignment('proj', 'real', 'id-real'); // project exists
    const res = await post({ agent: 'claude', sessionId: 'sess-proj-only', projectSlug: 'proj' });
    expect(res.status).toBe(201);
    // Binding requires an assignment selector — a bare/project-only POST is
    // registration-only and must NOT open a project-bound engagement.
    expect(hasAnyEngagement('sess-proj-only')).toBe(false);
  });
});

describe('Phase D — GET /by-id/:sessionId + POST pty-token', () => {
  let dServer: Server;
  let dBase: string;
  let tokens: ReturnType<typeof createPtyTokenRegistry>;
  let resolution: SessionResolution | null;

  const jobState = (over: Partial<JobState> & { short: string; state: JobState['state'] }): JobState => ({
    agent: 'codex',
    argv: ['codex'],
    cwd: '/tmp',
    pid: 1,
    pidStartedAt: null,
    sessionId: 'sess-x',
    cols: 80,
    rows: 24,
    createdAt: '2026-07-22T00:00:00Z',
    updatedAt: '2026-07-22T00:00:00Z',
    daemonId: 'd1',
    ptySock: '/tmp/p.sock',
    rvSock: '/tmp/r.sock',
    hostPid: 2,
    hostPidStartedAt: null,
    ...over,
  });

  beforeEach(async () => {
    tokens = createPtyTokenRegistry();
    resolution = null;
    const app = express();
    app.use(express.json());
    app.use(
      '/api/agent-sessions',
      createAgentSessionsRouter(projectsDir, undefined, assignmentsDir, {
        ptyTokens: tokens,
        resolveShort: async () => resolution,
      }),
    );
    await new Promise<void>((ready) => {
      dServer = app.listen(0, () => ready());
    });
    dBase = `http://127.0.0.1:${(dServer.address() as AddressInfo).port}/api/agent-sessions`;
  });

  afterEach(async () => {
    await new Promise<void>((done) => dServer.close(() => done()));
  });

  /** Register a session row so getSessionById finds it. */
  async function register(sessionId: string): Promise<void> {
    const res = await post({ agent: 'codex', sessionId });
    expect(res.status).toBe(201);
  }

  it('a live session is attachable and carries the daemon state', async () => {
    await register('sess-live');
    resolution = { short: 'ab12', state: 'blocked', needs: 'approve?', cols: 100, rows: 30, live: true };
    const res = await fetch(`${dBase}/by-id/sess-live`);
    expect(res.status).toBe(200);
    const { session } = await res.json();
    expect(session.attachable).toBe(true);
    expect(session.syntaurdShortId).toBe('ab12');
    expect(session.syntaurdState).toBe('blocked');
    expect(session.needs).toBe('approve?');
    expect(session.settled).toBeUndefined();
  });

  it('a terminal session returns its settled final screen, not attachable', async () => {
    await register('sess-done');
    resolution = {
      short: 'cd34',
      state: 'done',
      live: false,
      jobState: jobState({ short: 'cd34', state: 'done', lastScreen: 'bye', exitCode: 0 }),
    };
    const res = await fetch(`${dBase}/by-id/sess-done`);
    const { session } = await res.json();
    expect(session.attachable).toBe(false);
    expect(session.settled).toEqual({ lastScreen: 'bye', exitCode: 0, exitSignal: null, state: 'done' });
  });

  it('a non-terminal session with the daemon down is daemonUnavailable (no lastScreen)', async () => {
    await register('sess-down');
    resolution = { short: 'ef56', state: 'working', live: false, jobState: null };
    const res = await fetch(`${dBase}/by-id/sess-down`);
    const { session } = await res.json();
    expect(session.attachable).toBe(false);
    expect(session.daemonUnavailable).toBe(true);
    expect(session.settled).toBeUndefined();
  });

  it('returns 404 for an unknown session', async () => {
    const res = await fetch(`${dBase}/by-id/sess-ghost`);
    expect(res.status).toBe(404);
  });

  it('mints a pty token for a live session', async () => {
    await register('sess-mint');
    resolution = { short: 'gh78', state: 'working', needs: null, cols: 80, rows: 24, live: true };
    const res = await fetch(`${dBase}/by-id/sess-mint/pty-token`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.short).toBe('gh78');
    expect(typeof body.token).toBe('string');
    expect(tokens.consume(body.token, 'gh78')).toBe(true); // valid, single-use
  });

  it('returns 409 when minting for a non-live session', async () => {
    resolution = { short: 'ij90', state: 'done', live: false, jobState: null };
    const res = await fetch(`${dBase}/by-id/sess-x/pty-token`, { method: 'POST' });
    expect(res.status).toBe(409);
  });

  it('does not shadow the existing GET /:projectSlug project listing', async () => {
    await writeAssignment('proj', 'real', 'id-real');
    const res = await fetch(`${dBase}/proj`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.sessions)).toBe(true);
  });
});
