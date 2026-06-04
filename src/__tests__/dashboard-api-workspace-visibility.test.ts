import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createWorkspaceVisibilityConfigRouter } from '../dashboard/api-workspace-visibility-config.js';

const originalHome = process.env.HOME;
const originalSyntaurHome = process.env.SYNTAUR_HOME;

let tmpHome: string;
let server: Server;
let baseUrl: string;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'syntaur-wsvis-api-'));
  await mkdir(join(tmpHome, '.syntaur'), { recursive: true });
  process.env.HOME = tmpHome;
  process.env.SYNTAUR_HOME = join(tmpHome, '.syntaur');

  const app = express();
  app.use(express.json());
  app.use('/api/config/workspace-visibility', createWorkspaceVisibilityConfigRouter());

  await new Promise<void>((ready) => {
    server = app.listen(0, () => ready());
  });
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}/api/config/workspace-visibility`;
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  process.env.HOME = originalHome;
  if (originalSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = originalSyntaurHome;
  await rm(tmpHome, { recursive: true, force: true });
});

describe('GET /api/config/workspace-visibility', () => {
  it('returns an empty blocklist with custom=false when unset', async () => {
    const res = await fetch(baseUrl);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hidden).toEqual([]);
    expect(body.custom).toBe(false);
  });
});

describe('POST /api/config/workspace-visibility', () => {
  it('persists the blocklist and reports custom=true after save', async () => {
    const postRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden: ['archive', '_ungrouped'] }),
    });
    expect(postRes.status).toBe(200);
    const postBody = await postRes.json();
    expect(postBody.hidden).toEqual(['archive', '_ungrouped']);
    expect(postBody.custom).toBe(true);

    const getRes = await fetch(baseUrl);
    const getBody = await getRes.json();
    expect(getBody.hidden).toEqual(['archive', '_ungrouped']);
    expect(getBody.custom).toBe(true);
  });

  it('trims and dedupes the blocklist on save', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden: ['a', 'a', ' a ', '', 'b'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hidden).toEqual(['a', 'b']);
  });

  it('rejects a non-array hidden value with 400', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden: 'nope' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/array of strings/);
  });

  it('rejects an array containing a non-string with 400', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden: ['ok', 42] }),
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/config/workspace-visibility', () => {
  it('clears the saved blocklist and returns custom=false', async () => {
    await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden: ['archive'] }),
    });

    const delRes = await fetch(baseUrl, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    const delBody = await delRes.json();
    expect(delBody.hidden).toEqual([]);
    expect(delBody.custom).toBe(false);

    const getRes = await fetch(baseUrl);
    const getBody = await getRes.json();
    expect(getBody.hidden).toEqual([]);
    expect(getBody.custom).toBe(false);
  });
});
