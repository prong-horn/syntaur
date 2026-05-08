import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { RequestHandler, Router } from 'express';
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createWriteRouter } from '../dashboard/api-write.js';
import { listAllMemories, listAllResources } from '../dashboard/api.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-memres-test-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

interface MockResponse {
  statusCode: number;
  payload: unknown;
  ended: boolean;
  status: (code: number) => MockResponse;
  json: (payload: unknown) => MockResponse;
  end: () => MockResponse;
}

function createMockResponse(): MockResponse {
  return {
    statusCode: 200,
    payload: null,
    ended: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

function getRouteHandler(router: Router, method: string, path: string): RequestHandler {
  const layer = (router as Router & {
    stack?: Array<{
      route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{ handle: RequestHandler }>;
      };
    }>;
  }).stack?.find((candidate) => {
    const route = candidate.route;
    return route?.path === path && route.methods[method];
  });

  if (!layer?.route?.stack?.[0]) {
    throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  }

  return layer.route.stack[0].handle;
}

async function invokeRoute(
  router: Router,
  method: 'patch' | 'post' | 'get' | 'delete',
  path: string,
  params: Record<string, string>,
  body: unknown,
): Promise<MockResponse> {
  const handler = getRouteHandler(router, method, path);
  const response = createMockResponse();
  await handler(
    { params, body, query: {} } as any,
    response as any,
    (() => undefined) as any,
  );
  return response;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function createProjectFixture(slug = 'sample'): Promise<string> {
  const projectDir = resolve(testDir, slug);
  await mkdir(resolve(projectDir, 'memories'), { recursive: true });
  await mkdir(resolve(projectDir, 'resources'), { recursive: true });

  await writeFile(
    resolve(projectDir, 'project.md'),
    `---
id: project-${slug}
slug: ${slug}
title: ${slug.charAt(0).toUpperCase() + slug.slice(1)} Project
archived: false
archivedAt: null
archivedReason: null
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
tags: []
---

# Project`,
    'utf-8',
  );

  return projectDir;
}

async function seedMemory(projectDir: string, slug: string, name: string): Promise<void> {
  await writeFile(
    resolve(projectDir, 'memories', `${slug}.md`),
    `---
type: memory
name: ${name}
source: claude
sourceAssignment: null
relatedAssignments: []
scope: project
created: "2026-04-01T10:00:00Z"
updated: "2026-04-01T10:00:00Z"
tags: []
---

# ${name}

Original body.
`,
    'utf-8',
  );
}

async function seedResource(projectDir: string, slug: string, name: string): Promise<void> {
  await writeFile(
    resolve(projectDir, 'resources', `${slug}.md`),
    `---
type: resource
name: ${name}
source: claude
category: documentation
sourceUrl: null
sourceAssignment: null
relatedAssignments: []
created: "2026-04-01T10:00:00Z"
updated: "2026-04-01T10:00:00Z"
---

# ${name}

Original body.
`,
    'utf-8',
  );
}

describe('listAllMemories / listAllResources (cross-project)', () => {
  it('walks every project and enriches with project context', async () => {
    const sampleDir = await createProjectFixture('sample');
    const otherDir = await createProjectFixture('other');
    await seedMemory(sampleDir, 'pg-pooling', 'Postgres Pooling');
    await seedMemory(otherDir, 'redis-cache', 'Redis Cache');
    await seedResource(sampleDir, 'auth-spec', 'Auth Spec');

    const memories = await listAllMemories(testDir);
    expect(memories).toHaveLength(2);
    const slugs = memories.map((m) => m.slug).sort();
    expect(slugs).toEqual(['pg-pooling', 'redis-cache']);
    const projectSlugs = memories.map((m) => m.projectSlug).sort();
    expect(projectSlugs).toEqual(['other', 'sample']);
    const sampleEntry = memories.find((m) => m.slug === 'pg-pooling');
    expect(sampleEntry?.projectTitle).toBe('Sample Project');
    expect(sampleEntry?.relatedAssignments).toEqual([]);

    const resources = await listAllResources(testDir);
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      slug: 'auth-spec',
      projectSlug: 'sample',
      projectTitle: 'Sample Project',
      category: 'documentation',
    });
  });

  it('skips _index.md and underscore-prefixed files', async () => {
    const dir = await createProjectFixture('sample');
    await writeFile(resolve(dir, 'memories', '_index.md'), '# Index', 'utf-8');
    await seedMemory(dir, 'real', 'Real Memory');

    const memories = await listAllMemories(testDir);
    expect(memories.map((m) => m.slug)).toEqual(['real']);
  });
});

