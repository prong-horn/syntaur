import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createTerminalConfigRouter } from '../dashboard/api-terminal-config.js';

const originalHome = process.env.HOME;
const originalSyntaurHome = process.env.SYNTAUR_HOME;

let tmpHome: string;
let server: Server;
let baseUrl: string;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'syntaur-terminal-api-'));
  await mkdir(join(tmpHome, '.syntaur'), { recursive: true });
  process.env.HOME = tmpHome;
  process.env.SYNTAUR_HOME = join(tmpHome, '.syntaur');

  const app = express();
  app.use(express.json());
  app.use('/api/config/terminal', createTerminalConfigRouter());

  await new Promise<void>((ready) => {
    server = app.listen(0, () => ready());
  });
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}/api/config/terminal`;
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  process.env.HOME = originalHome;
  if (originalSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = originalSyntaurHome;
  await rm(tmpHome, { recursive: true, force: true });
});

describe('GET /api/config/terminal', () => {
  it('returns OS-aware default with custom=false when config has no terminal key', async () => {
    const res = await fetch(baseUrl);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.custom).toBe(false);
    // On the test host the value should be a valid TerminalChoice; we don't
    // pin to a specific one (varies by OS).
    expect(typeof body.terminal).toBe('string');
  });
});

describe('POST /api/config/terminal', () => {
  it('persists the choice and reports custom=true after save', async () => {
    const postRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminal: 'ghostty' }),
    });
    expect(postRes.status).toBe(200);
    const postBody = await postRes.json();
    expect(postBody.terminal).toBe('ghostty');
    expect(postBody.custom).toBe(true);

    const getRes = await fetch(baseUrl);
    const getBody = await getRes.json();
    expect(getBody.terminal).toBe('ghostty');
    expect(getBody.custom).toBe(true);
  });

  it('persists cmux and reports custom=true after save', async () => {
    const postRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminal: 'cmux' }),
    });
    expect(postRes.status).toBe(200);
    const postBody = await postRes.json();
    expect(postBody.terminal).toBe('cmux');
    expect(postBody.custom).toBe(true);

    const getRes = await fetch(baseUrl);
    const getBody = await getRes.json();
    expect(getBody.terminal).toBe('cmux');
    expect(getBody.custom).toBe(true);
  });

  it('rejects an unknown terminal value with 400', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminal: 'bogus' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/terminal must be one of/);
  });

  it('rejects a missing terminal value with 400', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/config/terminal', () => {
  it('clears the saved choice and returns custom=false', async () => {
    await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminal: 'iterm' }),
    });

    const delRes = await fetch(baseUrl, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    const delBody = await delRes.json();
    expect(delBody.custom).toBe(false);

    const getRes = await fetch(baseUrl);
    const getBody = await getRes.json();
    expect(getBody.custom).toBe(false);
  });
});
