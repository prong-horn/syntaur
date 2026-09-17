import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createDashboardServer } from '../dashboard/server.js';
import { closeSessionDb, initSessionDb } from '../dashboard/session-db.js';
import { closeEventsDb, initEventsDb, resetEventsDb, insertLiveEventOrThrow } from '../db/events-db.js';
import { brokerOwnerPath } from '../chat/broker-owner.js';
import { parseChatRuntimeIdentity } from '../chat/dispatch-client.js';

let home: string;
let projectsDir: string;
let playbooksDir: string;
let servers: Array<{ stop(): Promise<void> }> = [];

async function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const tester = createNetServer();
    tester.once('error', reject);
    tester.listen(0, '127.0.0.1', () => {
      const port = (tester.address() as AddressInfo).port;
      tester.close(() => resolvePromise(port));
    });
  });
}

async function bootDashboard(port: number) {
  const server = createDashboardServer({
    port,
    projectsDir,
    playbooksDir,
    serveStaticUi: false,
  });
  await server.start();
  servers.push(server);
  return { server, port };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'sv11-dash-api-'));
  projectsDir = resolve(home, 'projects');
  playbooksDir = resolve(home, 'playbooks');
  process.env.SYNTAUR_HOME = home;
  await mkdir(projectsDir, { recursive: true });
  await mkdir(playbooksDir, { recursive: true });
  await writeFile(
    resolve(home, 'config.md'),
    `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\n---\n`,
  );
  closeSessionDb();
  initSessionDb(resolve(home, 'syntaur.db'));
  closeEventsDb();
  resetEventsDb();
  initEventsDb(resolve(home, 'syntaur.db'));
});

afterEach(async () => {
  for (const server of servers.reverse()) {
    await server.stop().catch(() => {});
  }
  servers = [];
  closeSessionDb();
  closeEventsDb();
  resetEventsDb();
  delete process.env.SYNTAUR_HOME;
  await rm(home, { recursive: true, force: true });
});

async function seedTicket(ticketId: string, entryId: string): Promise<void> {
  const projectSlug = 'meta';
  const ticketSlug = 'demo';
  const ticketDir = resolve(projectsDir, projectSlug, 'tickets', `${ticketId}-${ticketSlug}`);
  await mkdir(ticketDir, { recursive: true });
  await writeFile(
    resolve(ticketDir, 'ticket.md'),
    [
      '---',
      `id: ${ticketId}`,
      'slug: demo',
      'title: Demo',
      'template: feature',
      'status: in_progress',
      '---',
      '# Demo',
    ].join('\n'),
    'utf-8',
  );
  insertLiveEventOrThrow({
    eventId: entryId,
    ticketId,
    projectSlug,
    type: 'moved',
    actor: 'human',
    at: new Date().toISOString(),
    details: {
      stageEntryId: entryId,
      to: 'in_progress',
      dispatchTarget: 'cursor',
      dispatchRole: 'agent',
      dispatchAuto: true,
    },
  });
}

describe('dashboard stage dispatch transport', () => {
  it('serves runtime identity on 127.0.0.1 with owner record', async () => {
    const port = await freePort();
    await bootDashboard(port);
    const res = await fetch(`http://127.0.0.1:${port}/api/chat/runtime`);
    expect(res.status).toBe(200);
    const body = parseChatRuntimeIdentity(await res.json());
    expect(body?.port).toBe(port);
    expect(body?.root).toBeTruthy();
    const owner = await readFile(brokerOwnerPath(home), 'utf-8');
    expect(owner).toContain(String(process.pid));
    expect(owner).toContain(body!.ownerToken);
    const portFile = (await readFile(resolve(home, 'dashboard-port'), 'utf-8')).trim();
    expect(portFile).toBe(String(port));
  });

  it('refuses a second live dashboard owner for the same home', async () => {
    const port1 = await freePort();
    const port2 = await freePort();
    await bootDashboard(port1);
    const second = createDashboardServer({
      port: port2,
      projectsDir,
      playbooksDir,
      serveStaticUi: false,
    });
    await expect(second.start()).rejects.toThrow(/already held|Owner record/);
    await second.stop().catch(() => {});
  });

  it('cleans up port file and owner record on stop', async () => {
    const port = await freePort();
    const { server } = await bootDashboard(port);
    expect(await readFile(resolve(home, 'dashboard-port'), 'utf-8')).toBe(String(port));
    await server.stop();
    servers.pop();
    await expect(readFile(resolve(home, 'dashboard-port'), 'utf-8')).rejects.toThrow();
    await expect(readFile(brokerOwnerPath(home), 'utf-8')).rejects.toThrow();
  });

  it('rejects dispatch with unknown body fields and bad request ids', async () => {
    const port = await freePort();
    await bootDashboard(port);
    const entryId = '00000000-0000-4000-8000-000000000010';
    await seedTicket('SD-10', entryId);
    const base = `http://127.0.0.1:${port}/api/tickets/SD-10/dispatch`;
    const badBody = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entryId,
        requestId: 'auto~wrong',
        source: 'automatic',
        extra: true,
      }),
    });
    expect(badBody.status).toBe(400);
    const badId = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entryId,
        requestId: 'not-auto',
        source: 'automatic',
      }),
    });
    expect(badId.status).toBe(400);
  });

  it('validates stage-entry notification against authoritative entry', async () => {
    const port = await freePort();
    await bootDashboard(port);
    const entryId = '00000000-0000-4000-8000-000000000020';
    await seedTicket('SD-20', entryId);
    const url = `http://127.0.0.1:${port}/api/tickets/SD-20/stage-entry`;
    const stale = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entryId: '00000000-0000-4000-8000-000000000099' }),
    });
    expect(stale.status).toBe(409);
    const notify = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entryId }),
    });
    expect([204, 503]).toContain(notify.status);
  });

  it('releases owner lock when listen fails', async () => {
    const port = await freePort();
    const blocker = createNetServer();
    await new Promise<void>((r) => blocker.listen(port, '127.0.0.1', r));
    const server = createDashboardServer({
      port,
      projectsDir,
      playbooksDir,
      serveStaticUi: false,
    });
    await expect(server.start()).rejects.toThrow(/in use|EADDRINUSE/i);
    await expect(readFile(brokerOwnerPath(home), 'utf-8')).rejects.toThrow();
    blocker.close();
  });
});