describe('memory CRUD routes', () => {
  it('GET detail returns full body', async () => {
    const dir = await createProjectFixture('sample');
    await seedMemory(dir, 'pg', 'PG');
    const router = createWriteRouter(testDir);

    const res = await invokeRoute(
      router,
      'get',
      '/api/projects/:slug/memories/:itemSlug',
      { slug: 'sample', itemSlug: 'pg' },
      undefined,
    );

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({
      slug: 'pg',
      name: 'PG',
      projectSlug: 'sample',
      projectTitle: 'Sample Project',
    });
  });

  it('GET detail 404s when missing', async () => {
    await createProjectFixture('sample');
    const router = createWriteRouter(testDir);

    const res = await invokeRoute(
      router,
      'get',
      '/api/projects/:slug/memories/:itemSlug',
      { slug: 'sample', itemSlug: 'nonexistent' },
      undefined,
    );
    expect(res.statusCode).toBe(404);
  });

  it('POST creates a new memory and 409s on collision', async () => {
    await createProjectFixture('sample');
    const router = createWriteRouter(testDir);

    const first = await invokeRoute(
      router,
      'post',
      '/api/projects/:slug/memories',
      { slug: 'sample' },
      { name: 'Pg Pooling' },
    );
    expect(first.statusCode).toBe(201);
    expect((first.payload as { slug: string }).slug).toBe('pg-pooling');
    expect(await fileExists(resolve(testDir, 'sample', 'memories', 'pg-pooling.md'))).toBe(true);

    const second = await invokeRoute(
      router,
      'post',
      '/api/projects/:slug/memories',
      { slug: 'sample' },
      { name: 'Pg Pooling' },
    );
    expect(second.statusCode).toBe(409);
  });

  it('POST 400s when slugified name is empty', async () => {
    await createProjectFixture('sample');
    const router = createWriteRouter(testDir);

    const res = await invokeRoute(
      router,
      'post',
      '/api/projects/:slug/memories',
      { slug: 'sample' },
      { name: '!!!' },
    );
    expect(res.statusCode).toBe(400);
  });

  it('POST 404s when project does not exist', async () => {
    const router = createWriteRouter(testDir);
    const res = await invokeRoute(
      router,
      'post',
      '/api/projects/:slug/memories',
      { slug: 'no-project' },
      { name: 'Anything' },
    );
    expect(res.statusCode).toBe(404);
  });

  it('PATCH replaces only the body and bumps updated', async () => {
    const dir = await createProjectFixture('sample');
    await seedMemory(dir, 'pg', 'Original Name');
    const router = createWriteRouter(testDir);

    // Client tries to change name AND body — only body should win.
    const res = await invokeRoute(
      router,
      'patch',
      '/api/projects/:slug/memories/:itemSlug',
      { slug: 'sample', itemSlug: 'pg' },
      {
        content: `---
type: memory
name: HACKER OVERRIDE
source: external
sourceAssignment: null
relatedAssignments:
  - injected
scope: external
created: "2020-01-01T00:00:00Z"
updated: "2020-01-01T00:00:00Z"
tags:
  - injected
---

# Replaced body content

This is the new body.
`,
      },
    );

    expect(res.statusCode).toBe(200);
    const fileContent = await readFile(resolve(dir, 'memories', 'pg.md'), 'utf-8');
    // Frontmatter survives unchanged
    expect(fileContent).toContain('name: Original Name');
    expect(fileContent).toContain('source: claude');
    expect(fileContent).not.toContain('HACKER OVERRIDE');
    expect(fileContent).not.toContain('injected');
    // Body replaced
    expect(fileContent).toContain('Replaced body content');
    expect(fileContent).not.toContain('Original body.');
    // updated advanced beyond seed timestamp
    expect(fileContent).not.toContain('updated: "2026-04-01T10:00:00Z"');
  });

  it('DELETE removes the file; second DELETE 404s', async () => {
    const dir = await createProjectFixture('sample');
    await seedMemory(dir, 'pg', 'PG');
    const router = createWriteRouter(testDir);

    const first = await invokeRoute(
      router,
      'delete',
      '/api/projects/:slug/memories/:itemSlug',
      { slug: 'sample', itemSlug: 'pg' },
      undefined,
    );
    expect(first.statusCode).toBe(204);
    expect(await fileExists(resolve(dir, 'memories', 'pg.md'))).toBe(false);

    const second = await invokeRoute(
      router,
      'delete',
      '/api/projects/:slug/memories/:itemSlug',
      { slug: 'sample', itemSlug: 'pg' },
      undefined,
    );
    expect(second.statusCode).toBe(404);
  });
});

describe('resource CRUD routes (parity)', () => {
  it('round-trip create → detail → patch (body-only) → delete', async () => {
    await createProjectFixture('sample');
    const router = createWriteRouter(testDir);

    // Create
    const create = await invokeRoute(
      router,
      'post',
      '/api/projects/:slug/resources',
      { slug: 'sample' },
      { name: 'Auth Requirements', body: '# Auth\n\nFunctional requirements here.\n' },
    );
    expect(create.statusCode).toBe(201);
    const createdSlug = (create.payload as { slug: string }).slug;
    expect(createdSlug).toBe('auth-requirements');

    // Detail
    const detail = await invokeRoute(
      router,
      'get',
      '/api/projects/:slug/resources/:itemSlug',
      { slug: 'sample', itemSlug: createdSlug },
      undefined,
    );
    expect(detail.statusCode).toBe(200);
    expect(detail.payload).toMatchObject({
      name: 'Auth Requirements',
      category: 'documentation',
      projectSlug: 'sample',
    });

    // Patch (body-only)
    const patch = await invokeRoute(
      router,
      'patch',
      '/api/projects/:slug/resources/:itemSlug',
      { slug: 'sample', itemSlug: createdSlug },
      {
        content: `---
type: resource
name: Different Name
source: external
category: HACKED
sourceUrl: null
sourceAssignment: null
relatedAssignments: []
created: "2020-01-01T00:00:00Z"
updated: "2020-01-01T00:00:00Z"
---

# New body

Updated.
`,
      },
    );
    expect(patch.statusCode).toBe(200);
    const fileContent = await readFile(
      resolve(testDir, 'sample', 'resources', `${createdSlug}.md`),
      'utf-8',
    );
    expect(fileContent).toMatch(/name: ["']?Auth Requirements/);
    expect(fileContent).toContain('category: documentation');
    expect(fileContent).not.toContain('HACKED');
    expect(fileContent).toContain('# New body');

    // Delete
    const del = await invokeRoute(
      router,
      'delete',
      '/api/projects/:slug/resources/:itemSlug',
      { slug: 'sample', itemSlug: createdSlug },
      undefined,
    );
    expect(del.statusCode).toBe(204);
  });
});
