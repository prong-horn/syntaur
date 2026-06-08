import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createAgentsRouter } from '../dashboard/api-agents.js';
import { BUILTIN_AGENTS } from '../utils/agents-schema.js';

const originalHome = process.env.HOME;

let tmpHome: string;
let server: Server;
let baseUrl: string;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'syntaur-agents-api-'));
  await mkdir(join(tmpHome, '.syntaur'), { recursive: true });
  process.env.HOME = tmpHome;

  const app = express();
  app.use(express.json());
  app.use('/api/config/agents', createAgentsRouter());

  await new Promise<void>((ready) => {
    server = app.listen(0, () => ready());
  });
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}/api/config/agents`;
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  process.env.HOME = originalHome;
  await rm(tmpHome, { recursive: true, force: true });
});

describe('GET /api/config/agents', () => {
  it('returns BUILTIN_AGENTS with custom=false when config has no agents block', async () => {
    const res = await fetch(baseUrl);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.custom).toBe(false);
    expect(body.agents).toEqual(BUILTIN_AGENTS);
  });

  it('returns the saved list with custom=true after a PUT', async () => {
    const payload = {
      agents: [
        { id: 'foo', label: 'Foo', command: 'foo', default: true },
      ],
    };
    const putRes = await fetch(baseUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(putRes.status).toBe(200);

    const getRes = await fetch(baseUrl);
    expect(getRes.status).toBe(200);
    const body = await getRes.json();
    expect(body.custom).toBe(true);
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].id).toBe('foo');
    expect(body.agents[0].default).toBe(true);
  });
});

describe('PUT /api/config/agents', () => {
  async function put(body: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(baseUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  it('accepts a valid single-agent list and round-trips', async () => {
    const r = await put({
      agents: [{ id: 'claude', label: 'Claude', command: 'claude', default: true }],
    });
    expect(r.status).toBe(200);
    expect(r.body.custom).toBe(true);
    expect(r.body.agents[0].id).toBe('claude');
  });

  it('accepts zero defaults (backend permissive; UI coerces)', async () => {
    const r = await put({
      agents: [{ id: 'foo', label: 'Foo', command: 'foo' }],
    });
    expect(r.status).toBe(200);
    expect(r.body.agents[0].default).toBeUndefined();
  });

  it('400 + fieldErrors for duplicate id', async () => {
    const r = await put({
      agents: [
        { id: 'x', label: 'A', command: 'a' },
        { id: 'x', label: 'B', command: 'b' },
      ],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/duplicate agent id "x"/);
    expect(r.body.fieldErrors).toEqual([
      { id: 'x', field: 'id', message: 'duplicate id' },
    ]);
  });

  it('400 + fieldErrors for invalid id pattern', async () => {
    const r = await put({
      agents: [{ id: 'Bad-Id', label: 'X', command: 'x' }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/is invalid/);
    expect(r.body.fieldErrors[0]).toMatchObject({ id: 'Bad-Id', field: 'id' });
  });

  it('400 + fieldErrors for empty label', async () => {
    const r = await put({
      agents: [{ id: 'foo', label: '', command: 'foo' }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/empty label/);
    expect(r.body.fieldErrors[0]).toMatchObject({ id: 'foo', field: 'label' });
  });

  it('400 + fieldErrors for empty command', async () => {
    const r = await put({
      agents: [{ id: 'foo', label: 'Foo', command: '' }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/empty command/);
    expect(r.body.fieldErrors[0]).toMatchObject({ id: 'foo', field: 'command' });
  });

  it('400 + fieldErrors for relative-path command', async () => {
    const r = await put({
      agents: [{ id: 'foo', label: 'Foo', command: './foo' }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/relative path/);
    expect(r.body.fieldErrors[0]).toMatchObject({ id: 'foo', field: 'command' });
  });

  it('400 + fieldErrors for invalid promptArgPosition', async () => {
    const r = await put({
      agents: [
        { id: 'foo', label: 'Foo', command: 'foo', promptArgPosition: 'middle' },
      ],
    });
    expect(r.status).toBe(400);
    expect(r.body.fieldErrors[0]).toMatchObject({
      field: 'promptArgPosition',
    });
  });

  it('400 + fieldErrors for more-than-one default', async () => {
    const r = await put({
      agents: [
        { id: 'a', label: 'A', command: 'a', default: true },
        { id: 'b', label: 'B', command: 'b', default: true },
      ],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/more than one agent is marked default/);
    expect(r.body.fieldErrors).toEqual([
      { field: 'default', message: 'only one agent may be default' },
    ]);
  });

  it('400 when body is not an object with agents array', async () => {
    const r1 = await put({});
    expect(r1.status).toBe(400);
    expect(r1.body.error).toMatch(/agents must be an array/);

    const r2 = await put({ agents: 'foo' });
    expect(r2.status).toBe(400);
    expect(r2.body.error).toMatch(/agents must be an array/);
  });

  it('400 when a row is not an object (includes row index)', async () => {
    const r = await put({ agents: [{ id: 'ok', label: 'O', command: 'o' }, null] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/must be an object/);
    expect(r.body.fieldErrors[0]).toMatchObject({ index: 1, field: 'row' });
  });

  it('400 when a row has no id (includes row index, no id field)', async () => {
    const r = await put({ agents: [{ label: 'X', command: 'x' }] });
    expect(r.status).toBe(400);
    expect(r.body.fieldErrors[0]).toMatchObject({ index: 0, field: 'id' });
    expect(r.body.fieldErrors[0].id).toBeUndefined();
  });

  it('400 when args is not an array of strings', async () => {
    const r = await put({
      agents: [{ id: 'foo', label: 'Foo', command: 'foo', args: 'oops' }],
    });
    expect(r.status).toBe(400);
    expect(r.body.fieldErrors[0]).toMatchObject({ id: 'foo', field: 'args' });
  });

  it('accepts and round-trips model + playbook', async () => {
    const r = await put({
      agents: [
        {
          id: 'claude',
          label: 'Claude',
          command: 'claude',
          model: 'opus',
          playbook: 'e2e-dev-cycle',
        },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.agents[0]).toMatchObject({ model: 'opus', playbook: 'e2e-dev-cycle' });
  });

  it('normalizes empty/whitespace model + playbook to omitted', async () => {
    const r = await put({
      agents: [{ id: 'foo', label: 'Foo', command: 'foo', model: '   ', playbook: '' }],
    });
    expect(r.status).toBe(200);
    expect(r.body.agents[0].model).toBeUndefined();
    expect(r.body.agents[0].playbook).toBeUndefined();
  });

  it('400 + fieldErrors when model is not a string', async () => {
    const r = await put({
      agents: [{ id: 'foo', label: 'Foo', command: 'foo', model: 123 }],
    });
    expect(r.status).toBe(400);
    expect(r.body.fieldErrors[0]).toMatchObject({ id: 'foo', field: 'model' });
  });

  it('400 + fieldErrors mapping an invalid playbook slug to field:playbook', async () => {
    const r = await put({
      agents: [{ id: 'foo', label: 'Foo', command: 'foo', playbook: 'bad_slug' }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/invalid playbook/);
    expect(r.body.fieldErrors[0]).toMatchObject({ id: 'foo', field: 'playbook' });
  });
});

describe('DELETE /api/config/agents', () => {
  it('after PUT then DELETE, GET returns BUILTIN_AGENTS with custom=false', async () => {
    await fetch(baseUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agents: [{ id: 'foo', label: 'Foo', command: 'foo' }],
      }),
    });

    const delRes = await fetch(baseUrl, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    const delBody = await delRes.json();
    expect(delBody.custom).toBe(false);
    expect(delBody.agents).toEqual(BUILTIN_AGENTS);

    const getRes = await fetch(baseUrl);
    const getBody = await getRes.json();
    expect(getBody.custom).toBe(false);
    expect(getBody.agents).toEqual(BUILTIN_AGENTS);
  });

  it('DELETE on a fresh config (no agents block) is a no-op 200', async () => {
    const res = await fetch(baseUrl, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.custom).toBe(false);
    expect(body.agents).toEqual(BUILTIN_AGENTS);
  });
});
