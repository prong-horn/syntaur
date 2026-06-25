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
});
