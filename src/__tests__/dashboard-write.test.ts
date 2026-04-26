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
  method: 'patch' | 'post' | 'get',
  path: string,
  params: Record<string, string>,
  body: unknown,
  query: Record<string, string> = {},
): Promise<MockResponse> {
  const handler = getRouteHandler(router, method, path);
  const response = createMockResponse();

  await handler(
    {
      params,
      body,
      query,
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

  it('POST /api/projects/:slug/assignments/:aslug/comments appends a comment', async () => {
    await createAssignmentFixture();
    const router = createWriteRouter(testDir);

    const response = await invokeRoute(
      router,
      'post',
      '/api/projects/:slug/assignments/:aslug/comments',
      { slug: 'test-project', aslug: 'test-assignment' },
      { body: 'Is the migration reversible?', type: 'question', author: 'alice' },
    );

    expect(response.statusCode).toBe(201);
    const commentsPath = resolve(
      testDir,
      'test-project',
      'assignments',
      'test-assignment',
      'comments.md',
    );
    const content = await readFile(commentsPath, 'utf-8');
    expect(content).toContain('**Type:** question');
    expect(content).toContain('**Author:** alice');
    expect(content).toContain('**Resolved:** false');
    expect(content).toContain('Is the migration reversible?');
    expect(content).toContain('entryCount: 1');
  });

  it('PATCH comments/:commentId/resolved toggles the resolved flag on a question', async () => {
    await createAssignmentFixture();
    const router = createWriteRouter(testDir);

    const add = await invokeRoute(
      router,
      'post',
      '/api/projects/:slug/assignments/:aslug/comments',
      { slug: 'test-project', aslug: 'test-assignment' },
      { body: 'Q?', type: 'question', author: 'a' },
    );
    expect(add.statusCode).toBe(201);
    const commentId = (add.payload as any).comment.id as string;

    const toggle = await invokeRoute(
      router,
      'patch',
      '/api/projects/:slug/assignments/:aslug/comments/:commentId/resolved',
      { slug: 'test-project', aslug: 'test-assignment', commentId },
      { resolved: true },
    );
    expect(toggle.statusCode).toBe(200);

    const commentsPath = resolve(
      testDir,
      'test-project',
      'assignments',
      'test-assignment',
      'comments.md',
    );
    const content = await readFile(commentsPath, 'utf-8');
    expect(content).toMatch(/^## [a-z0-9]+\n\n[\s\S]*\*\*Resolved:\*\* true/m);
  });

  it('POST /api/assignments creates a standalone assignment at <assignmentsDir>/<uuid>/', async () => {
    const assignmentsDir = resolve(testDir, 'standalone');
    await mkdir(assignmentsDir, { recursive: true });
    const router = createWriteRouter(testDir, assignmentsDir);

    const response = await invokeRoute(
      router,
      'post',
      '/api/assignments',
      {},
      { title: 'Standalone one-off', priority: 'high' },
    );

    expect(response.statusCode).toBe(201);
    const payload = response.payload as any;
    expect(payload.assignment.projectSlug).toBeNull();
    expect(payload.assignment.title).toBe('Standalone one-off');
    expect(payload.assignment.slug).toBe('standalone-one-off');
    expect(payload.assignment.priority).toBe('high');
    expect(payload.assignment.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects standalone create with dependsOn', async () => {
    const assignmentsDir = resolve(testDir, 'standalone');
    await mkdir(assignmentsDir, { recursive: true });
    const router = createWriteRouter(testDir, assignmentsDir);

    const response = await invokeRoute(
      router,
      'post',
      '/api/assignments',
      {},
      { title: 'nope', dependsOn: ['something'] },
    );
    expect(response.statusCode).toBe(400);
    expect((response.payload as any).error).toContain('dependsOn');
  });

  it('POST /api/assignments/:id/comments appends for a standalone assignment', async () => {
    const assignmentsDir = resolve(testDir, 'standalone');
    await mkdir(assignmentsDir, { recursive: true });
    const router = createWriteRouter(testDir, assignmentsDir);

    const create = await invokeRoute(
      router,
      'post',
      '/api/assignments',
      {},
      { title: 'Task' },
    );
    const id = (create.payload as any).assignment.id as string;

    const comment = await invokeRoute(
      router,
      'post',
      '/api/assignments/:id/comments',
      { id },
      { body: 'Why?', type: 'question', author: 'alice' },
    );
    expect(comment.statusCode).toBe(201);

    const content = await readFile(
      resolve(assignmentsDir, id, 'comments.md'),
      'utf-8',
    );
    expect(content).toContain('**Type:** question');
    expect(content).toContain('**Author:** alice');
    expect(content).toContain('Why?');
  });

  it('POST /api/assignments/:id/transitions/start moves standalone pending → in_progress', async () => {
    const assignmentsDir = resolve(testDir, 'standalone');
    await mkdir(assignmentsDir, { recursive: true });
    const router = createWriteRouter(testDir, assignmentsDir);

    const create = await invokeRoute(
      router,
      'post',
      '/api/assignments',
      {},
      { title: 'Task' },
    );
    const id = (create.payload as any).assignment.id as string;

    const start = await invokeRoute(
      router,
      'post',
      '/api/assignments/:id/transitions/:command',
      { id, command: 'start' },
      {},
    );
    expect(start.statusCode).toBe(200);
    expect((start.payload as any).assignment.status).toBe('in_progress');
  });

  it('GET /api/assignments is routable only when router constructed with assignmentsDir', async () => {
    // Without assignmentsDir the POST /api/assignments route returns 501.
    const router = createWriteRouter(testDir);
    const response = await invokeRoute(
      router,
      'post',
      '/api/assignments',
      {},
      { title: 'Task' },
    );
    expect(response.statusCode).toBe(501);
  });

  it('POST /api/assignments accepts {content} markdown form and writes workspaceGroup', async () => {
    const assignmentsDir = resolve(testDir, 'standalone');
    await mkdir(assignmentsDir, { recursive: true });
    const router = createWriteRouter(testDir, assignmentsDir);

    const content = `---
id: placeholder-id
slug: ui-created
title: UI Created Standalone
project: null
workspaceGroup: syntaur
status: pending
priority: medium
created: "2026-04-25T12:00:00Z"
updated: "2026-04-25T12:00:00Z"
---

# UI Created Standalone
`;

    const response = await invokeRoute(
      router,
      'post',
      '/api/assignments',
      {},
      { content },
    );

    expect(response.statusCode).toBe(201);
    const id = (response.payload as any).assignment.id as string;
    const onDisk = await readFile(resolve(assignmentsDir, id, 'assignment.md'), 'utf-8');
    expect(onDisk).toContain('workspaceGroup: syntaur');
    expect(onDisk).toContain('project: null');
    expect(onDisk).toContain(`id: ${id}`);
    expect(onDisk).not.toContain('id: placeholder-id');
  });

  it('POST /api/assignments {content} omits workspaceGroup when not in frontmatter', async () => {
    const assignmentsDir = resolve(testDir, 'standalone');
    await mkdir(assignmentsDir, { recursive: true });
    const router = createWriteRouter(testDir, assignmentsDir);

    const content = `---
id: placeholder-id
slug: plain-standalone
title: Plain Standalone
project: null
status: pending
priority: medium
created: "2026-04-25T12:00:00Z"
updated: "2026-04-25T12:00:00Z"
---

# Plain Standalone
`;

    const response = await invokeRoute(router, 'post', '/api/assignments', {}, { content });
    expect(response.statusCode).toBe(201);
    const id = (response.payload as any).assignment.id as string;
    const onDisk = await readFile(resolve(assignmentsDir, id, 'assignment.md'), 'utf-8');
    expect(onDisk).not.toContain('workspaceGroup:');
  });

  it('POST /api/assignments {content} rejects invalid workspaceGroup slug', async () => {
    const assignmentsDir = resolve(testDir, 'standalone');
    await mkdir(assignmentsDir, { recursive: true });
    const router = createWriteRouter(testDir, assignmentsDir);

    const content = `---
id: placeholder
slug: bad-ws
title: Bad
project: null
workspaceGroup: INVALID!
status: pending
priority: medium
created: "2026-04-25T12:00:00Z"
updated: "2026-04-25T12:00:00Z"
---

# Bad
`;

    const response = await invokeRoute(router, 'post', '/api/assignments', {}, { content });
    expect(response.statusCode).toBe(400);
    expect((response.payload as any).error).toContain('Invalid workspace slug');
  });

  it('POST /api/assignments {content} rejects when project is set alongside workspaceGroup', async () => {
    const assignmentsDir = resolve(testDir, 'standalone');
    await mkdir(assignmentsDir, { recursive: true });
    const router = createWriteRouter(testDir, assignmentsDir);

    const content = `---
id: placeholder
slug: bad-combo
title: Bad
project: some-project
workspaceGroup: syntaur
status: pending
priority: medium
created: "2026-04-25T12:00:00Z"
updated: "2026-04-25T12:00:00Z"
---

# Bad
`;

    const response = await invokeRoute(router, 'post', '/api/assignments', {}, { content });
    expect(response.statusCode).toBe(400);
    expect((response.payload as any).error).toContain('Standalone assignments cannot have a project');
  });

  it('POST /api/assignments structured form still works (back-compat)', async () => {
    const assignmentsDir = resolve(testDir, 'standalone');
    await mkdir(assignmentsDir, { recursive: true });
    const router = createWriteRouter(testDir, assignmentsDir);

    const response = await invokeRoute(
      router,
      'post',
      '/api/assignments',
      {},
      { title: 'Programmatic create' },
    );
    expect(response.statusCode).toBe(201);
    expect((response.payload as any).assignment.title).toBe('Programmatic create');
  });

  it('GET /api/templates/assignment?standalone=1 returns project: null with no workspaceGroup', async () => {
    const router = createWriteRouter(testDir);
    const response = await invokeRoute(router, 'get', '/api/templates/assignment', {}, undefined, {
      standalone: '1',
    });
    expect(response.statusCode).toBe(200);
    const content = (response.payload as any).content as string;
    expect(content).toContain('project: null');
    expect(content).not.toContain('workspaceGroup:');
  });

  it('GET /api/templates/assignment?standalone=1&workspace=syntaur pre-fills workspaceGroup', async () => {
    const router = createWriteRouter(testDir);
    const response = await invokeRoute(router, 'get', '/api/templates/assignment', {}, undefined, {
      standalone: '1',
      workspace: 'syntaur',
    });
    expect(response.statusCode).toBe(200);
    const content = (response.payload as any).content as string;
    expect(content).toContain('project: null');
    expect(content).toContain('workspaceGroup: syntaur');
  });

  it('GET /api/templates/assignment rejects an invalid workspace slug', async () => {
    const router = createWriteRouter(testDir);
    const response = await invokeRoute(router, 'get', '/api/templates/assignment', {}, undefined, {
      standalone: '1',
      workspace: 'INVALID!',
    });
    expect(response.statusCode).toBe(400);
    expect((response.payload as any).error).toContain('Invalid workspace slug');
  });

  it('rejects resolve toggle for a non-question comment', async () => {
    await createAssignmentFixture();
    const router = createWriteRouter(testDir);

    const add = await invokeRoute(
      router,
      'post',
      '/api/projects/:slug/assignments/:aslug/comments',
      { slug: 'test-project', aslug: 'test-assignment' },
      { body: 'note body', type: 'note', author: 'a' },
    );
    const commentId = (add.payload as any).comment.id as string;

    const toggle = await invokeRoute(
      router,
      'patch',
      '/api/projects/:slug/assignments/:aslug/comments/:commentId/resolved',
      { slug: 'test-project', aslug: 'test-assignment', commentId },
      { resolved: true },
    );
    expect(toggle.statusCode).toBe(400);
    expect((toggle.payload as any).error).toContain('Only questions');
  });
});
