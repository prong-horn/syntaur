import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  readDashboardPort,
  verifyChatRuntime,
  fetchChatRuntime,
  parseChatRuntimeIdentity,
  postTicketDispatch,
  postStageEntryNotify,
  postCliStageDispatch,
} from '../chat/dispatch-client.js';
import { acquireHomeOwnerLock, brokerOwnerPath } from '../chat/broker-owner.js';
import { captureProcessStartedAt } from '../utils/process-info.js';
import { canonicalPath } from '../utils/path-canon.js';

let home: string;
let projectsDir: string;
let httpServer: Server | null = null;
let ownerRelease: (() => Promise<void>) | null = null;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'sv11-dispatch-cli-'));
  projectsDir = resolve(home, 'projects');
  process.env.SYNTAUR_HOME = home;
  await writeFile(
    resolve(home, 'config.md'),
    `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\n---\n`,
  );
});

afterEach(async () => {
  if (ownerRelease) {
    await ownerRelease().catch(() => {});
    ownerRelease = null;
  }
  if (httpServer) {
    await new Promise<void>((r) => httpServer!.close(() => r()));
    httpServer = null;
  }
  delete process.env.SYNTAUR_HOME;
  await rm(home, { recursive: true, force: true });
});

async function bootRuntimeServer(
  overrides: Partial<Record<string, unknown>> = {},
): Promise<{ port: number; token: string }> {
  const app = express();
  httpServer = createServer(app);
  await new Promise<void>((r) => httpServer!.listen(0, '127.0.0.1', r));
  const port = (httpServer!.address() as AddressInfo).port;
  await writeFile(resolve(home, 'dashboard-port'), String(port), 'utf-8');
  const owner = await acquireHomeOwnerLock(port, home);
  ownerRelease = () => owner.release();
  const token = (await readFile(brokerOwnerPath(home), 'utf-8')).trim().split('\n')[2];
  app.get('/api/chat/runtime', (_req, res) => {
    res.json({
      protocol: 1,
      root: canonicalPath(home),
      projectsDir: canonicalPath(projectsDir),
      pid: process.pid,
      processStartedAt: captureProcessStartedAt(process.pid),
      ownerToken: token,
      port,
      ...overrides,
    });
  });
  return { port, token };
}

describe('dispatch-client', () => {
  it('returns null port when file missing', async () => {
    expect(await readDashboardPort(home)).toBeNull();
  });

  it('rejects invalid port values', async () => {
    await writeFile(resolve(home, 'dashboard-port'), '99999\n', 'utf-8');
    expect(await readDashboardPort(home)).toBeNull();
    await writeFile(resolve(home, 'dashboard-port'), '48o0\n', 'utf-8');
    expect(await readDashboardPort(home)).toBeNull();
    await writeFile(resolve(home, 'dashboard-port'), ' 4800 \n', 'utf-8');
    expect(await readDashboardPort(home)).toBe(4800);
  });

  it('parseChatRuntimeIdentity rejects malformed payloads', () => {
    expect(parseChatRuntimeIdentity(null)).toBeNull();
    expect(parseChatRuntimeIdentity({ protocol: 2 })).toBeNull();
    expect(
      parseChatRuntimeIdentity({
        protocol: 1,
        root: '/x',
        projectsDir: '/p',
        pid: 1,
        processStartedAt: null,
        ownerToken: 'tok',
        port: 0,
      }),
    ).toBeNull();
  });

  it('verifyChatRuntime fails without live server', async () => {
    await writeFile(resolve(home, 'dashboard-port'), '54321\n', 'utf-8');
    expect(await verifyChatRuntime(home)).toBeNull();
  });

  it('verifyChatRuntime requires matching home, projectsDir and owner record', async () => {
    const { port, token } = await bootRuntimeServer();
    const verified = await verifyChatRuntime(home);
    expect(verified?.port).toBe(port);
    expect(verified?.runtime.ownerToken).toBe(token);
  });

  it('fetchChatRuntime rejects runtime port mismatch', async () => {
    const { port } = await bootRuntimeServer({ port: 65000 });
    expect(await fetchChatRuntime(port)).toBeNull();
  });

  it('postTicketDispatch returns offline without verified runtime', async () => {
    const result = await postTicketDispatch({
      ticketId: 'T-1',
      entryId: '00000000-0000-4000-8000-000000000001',
      requestId: 'auto~00000000-0000-4000-8000-000000000001',
      source: 'automatic',
    });
    expect(result.state).toBe('offline');
  });

  it('postStageEntryNotify is attached to postCliStageDispatch', async () => {
    expect(typeof postCliStageDispatch.notifyStageEntry).toBe('function');
    await expect(
      postStageEntryNotify({
        ticketId: 'T-1',
        ticketDir: '/tmp',
        projectSlug: null,
        entryId: '00000000-0000-4000-8000-000000000001',
      }),
    ).rejects.toThrow(/unavailable|mismatch/i);
  });
});
