import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createLaunchPreflightRouter } from '../dashboard/api-launch-preflight.js';

const originalHome = process.env.HOME;
const originalSyntaurHome = process.env.SYNTAUR_HOME;
const originalPath = process.env.PATH;

let tmpHome: string;
let pathDir: string;
let server: Server;
let baseUrl: string;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'syntaur-preflight-api-'));
  await mkdir(join(tmpHome, '.syntaur'), { recursive: true });
  process.env.HOME = tmpHome;
  process.env.SYNTAUR_HOME = join(tmpHome, '.syntaur');
  pathDir = await mkdtemp(join(tmpdir(), 'syntaur-preflight-path-'));

  const app = express();
  app.use(express.json());
  app.use('/api/launch', createLaunchPreflightRouter());

  await new Promise<void>((ready) => {
    server = app.listen(0, () => ready());
  });
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}/api/launch/preflight`;
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  process.env.HOME = originalHome;
  process.env.PATH = originalPath;
  if (originalSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = originalSyntaurHome;
  await rm(tmpHome, { recursive: true, force: true });
  await rm(pathDir, { recursive: true, force: true });
});

describe('POST /api/launch/preflight', () => {
  it('returns ok:true when the requested CLI terminal is on PATH', async () => {
    // Stage a fake `kitty` so the `which` probe finds it.
    const kittyPath = join(pathDir, 'kitty');
    await writeFile(kittyPath, '#!/bin/sh\nexit 0\n');
    await chmod(kittyPath, 0o755);
    process.env.PATH = `${pathDir}:/usr/bin:/bin`;

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminal: 'kitty' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.terminal).toBe('kitty');
  });

  it('returns ok:false with suggestedFallback when the requested CLI terminal is missing', async () => {
    // PATH points at a non-existent dir so `which` itself fails to resolve.
    process.env.PATH = '/tmp/syntaur-preflight-no-such-dir';

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminal: 'alacritty' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.terminal).toBe('alacritty');
    expect(body.reason).toBe('not-installed');
    expect(typeof body.suggestedFallback).toBe('string');
  });

  it('rejects an invalid terminal value with 400', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminal: 'bogus' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/terminal must be one of/);
  });

  it('uses the configured terminal when body has no terminal', async () => {
    // No saved terminal → getTerminal returns OS-aware default. The response
    // shape should still be valid (ok or not depending on host install state).
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.ok).toBe('boolean');
    expect(typeof body.terminal).toBe('string');
  });
});
