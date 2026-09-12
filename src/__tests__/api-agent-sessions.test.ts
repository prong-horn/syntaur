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

const originalHome = process.env.HOME;
const originalSyntaurHome = process.env.SYNTAUR_HOME;

let tmpHome: string;
let projectsDir: string;
let ticketsDir: string;
let server: Server;
let baseUrl: string;

async function writeTicket(projectSlug: string, ticketSlug: string, id: string): Promise<void> {
  const dir = resolve(projectsDir, projectSlug, 'tickets', ticketSlug);
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(projectsDir, projectSlug, 'project.md'),
    `---\nslug: ${projectSlug}\ntitle: ${projectSlug}\ncreated: "2026-01-01"\nupdated: "2026-01-01"\n---\n# ${projectSlug}\n`,
  );
  await writeFile(
    resolve(dir, 'ticket.md'),
    `---\nid: ${id}\nslug: ${ticketSlug}\ntitle: "${ticketSlug}"\nproject: ${projectSlug}\nstatus: in_progress\n---\n# ${ticketSlug}\n`,
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
  ticketsDir = resolve(tmpHome, 'tickets');
  await mkdir(projectsDir, { recursive: true });
  await mkdir(ticketsDir, { recursive: true });

  resetSessionDb();
  initSessionDb(resolve(tmpHome, '.syntaur', 'sessions.db'));

  const app = express();
  app.use(express.json());
  app.use('/api/agent-sessions', createAgentSessionsRouter(projectsDir, undefined, ticketsDir));
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

  it('(b) returns 404 for a binding to a non-existent ticket and opens no engagement', async () => {
    await writeTicket('proj', 'real', 'id-real');
    const res = await post({
      agent: 'claude',
      sessionId: 'sess-ghost',
      projectSlug: 'proj',
      ticketSlug: 'ghost', // does not exist
    });
    expect(res.status).toBe(404);
    expect(hasAnyEngagement('sess-ghost')).toBe(false);
  });

  it('(c) registers a valid ticket binding (201) and stores the resolved assignment_id (M1)', async () => {
    await writeTicket('proj', 'real', 'id-real');
    const res = await post({
      agent: 'claude',
      sessionId: 'sess-ok',
      projectSlug: 'proj',
      ticketSlug: 'real',
    });
    expect(res.status).toBe(201);
    const open = getOpenEngagement('sess-ok');
    expect(open).not.toBeNull();
    expect(open!.assignment_id).toBe('id-real'); // M1: id resolved at registration
    expect(open!.project_slug).toBe('proj');
    expect(open!.assignment_slug).toBe('real');
  });

  it('(d) allows a registration-only POST (no ticketSlug) with a valid sessionId', async () => {
    const res = await post({ agent: 'claude', sessionId: 'sess-bare' });
    expect(res.status).toBe(201);
  });

  it('(e) a project-only POST (no ticketSlug) registers UNBOUND — opens no project-bound engagement', async () => {
    await writeTicket('proj', 'real', 'id-real'); // project exists
    const res = await post({ agent: 'claude', sessionId: 'sess-proj-only', projectSlug: 'proj' });
    expect(res.status).toBe(201);
    // Binding requires a ticket selector — a bare/project-only POST is
    // registration-only and must NOT open a project-bound engagement.
    expect(hasAnyEngagement('sess-proj-only')).toBe(false);
  });
});

describe('GET /by-id/:sessionId', () => {
  let dServer: Server;
  let dBase: string;

  beforeEach(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/agent-sessions', createAgentSessionsRouter(projectsDir, undefined, ticketsDir));
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

  it('returns the row with its liveness flag and none of the daemon fields', async () => {
    await register('sess-live');
    const res = await fetch(`${dBase}/by-id/sess-live`);
    expect(res.status).toBe(200);
    const { session } = await res.json();
    expect(session.sessionId).toBe('sess-live');
    expect(session.isLive).toBe(session.status === 'active');
    // The daemon join (short id, attachability, live state, settled screen) and
    // the pty-token route went with the daemon in phase 4 (Decision 5).
    expect(session.syntaurdShortId).toBeUndefined();
    expect(session.attachable).toBeUndefined();
    expect(session.settled).toBeUndefined();
    expect(session.daemonUnavailable).toBeUndefined();
  });

  it('returns 404 for an unknown session', async () => {
    const res = await fetch(`${dBase}/by-id/sess-ghost`);
    expect(res.status).toBe(404);
  });

  it('no longer serves the pty-token route', async () => {
    await register('sess-mint');
    const res = await fetch(`${dBase}/by-id/sess-mint/pty-token`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('does not shadow the existing GET /:projectSlug project listing', async () => {
    await writeTicket('proj', 'real', 'id-real');
    const res = await fetch(`${dBase}/proj`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.sessions)).toBe(true);
  });
});
