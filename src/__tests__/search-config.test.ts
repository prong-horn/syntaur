import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createSearchConfigRouter } from '../dashboard/api-search-config.js';
import { readConfig, writeSearchConfig, deleteSearchConfig } from '../utils/config.js';
import { DEFAULT_SEARCH_CONFIG } from '../utils/search-schema.js';

const originalHome = process.env.HOME;
const originalSyntaurHome = process.env.SYNTAUR_HOME;

let tmpHome: string;
let server: Server;
let baseUrl: string;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'syntaur-search-api-'));
  await mkdir(join(tmpHome, '.syntaur'), { recursive: true });
  process.env.HOME = tmpHome;
  process.env.SYNTAUR_HOME = join(tmpHome, '.syntaur');

  const app = express();
  app.use(express.json());
  app.use('/api/config/search', createSearchConfigRouter());

  await new Promise<void>((ready) => {
    server = app.listen(0, () => ready());
  });
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}/api/config/search`;
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  process.env.HOME = originalHome;
  if (originalSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = originalSyntaurHome;
  await rm(tmpHome, { recursive: true, force: true });
});

describe('GET /api/config/search', () => {
  it('returns the defaults with custom=false when no search block exists', async () => {
    const res = await fetch(baseUrl);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.custom).toBe(false);
    expect(body.search).toEqual(DEFAULT_SEARCH_CONFIG);
  });
});

describe('POST /api/config/search', () => {
  it('persists a valid config and reports custom=true', async () => {
    const payload = {
      defaultScope: 'project',
      aliases: { a: 'assignment', pb: 'playbook' },
      externalIds: false,
    };
    const postRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(postRes.status).toBe(200);
    const postBody = await postRes.json();
    expect(postBody.custom).toBe(true);
    expect(postBody.search).toEqual(payload);

    const getRes = await fetch(baseUrl);
    const getBody = await getRes.json();
    expect(getBody.custom).toBe(true);
    expect(getBody.search).toEqual(payload);
  });

  it('rejects an alias colliding with a field name (400)', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliases: { status: 'assignment' } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors.join(' ')).toMatch(/collides/);
  });

  it('rejects the reserved "all" alias key (400)', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliases: { all: 'assignment' } }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a bad alias key shape (400)', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliases: { Foo: 'assignment' } }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an alias mapping to a non-entity kind (400)', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliases: { x: 'widget' } }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid defaultScope (400)', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultScope: 'everything', aliases: {} }),
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/config/search', () => {
  it('resets to defaults and reports custom=false', async () => {
    await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultScope: 'todo', aliases: {}, externalIds: false }),
    });

    const delRes = await fetch(baseUrl, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    const delBody = await delRes.json();
    expect(delBody.custom).toBe(false);
    expect(delBody.search).toEqual(DEFAULT_SEARCH_CONFIG);

    const getRes = await fetch(baseUrl);
    const getBody = await getRes.json();
    expect(getBody.custom).toBe(false);
  });
});

describe('config.md persistence round-trip', () => {
  it('writeSearchConfig emits a search: block that readConfig parses back', async () => {
    const cfg = {
      defaultScope: 'assignment' as const,
      aliases: { a: 'assignment' as const, t: 'todo' as const },
      externalIds: false,
    };
    await writeSearchConfig(cfg);

    const raw = await readFile(resolve(tmpHome, '.syntaur/config.md'), 'utf-8');
    expect(raw).toMatch(/^search:$/m);
    expect(raw).toMatch(/^\s+defaultScope: assignment$/m);
    expect(raw).toMatch(/^\s+externalIds: false$/m);

    const config = await readConfig();
    expect(config.searchConfig).toEqual(cfg);
  });

  it('deleteSearchConfig removes the search: block', async () => {
    await writeSearchConfig({
      defaultScope: 'project',
      aliases: {},
      externalIds: true,
    });
    await deleteSearchConfig();
    const raw = await readFile(resolve(tmpHome, '.syntaur/config.md'), 'utf-8');
    expect(raw).not.toMatch(/^search:$/m);
    const config = await readConfig();
    expect(config.searchConfig).toBeNull();
  });
});

describe('parseSearchConfig robustness', () => {
  const configPath = () => resolve(tmpHome, '.syntaur/config.md');

  it('parses the real search: block even when an earlier value contains "search:"', async () => {
    const md = [
      '---',
      'version: "2.0"',
      'defaultProjectDir: ~/projects',
      'notes: "a query like search:foo must not confuse the parser"',
      'search:',
      '  defaultScope: project',
      '  aliases:',
      '    a: assignment',
      '  externalIds: false',
      '---',
      '',
    ].join('\n');
    await writeFile(configPath(), md);
    const config = await readConfig();
    expect(config.searchConfig).toEqual({
      defaultScope: 'project',
      aliases: { a: 'assignment' },
      externalIds: false,
    });
  });

  it('parses externalIds case/quote tolerantly and defaults junk to true', async () => {
    const readExternalIds = async (line: string): Promise<boolean | undefined> => {
      const md = [
        '---',
        'version: "2.0"',
        'defaultProjectDir: ~/projects',
        'search:',
        '  defaultScope: all',
        '  aliases:',
        '    a: assignment',
        `  externalIds: ${line}`,
        '---',
        '',
      ].join('\n');
      await writeFile(configPath(), md);
      return (await readConfig()).searchConfig?.externalIds;
    };
    expect(await readExternalIds('false')).toBe(false);
    expect(await readExternalIds('"false"')).toBe(false);
    expect(await readExternalIds('TRUE')).toBe(true);
    expect(await readExternalIds('yes')).toBe(true); // unrecognized → default true
  });

  it('unquotes a quoted defaultScope so it stays valid', async () => {
    const md = [
      '---',
      'version: "2.0"',
      'defaultProjectDir: ~/projects',
      'search:',
      '  defaultScope: "todo"',
      '  aliases:',
      '    a: assignment',
      '  externalIds: true',
      '---',
      '',
    ].join('\n');
    await writeFile(configPath(), md);
    const config = await readConfig();
    expect(config.searchConfig?.defaultScope).toBe('todo');
  });
});
