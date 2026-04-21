import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { RequestHandler, Router } from 'express';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createWriteRouter } from '../dashboard/api-write.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-write-test-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

interface MockResponse {
  statusCode: number;
  payload: unknown;
  status: (code: number) => MockResponse;
  json: (payload: unknown) => MockResponse;
}

function createMockResponse(): MockResponse {
  return {
    statusCode: 200,
    payload: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
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
  method: 'patch' | 'post',
  path: string,
  params: Record<string, string>,
  body: unknown,
): Promise<MockResponse> {
  const handler = getRouteHandler(router, method, path);
  const response = createMockResponse();

  await handler(
    {
      params,
      body,
    } as any,
    response as any,
    (() => undefined) as any,
  );

  return response;
}

async function createAssignmentFixture(): Promise<void> {
  const projectDir = resolve(testDir, 'test-project');
  const assignmentDir = resolve(projectDir, 'assignments', 'test-assignment');
  await mkdir(assignmentDir, { recursive: true });

  await writeFile(resolve(projectDir, 'project.md'), `---
id: project-1
slug: test-project
title: Test Project
archived: false
archivedAt: null
archivedReason: null
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
tags: []
---

# Test Project`, 'utf-8');

  await writeFile(resolve(assignmentDir, 'assignment.md'), `---
id: assignment-1
slug: test-assignment
title: Test Assignment
status: pending
priority: medium
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
assignee: codex-1
externalIds: []
dependsOn: []
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# Test Assignment`, 'utf-8');

  await writeFile(resolve(assignmentDir, 'plan.md'), `---
assignment: test-assignment
status: draft
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
---

# Plan`, 'utf-8');

  await writeFile(resolve(assignmentDir, 'scratchpad.md'), `---
assignment: test-assignment
updated: "2026-03-20T10:00:00Z"
---

# Scratchpad`, 'utf-8');

  await writeFile(resolve(assignmentDir, 'handoff.md'), `---
assignment: test-assignment
updated: "2026-03-20T10:00:00Z"
handoffCount: 1
---

# Handoff Log

## Handoff 1

Initial handoff`, 'utf-8');

  await writeFile(resolve(assignmentDir, 'decision-record.md'), `---
assignment: test-assignment
updated: "2026-03-20T10:00:00Z"
decisionCount: 1
---

# Decision Record

## Decision 1

Keep the current layout`, 'utf-8');
}

describe('dashboard write router', () => {
  it('rejects project slug changes', async () => {
    await createAssignmentFixture();
    const router = createWriteRouter(testDir);

    const response = await invokeRoute(
      router,
      'patch',
      '/api/projects/:slug',
      { slug: 'test-project' },
      {
        content: `---
id: project-1
slug: renamed-project
title: Test Project
archived: false
archivedAt: null
archivedReason: null
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
tags: []
---

# Test Project`,
      },
    );

    expect(response.statusCode).toBe(400);
    expect(response.payload).toEqual({
      error: 'Project slug cannot be changed once created.',
    });
  });

  it('allows direct assignment status edits via PATCH', async () => {
    await createAssignmentFixture();
    const router = createWriteRouter(testDir);

    const response = await invokeRoute(
      router,
      'patch',
      '/api/projects/:slug/assignments/:aslug',
      { slug: 'test-project', aslug: 'test-assignment' },
      {
        content: `---
id: assignment-1
slug: test-assignment
title: Test Assignment
status: completed
priority: medium
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
assignee: codex-1
externalIds: []
dependsOn: []
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# Test Assignment`,
      },
    );

    expect(response.statusCode).toBe(200);
    expect((response.payload as any).assignment.status).toBe('completed');
  });

  it('toggles acceptance criteria and refreshes the assignment timestamp', async () => {
    await createAssignmentFixture();
    const assignmentPath = resolve(
      testDir,
      'test-project',
      'assignments',
      'test-assignment',
      'assignment.md',
    );

    await writeFile(assignmentPath, `---
id: assignment-1
slug: test-assignment
title: Test Assignment
status: pending
priority: medium
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
assignee: codex-1
externalIds: []
dependsOn: []
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# Test Assignment

## Acceptance Criteria

- [ ] First criterion
- [x] Second criterion

## Context

Keep this paragraph.`, 'utf-8');

    const router = createWriteRouter(testDir);
    const response = await invokeRoute(
      router,
      'patch',
      '/api/projects/:slug/assignments/:aslug/acceptance-criteria/:index',
      { slug: 'test-project', aslug: 'test-assignment', index: '0' },
      { checked: true },
    );

    expect(response.statusCode).toBe(200);
    expect((response.payload as any).content).toContain('- [x] First criterion');
    expect((response.payload as any).content).toContain('updated:');

    const fileContent = await readFile(assignmentPath, 'utf-8');
    expect(fileContent).toContain('- [x] First criterion');
    expect(fileContent).toContain('Keep this paragraph.');
    expect(fileContent).not.toContain('updated: "2026-03-20T10:00:00Z"');
  });

  it('appends handoff entries without rewriting prior history', async () => {
    await createAssignmentFixture();
    const router = createWriteRouter(testDir);

    const response = await invokeRoute(
      router,
      'post',
      '/api/projects/:slug/assignments/:aslug/handoff/entries',
      { slug: 'test-project', aslug: 'test-assignment' },
      {
        title: 'Handoff 2',
        body: 'Second handoff entry',
      },
    );

    expect(response.statusCode).toBe(201);
    expect((response.payload as any).assignment.handoff.handoffCount).toBe(2);
    expect((response.payload as any).content).toContain('Initial handoff');
    expect((response.payload as any).content).toContain('Second handoff entry');

    const fileContent = await readFile(
      resolve(testDir, 'test-project', 'assignments', 'test-assignment', 'handoff.md'),
      'utf-8',
    );
    expect(fileContent).toContain('Initial handoff');
    expect(fileContent).toContain('Second handoff entry');
  });

  it('allows blocking without a reason and uses lifecycle transitions for status changes', async () => {
    await createAssignmentFixture();
    const router = createWriteRouter(testDir);

    // Block without reason succeeds (from pending, which allows block)
    const blockedWithoutReason = await invokeRoute(
      router,
      'post',
      '/api/projects/:slug/assignments/:aslug/transitions/:command',
      { slug: 'test-project', aslug: 'test-assignment', command: 'block' },
      {},
    );

    expect(blockedWithoutReason.statusCode).toBe(200);
    expect((blockedWithoutReason.payload as any).assignment.status).toBe('blocked');
    expect((blockedWithoutReason.payload as any).assignment.blockedReason).toBeNull();

    // Unblock (blocked -> in_progress)
    const unblocked = await invokeRoute(
      router,
      'post',
      '/api/projects/:slug/assignments/:aslug/transitions/:command',
      { slug: 'test-project', aslug: 'test-assignment', command: 'unblock' },
      {},
    );
    expect(unblocked.statusCode).toBe(200);
    expect((unblocked.payload as any).assignment.status).toBe('in_progress');

    // Block with a reason
    const blocked = await invokeRoute(
      router,
      'post',
      '/api/projects/:slug/assignments/:aslug/transitions/:command',
      { slug: 'test-project', aslug: 'test-assignment', command: 'block' },
      { reason: 'Waiting on design review' },
    );
    expect(blocked.statusCode).toBe(200);
    expect((blocked.payload as any).assignment.status).toBe('blocked');
    expect((blocked.payload as any).assignment.blockedReason).toBe('Waiting on design review');
  });
});
