import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { RequestHandler, Router } from 'express';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createWriteRouter, worktreeInFlight } from '../dashboard/api-write.js';

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

  describe('POST /api/assignments/:id/move-workspace', () => {
    async function setupStandalone(workspaceGroup?: string | null): Promise<{
      router: Router;
      id: string;
      assignmentsDir: string;
    }> {
      const assignmentsDir = resolve(testDir, 'standalone');
      await mkdir(assignmentsDir, { recursive: true });
      const router = createWriteRouter(testDir, assignmentsDir);
      const create = await invokeRoute(
        router,
        'post',
        '/api/assignments',
        {},
        {
          title: 'Mover',
          ...(workspaceGroup !== undefined ? { workspaceGroup } : {}),
        },
      );
      const id = (create.payload as any).assignment.id as string;
      return { router, id, assignmentsDir };
    }

    it('sets workspaceGroup on a standalone assignment', async () => {
      const { router, id, assignmentsDir } = await setupStandalone();
      const res = await invokeRoute(
        router,
        'post',
        '/api/assignments/:id/move-workspace',
        { id },
        { workspaceGroup: 'alpha-ws' },
      );
      expect(res.statusCode).toBe(200);
      const content = await readFile(resolve(assignmentsDir, id, 'assignment.md'), 'utf-8');
      expect(content).toContain('workspaceGroup: alpha-ws');
    });

    it('clears workspaceGroup to null (Ungrouped target)', async () => {
      const { router, id, assignmentsDir } = await setupStandalone('beta-ws');
      const res = await invokeRoute(
        router,
        'post',
        '/api/assignments/:id/move-workspace',
        { id },
        { workspaceGroup: null },
      );
      expect(res.statusCode).toBe(200);
      const content = await readFile(resolve(assignmentsDir, id, 'assignment.md'), 'utf-8');
      expect(content).toContain('workspaceGroup: null');
    });

    it('rejects project-nested assignments with 400', async () => {
      await createAssignmentFixture();
      const assignmentsDir = resolve(testDir, 'standalone');
      await mkdir(assignmentsDir, { recursive: true });
      const router = createWriteRouter(testDir, assignmentsDir);
      // The project-nested fixture uses id `assignment-1` (see createAssignmentFixture).
      const res = await invokeRoute(
        router,
        'post',
        '/api/assignments/:id/move-workspace',
        { id: 'assignment-1' },
        { workspaceGroup: 'alpha' },
      );
      expect(res.statusCode).toBe(400);
      expect((res.payload as any).error).toMatch(/inherit workspace from their parent project/);
    });

    it('returns 404 for unknown id', async () => {
      const assignmentsDir = resolve(testDir, 'standalone');
      await mkdir(assignmentsDir, { recursive: true });
      const router = createWriteRouter(testDir, assignmentsDir);
      const res = await invokeRoute(
        router,
        'post',
        '/api/assignments/:id/move-workspace',
        { id: 'ghost-id' },
        { workspaceGroup: 'foo' },
      );
      expect(res.statusCode).toBe(404);
    });

    it('returns 501 when assignmentsDir is not configured', async () => {
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'post',
        '/api/assignments/:id/move-workspace',
        { id: 'anything' },
        { workspaceGroup: 'foo' },
      );
      expect(res.statusCode).toBe(501);
    });

    it('rejects invalid workspaceGroup body (empty string)', async () => {
      const { router, id } = await setupStandalone();
      const res = await invokeRoute(
        router,
        'post',
        '/api/assignments/:id/move-workspace',
        { id },
        { workspaceGroup: '   ' },
      );
      expect(res.statusCode).toBe(400);
    });

    it('rejects workspaceGroup containing YAML metacharacters (frontmatter-injection guard)', async () => {
      const { router, id, assignmentsDir } = await setupStandalone();
      // Newline-bearing value would otherwise be emitted verbatim by formatYamlValue
      // and inject `status: completed` as a separate frontmatter field.
      const injection = 'alpha\nstatus: completed';
      const res = await invokeRoute(
        router,
        'post',
        '/api/assignments/:id/move-workspace',
        { id },
        { workspaceGroup: injection },
      );
      expect(res.statusCode).toBe(400);
      const content = await readFile(resolve(assignmentsDir, id, 'assignment.md'), 'utf-8');
      expect(content).not.toMatch(/^status:\s*completed$/m);
    });
  });

  describe('POST /api/projects/:slug/move-workspace input validation', () => {
    it('rejects workspace containing YAML metacharacters (frontmatter-injection guard)', async () => {
      await createAssignmentFixture();
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'post',
        '/api/projects/:slug/move-workspace',
        { slug: 'test-project' },
        { workspace: 'foo\nstatus: archived' },
      );
      expect(res.statusCode).toBe(400);
      const content = await readFile(resolve(testDir, 'test-project', 'project.md'), 'utf-8');
      expect(content).not.toMatch(/^status:\s*archived$/m);
    });

    it('rejects workspace with uppercase or special chars', async () => {
      await createAssignmentFixture();
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'post',
        '/api/projects/:slug/move-workspace',
        { slug: 'test-project' },
        { workspace: 'Bad Slug!' },
      );
      expect(res.statusCode).toBe(400);
    });

    it('accepts a valid slug', async () => {
      await createAssignmentFixture();
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'post',
        '/api/projects/:slug/move-workspace',
        { slug: 'test-project' },
        { workspace: 'syntaur' },
      );
      expect(res.statusCode).toBe(200);
      const content = await readFile(resolve(testDir, 'test-project', 'project.md'), 'utf-8');
      expect(content).toMatch(/^workspace: syntaur$/m);
    });
  });

  describe('PATCH /api/projects/:slug/assignments/:aslug/assignee', () => {
    it('updates assignee frontmatter without rewriting body', async () => {
      await createAssignmentFixture();
      const router = createWriteRouter(testDir);
      const assignmentPath = resolve(testDir, 'test-project', 'assignments', 'test-assignment', 'assignment.md');
      const bodyBefore = (await readFile(assignmentPath, 'utf-8')).split(/^---$/m)[2];

      const res = await invokeRoute(
        router,
        'patch',
        '/api/projects/:slug/assignments/:aslug/assignee',
        { slug: 'test-project', aslug: 'test-assignment' },
        { assignee: 'claude' },
      );
      expect(res.statusCode).toBe(200);

      const after = await readFile(assignmentPath, 'utf-8');
      expect(after).toMatch(/^assignee: claude$/m);
      // Body untouched.
      expect(after.split(/^---$/m)[2]).toBe(bodyBefore);
    });

    it('accepts null to clear the assignee', async () => {
      await createAssignmentFixture();
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'patch',
        '/api/projects/:slug/assignments/:aslug/assignee',
        { slug: 'test-project', aslug: 'test-assignment' },
        { assignee: null },
      );
      expect(res.statusCode).toBe(200);
      const content = await readFile(
        resolve(testDir, 'test-project', 'assignments', 'test-assignment', 'assignment.md'),
        'utf-8',
      );
      expect(content).toMatch(/^assignee: null$/m);
    });

    it('rejects non-string non-null assignee', async () => {
      await createAssignmentFixture();
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'patch',
        '/api/projects/:slug/assignments/:aslug/assignee',
        { slug: 'test-project', aslug: 'test-assignment' },
        { assignee: 42 },
      );
      expect(res.statusCode).toBe(400);
    });

    it('rejects assignee longer than 120 chars', async () => {
      await createAssignmentFixture();
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'patch',
        '/api/projects/:slug/assignments/:aslug/assignee',
        { slug: 'test-project', aslug: 'test-assignment' },
        { assignee: 'a'.repeat(200) },
      );
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 for missing assignment', async () => {
      await createAssignmentFixture();
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'patch',
        '/api/projects/:slug/assignments/:aslug/assignee',
        { slug: 'test-project', aslug: 'ghost' },
        { assignee: 'claude' },
      );
      expect(res.statusCode).toBe(404);
    });
  });

  describe('PATCH /api/projects/:slug/assignments/:aslug/title', () => {
    const assignmentPath = (): string =>
      resolve(testDir, 'test-project', 'assignments', 'test-assignment', 'assignment.md');

    it('updates title frontmatter without rewriting body', async () => {
      await createAssignmentFixture();
      const router = createWriteRouter(testDir);
      const bodyBefore = (await readFile(assignmentPath(), 'utf-8')).split(/^---$/m)[2];

      const res = await invokeRoute(
        router,
        'patch',
        '/api/projects/:slug/assignments/:aslug/title',
        { slug: 'test-project', aslug: 'test-assignment' },
        { title: 'Renamed assignment' },
      );
      expect(res.statusCode).toBe(200);

      const after = await readFile(assignmentPath(), 'utf-8');
      expect(after).toMatch(/^title: Renamed assignment$/m);
      expect(after.split(/^---$/m)[2]).toBe(bodyBefore);
    });

    it('quotes titles containing YAML metacharacters (colon) so they round-trip', async () => {
      await createAssignmentFixture();
      const router = createWriteRouter(testDir);

      const res = await invokeRoute(
        router,
        'patch',
        '/api/projects/:slug/assignments/:aslug/title',
        { slug: 'test-project', aslug: 'test-assignment' },
        { title: 'feat: do the thing' },
      );
      expect(res.statusCode).toBe(200);

      const after = await readFile(assignmentPath(), 'utf-8');
      // formatYamlValue must quote titles containing `:` to avoid YAML ambiguity.
      expect(after).toMatch(/^title: "feat: do the thing"$/m);
    });

    it('bumps updated when the title changes', async () => {
      await createAssignmentFixture();
      const router = createWriteRouter(testDir);
      const before = await readFile(assignmentPath(), 'utf-8');

      const res = await invokeRoute(
        router,
        'patch',
        '/api/projects/:slug/assignments/:aslug/title',
        { slug: 'test-project', aslug: 'test-assignment' },
        { title: 'Bumped' },
      );
      expect(res.statusCode).toBe(200);

      const after = await readFile(assignmentPath(), 'utf-8');
      const bumpedMatch = after.match(/^updated: "(.+)"$/m);
      const originalMatch = before.match(/^updated: "(.+)"$/m);
      expect(bumpedMatch).not.toBeNull();
      expect(originalMatch).not.toBeNull();
      expect(bumpedMatch![1]).not.toEqual(originalMatch![1]);
    });

    it('rejects empty title', async () => {
      await createAssignmentFixture();
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'patch',
        '/api/projects/:slug/assignments/:aslug/title',
        { slug: 'test-project', aslug: 'test-assignment' },
        { title: '' },
      );
      expect(res.statusCode).toBe(400);
    });

    it('rejects whitespace-only title', async () => {
      await createAssignmentFixture();
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'patch',
        '/api/projects/:slug/assignments/:aslug/title',
        { slug: 'test-project', aslug: 'test-assignment' },
        { title: '   \t  ' },
      );
      expect(res.statusCode).toBe(400);
    });

    it('rejects title longer than 200 chars', async () => {
      await createAssignmentFixture();
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'patch',
        '/api/projects/:slug/assignments/:aslug/title',
        { slug: 'test-project', aslug: 'test-assignment' },
        { title: 'a'.repeat(201) },
      );
      expect(res.statusCode).toBe(400);
    });

    it('rejects non-string title', async () => {
      await createAssignmentFixture();
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'patch',
        '/api/projects/:slug/assignments/:aslug/title',
        { slug: 'test-project', aslug: 'test-assignment' },
        { title: 42 },
      );
      expect(res.statusCode).toBe(400);
    });

    it('rejects title containing a double quote', async () => {
      await createAssignmentFixture();
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'patch',
        '/api/projects/:slug/assignments/:aslug/title',
        { slug: 'test-project', aslug: 'test-assignment' },
        { title: 'has "quote"' },
      );
      expect(res.statusCode).toBe(400);
    });

    it('rejects title containing a newline', async () => {
      await createAssignmentFixture();
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'patch',
        '/api/projects/:slug/assignments/:aslug/title',
        { slug: 'test-project', aslug: 'test-assignment' },
        { title: 'line one\nline two' },
      );
      expect(res.statusCode).toBe(400);
    });

    it('rejects title containing a carriage return', async () => {
      await createAssignmentFixture();
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'patch',
        '/api/projects/:slug/assignments/:aslug/title',
        { slug: 'test-project', aslug: 'test-assignment' },
        { title: 'line one\rline two' },
      );
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 for missing assignment', async () => {
      await createAssignmentFixture();
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'patch',
        '/api/projects/:slug/assignments/:aslug/title',
        { slug: 'test-project', aslug: 'ghost' },
        { title: 'whatever' },
      );
      expect(res.statusCode).toBe(404);
    });

    it('PATCH /api/assignments/:id/title updates a standalone assignment', async () => {
      const assignmentsDir = resolve(testDir, 'standalone');
      await mkdir(assignmentsDir, { recursive: true });
      const router = createWriteRouter(testDir, assignmentsDir);

      const create = await invokeRoute(
        router,
        'post',
        '/api/assignments',
        {},
        { title: 'Original' },
      );
      const id = (create.payload as any).assignment.id as string;

      const res = await invokeRoute(
        router,
        'patch',
        '/api/assignments/:id/title',
        { id },
        { title: 'Renamed standalone' },
      );
      expect(res.statusCode).toBe(200);

      const content = await readFile(resolve(assignmentsDir, id, 'assignment.md'), 'utf-8');
      expect(content).toMatch(/^title: Renamed standalone$/m);
    });

    it('PATCH /api/assignments/:id/title returns 404 for missing id', async () => {
      const assignmentsDir = resolve(testDir, 'standalone');
      await mkdir(assignmentsDir, { recursive: true });
      const router = createWriteRouter(testDir, assignmentsDir);

      const res = await invokeRoute(
        router,
        'patch',
        '/api/assignments/:id/title',
        { id: '00000000-0000-0000-0000-000000000000' },
        { title: 'whatever' },
      );
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/assignments/bulk-status-override', () => {
    it('flips two project-scoped assignments to the requested status', async () => {
      await createAssignmentFixture();
      // Add a second assignment to test bulk semantics.
      const second = resolve(testDir, 'test-project', 'assignments', 'second-assignment');
      await mkdir(second, { recursive: true });
      await writeFile(
        resolve(second, 'assignment.md'),
        `---\nid: assignment-2\nslug: second-assignment\ntitle: Second\nstatus: pending\npriority: medium\ncreated: "2026-03-20T10:00:00Z"\nupdated: "2026-03-20T10:00:00Z"\nassignee: null\nexternalIds: []\ndependsOn: []\nblockedReason: null\nworkspace:\n  repository: null\n  worktreePath: null\n  branch: null\n  parentBranch: null\ntags: []\n---\n\n# Second`,
        'utf-8',
      );

      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'post',
        '/api/assignments/bulk-status-override',
        {},
        {
          items: [
            { projectSlug: 'test-project', assignmentSlug: 'test-assignment', status: 'failed' },
            { projectSlug: 'test-project', assignmentSlug: 'second-assignment', status: 'failed' },
          ],
        },
      );
      expect(res.statusCode).toBe(200);
      const payload = res.payload as { results: Array<{ ok: boolean }>; succeeded: number; failed: number };
      expect(payload.succeeded).toBe(2);
      expect(payload.failed).toBe(0);
      expect(payload.results.every((r) => r.ok)).toBe(true);
    });

    it('returns partial-failure results with 200 status when one item is invalid', async () => {
      await createAssignmentFixture();
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'post',
        '/api/assignments/bulk-status-override',
        {},
        {
          items: [
            { projectSlug: 'test-project', assignmentSlug: 'test-assignment', status: 'failed' },
            { projectSlug: 'test-project', assignmentSlug: 'ghost-assignment', status: 'failed' },
          ],
        },
      );
      expect(res.statusCode).toBe(200);
      const payload = res.payload as { results: Array<{ ok: boolean; error?: string }>; succeeded: number; failed: number };
      expect(payload.succeeded).toBe(1);
      expect(payload.failed).toBe(1);
      expect(payload.results[0].ok).toBe(true);
      expect(payload.results[1].ok).toBe(false);
      expect(payload.results[1].error).toMatch(/not found/);
    });

    it('returns 400 for malformed body (missing items)', async () => {
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'post',
        '/api/assignments/bulk-status-override',
        {},
        { foo: 'bar' },
      );
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for an empty items array', async () => {
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'post',
        '/api/assignments/bulk-status-override',
        {},
        { items: [] },
      );
      expect(res.statusCode).toBe(400);
    });
  });

  // --- Worktree creation + candidate discovery ---
  describe('worktree endpoints', () => {
    function initGitRepo(repoPath: string): void {
      const run = (args: string[]) => {
        const r = spawnSync('git', args, { cwd: repoPath, encoding: 'utf-8' });
        if (r.status !== 0) {
          throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
        }
      };
      run(['init', '-q', '-b', 'main']);
      run(['config', 'user.email', 'test@example.com']);
      run(['config', 'user.name', 'Test']);
      run(['commit', '--allow-empty', '-m', 'init', '--quiet']);
    }

    async function setupRepo(): Promise<string> {
      const repo = resolve(testDir, 'git-repo');
      await mkdir(repo, { recursive: true });
      initGitRepo(repo);
      return repo;
    }

    describe('GET /api/projects/:slug/repository-candidates', () => {
      it('returns project-configured + sibling-harvested deduped, project first', async () => {
        await createAssignmentFixture();
        // Add a `repositories:` block to project.md and a sibling assignment
        // with workspace.repository populated.
        await writeFile(
          resolve(testDir, 'test-project', 'project.md'),
          `---
id: project-1
slug: test-project
title: Test Project
archived: false
archivedAt: null
archivedReason: null
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
tags: []
repositories:
  - /repo/a
  - /repo/b
---

# Test Project`,
          'utf-8',
        );
        const siblingDir = resolve(testDir, 'test-project', 'assignments', 'sibling-with-repo');
        await mkdir(siblingDir, { recursive: true });
        await writeFile(
          resolve(siblingDir, 'assignment.md'),
          `---
id: sibling-1
slug: sibling-with-repo
title: Sibling
status: in_progress
priority: medium
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
externalIds: []
dependsOn: []
blockedReason: null
workspace:
  repository: /repo/c
  worktreePath: /repo/c/.worktrees/foo
  branch: foo
  parentBranch: main
tags: []
---

# Sibling`,
          'utf-8',
        );
        // Sibling with a duplicate of /repo/a — must be deduped.
        const dupDir = resolve(testDir, 'test-project', 'assignments', 'sibling-dup');
        await mkdir(dupDir, { recursive: true });
        await writeFile(
          resolve(dupDir, 'assignment.md'),
          `---
id: sibling-2
slug: sibling-dup
title: Sibling Dup
status: in_progress
priority: medium
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
externalIds: []
dependsOn: []
blockedReason: null
workspace:
  repository: /repo/a
  worktreePath: /repo/a/.worktrees/bar
  branch: bar
  parentBranch: main
tags: []
---

# Sibling Dup`,
          'utf-8',
        );

        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'get',
          '/api/projects/:slug/repository-candidates',
          { slug: 'test-project' },
          undefined,
        );
        expect(res.statusCode).toBe(200);
        const payload = res.payload as { candidates: Array<{ path: string; source: string }> };
        expect(payload.candidates).toEqual([
          { path: '/repo/a', source: 'project', sourceAssignmentSlug: null },
          { path: '/repo/b', source: 'project', sourceAssignmentSlug: null },
          { path: '/repo/c', source: 'sibling', sourceAssignmentSlug: 'sibling-with-repo' },
        ]);
      });

      it('returns [] for an empty project (no repositories, no siblings)', async () => {
        await createAssignmentFixture();
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'get',
          '/api/projects/:slug/repository-candidates',
          { slug: 'test-project' },
          undefined,
        );
        expect(res.statusCode).toBe(200);
        expect(res.payload).toEqual({ candidates: [] });
      });

      it('returns 404 for an unknown project', async () => {
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'get',
          '/api/projects/:slug/repository-candidates',
          { slug: 'nope' },
          undefined,
        );
        expect(res.statusCode).toBe(404);
      });
    });

    describe('GET /api/assignments/:id/repository-candidates (standalone)', () => {
      it('returns 501 when standalone assignments are not configured', async () => {
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'get',
          '/api/assignments/:id/repository-candidates',
          { id: 'anything' },
          undefined,
        );
        expect(res.statusCode).toBe(501);
      });

      it('harvests sibling standalone assignments, excluding the requesting id', async () => {
        const assignmentsDir = resolve(testDir, 'standalone');
        await mkdir(assignmentsDir, { recursive: true });
        const writeStandalone = async (id: string, slug: string, repo: string | null) => {
          const dir = resolve(assignmentsDir, id);
          await mkdir(dir, { recursive: true });
          await writeFile(
            resolve(dir, 'assignment.md'),
            `---
id: ${id}
slug: ${slug}
title: ${slug}
status: in_progress
priority: medium
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
externalIds: []
dependsOn: []
blockedReason: null
workspace:
  repository: ${repo ?? 'null'}
  worktreePath: ${repo ? `${repo}/.worktrees/foo` : 'null'}
  branch: ${repo ? 'foo' : 'null'}
  parentBranch: ${repo ? 'main' : 'null'}
tags: []
---

# ${slug}`,
            'utf-8',
          );
        };
        await writeStandalone('uuid-self', 'self', null);
        await writeStandalone('uuid-other', 'other-one', '/repo/x');
        await writeStandalone('uuid-third', 'third-one', '/repo/y');

        const router = createWriteRouter(testDir, assignmentsDir);
        const res = await invokeRoute(
          router,
          'get',
          '/api/assignments/:id/repository-candidates',
          { id: 'uuid-self' },
          undefined,
        );
        expect(res.statusCode).toBe(200);
        const payload = res.payload as { candidates: Array<{ path: string }> };
        const paths = payload.candidates.map((c) => c.path).sort();
        expect(paths).toEqual(['/repo/x', '/repo/y']);
      });
    });

    // --- Redesign: branch listing, source assignments, validation, lock ---

    async function writeProjectAssignment(
      slug: string,
      opts: { id?: string; repository?: string; branch?: string },
    ): Promise<void> {
      const dir = resolve(testDir, 'test-project', 'assignments', slug);
      await mkdir(dir, { recursive: true });
      const repo = opts.repository ?? null;
      const branch = opts.branch ?? null;
      const worktreePath = repo && branch ? `${repo}/.worktrees/${branch}` : null;
      await writeFile(
        resolve(dir, 'assignment.md'),
        `---
id: ${opts.id ?? `${slug}-id`}
slug: ${slug}
title: ${slug} title
status: in_progress
priority: medium
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
externalIds: []
dependsOn: []
blockedReason: null
workspace:
  repository: ${repo ?? 'null'}
  worktreePath: ${worktreePath ?? 'null'}
  branch: ${branch ?? 'null'}
  parentBranch: ${repo && branch ? 'main' : 'null'}
tags: []
---

# ${slug}`,
        'utf-8',
      );
    }

    async function writeStandaloneAssignment(
      assignmentsDir: string,
      id: string,
      slug: string,
      opts: { repository?: string; branch?: string },
    ): Promise<void> {
      const dir = resolve(assignmentsDir, id);
      await mkdir(dir, { recursive: true });
      const repo = opts.repository ?? null;
      const branch = opts.branch ?? null;
      const worktreePath = repo && branch ? `${repo}/.worktrees/${branch}` : null;
      await writeFile(
        resolve(dir, 'assignment.md'),
        `---
id: ${id}
slug: ${slug}
title: ${slug} title
status: in_progress
priority: medium
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
externalIds: []
dependsOn: []
blockedReason: null
workspace:
  repository: ${repo ?? 'null'}
  worktreePath: ${worktreePath ?? 'null'}
  branch: ${branch ?? 'null'}
  parentBranch: ${repo && branch ? 'main' : 'null'}
tags: []
---

# ${slug}`,
        'utf-8',
      );
    }

    describe('GET repository-branches', () => {
      it('project: returns branches + default', async () => {
        await createAssignmentFixture();
        const repo = await setupRepo();
        spawnSync('git', ['-C', repo, 'branch', 'develop'], { encoding: 'utf-8' });
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'get',
          '/api/projects/:slug/assignments/:aslug/repository-branches',
          { slug: 'test-project', aslug: 'test-assignment' },
          undefined,
          { repo },
        );
        expect(res.statusCode, JSON.stringify(res.payload)).toBe(200);
        const payload = res.payload as { branches: string[]; defaultBranch: string | null };
        expect(payload.branches).toEqual(expect.arrayContaining(['main', 'develop']));
        expect(payload.defaultBranch).toBe('main');
      });

      it('project: 400 when repo is a subdirectory (not the root)', async () => {
        await createAssignmentFixture();
        const repo = await setupRepo();
        await mkdir(resolve(repo, 'sub'), { recursive: true });
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'get',
          '/api/projects/:slug/assignments/:aslug/repository-branches',
          { slug: 'test-project', aslug: 'test-assignment' },
          undefined,
          { repo: resolve(repo, 'sub') },
        );
        expect(res.statusCode).toBe(400);
        expect((res.payload as { error: string }).error).toMatch(/working-tree root/i);
      });

      it('project: 400 when repo query is missing', async () => {
        await createAssignmentFixture();
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'get',
          '/api/projects/:slug/assignments/:aslug/repository-branches',
          { slug: 'test-project', aslug: 'test-assignment' },
          undefined,
          {},
        );
        expect(res.statusCode).toBe(400);
      });

      it('standalone: 501 when standalone not configured', async () => {
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'get',
          '/api/assignments/:id/repository-branches',
          { id: 'x' },
          undefined,
          { repo: '/whatever' },
        );
        expect(res.statusCode).toBe(501);
      });

      it('standalone: returns branches when configured', async () => {
        const assignmentsDir = resolve(testDir, 'standalone');
        await mkdir(assignmentsDir, { recursive: true });
        const repo = await setupRepo();
        const router = createWriteRouter(testDir, assignmentsDir);
        const res = await invokeRoute(
          router,
          'get',
          '/api/assignments/:id/repository-branches',
          { id: 'x' },
          undefined,
          { repo },
        );
        expect(res.statusCode, JSON.stringify(res.payload)).toBe(200);
        expect((res.payload as { branches: string[] }).branches).toContain('main');
      });
    });

    describe('GET source-assignments', () => {
      it('project: excludes self + bare assignments, returns configured siblings', async () => {
        await createAssignmentFixture();
        // The current assignment itself has a workspace — it must still be excluded.
        await writeProjectAssignment('test-assignment', {
          id: 'cur-id',
          repository: '/repo/self',
          branch: 'self-branch',
        });
        await writeProjectAssignment('sibling-configured', {
          id: 'sib-1',
          repository: '/repo/sib',
          branch: 'sib-branch',
        });
        await writeProjectAssignment('sibling-bare', { id: 'sib-2' });
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'get',
          '/api/projects/:slug/assignments/:aslug/source-assignments',
          { slug: 'test-project', aslug: 'test-assignment' },
          undefined,
        );
        expect(res.statusCode).toBe(200);
        const sources = (res.payload as {
          sourceAssignments: Array<{ id: string; slug: string; repository: string; branch: string }>;
        }).sourceAssignments;
        expect(sources.map((s) => s.slug)).toEqual(['sibling-configured']);
        expect(sources[0]!.id).toBe('sib-1');
        expect(sources[0]!.repository).toBe('/repo/sib');
        expect(sources[0]!.branch).toBe('sib-branch');
      });

      it('standalone: excludes self by id, omits bare assignments', async () => {
        const assignmentsDir = resolve(testDir, 'standalone');
        await mkdir(assignmentsDir, { recursive: true });
        await writeStandaloneAssignment(assignmentsDir, 'uuid-self', 'self', {
          repository: '/repo/self',
          branch: 'self-b',
        });
        await writeStandaloneAssignment(assignmentsDir, 'uuid-other', 'other', {
          repository: '/repo/other',
          branch: 'other-b',
        });
        await writeStandaloneAssignment(assignmentsDir, 'uuid-bare', 'bare', {});
        const router = createWriteRouter(testDir, assignmentsDir);
        const res = await invokeRoute(
          router,
          'get',
          '/api/assignments/:id/source-assignments',
          { id: 'uuid-self' },
          undefined,
        );
        expect(res.statusCode).toBe(200);
        const sources = (res.payload as { sourceAssignments: Array<{ id: string }> }).sourceAssignments;
        expect(sources.map((s) => s.id)).toEqual(['uuid-other']);
      });
    });

    describe('POST worktree validation + lock + branch-off', () => {
      it('400 on invalid branch name, leaving no partial state', async () => {
        await createAssignmentFixture();
        const repo = await setupRepo();
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/projects/:slug/assignments/:aslug/worktree',
          { slug: 'test-project', aslug: 'test-assignment' },
          { repository: repo, branch: 'bad name' },
        );
        expect(res.statusCode).toBe(400);
        const fs = await import('node:fs/promises');
        await expect(fs.stat(resolve(repo, '.worktrees', 'bad name'))).rejects.toBeTruthy();
        const content = await fs.readFile(
          resolve(testDir, 'test-project', 'assignments', 'test-assignment', 'assignment.md'),
          'utf-8',
        );
        expect(content).toContain('worktreePath: null');
      });

      it('409 when the branch already exists in the repo', async () => {
        await createAssignmentFixture();
        const repo = await setupRepo();
        spawnSync('git', ['-C', repo, 'branch', 'syntaur/test-project/test-assignment'], {
          encoding: 'utf-8',
        });
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/projects/:slug/assignments/:aslug/worktree',
          { slug: 'test-project', aslug: 'test-assignment' },
          { repository: repo },
        );
        expect(res.statusCode).toBe(409);
        expect((res.payload as { error: string }).error).toMatch(/already exists/i);
      });

      it('trims whitespace around the repository path', async () => {
        await createAssignmentFixture();
        const repo = await setupRepo();
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/projects/:slug/assignments/:aslug/worktree',
          { slug: 'test-project', aslug: 'test-assignment' },
          { repository: `  ${repo}  ` },
        );
        expect(res.statusCode, JSON.stringify(res.payload)).toBe(200);
        expect(
          (res.payload as { assignment: { workspace: { repository: string } } }).assignment.workspace
            .repository,
        ).toBe(repo);
      });

      it('in-flight lock: 409 while a create is in progress, then succeeds (different branch)', async () => {
        await createAssignmentFixture();
        const repo = await setupRepo();
        const router = createWriteRouter(testDir);
        const assignmentPath = resolve(
          testDir,
          'test-project',
          'assignments',
          'test-assignment',
          'assignment.md',
        );
        worktreeInFlight.add(assignmentPath);
        try {
          const blocked = await invokeRoute(
            router,
            'post',
            '/api/projects/:slug/assignments/:aslug/worktree',
            { slug: 'test-project', aslug: 'test-assignment' },
            { repository: repo, branch: 'some-other-branch' },
          );
          expect(blocked.statusCode).toBe(409);
          expect((blocked.payload as { error: string }).error).toMatch(/already being created/i);
        } finally {
          worktreeInFlight.delete(assignmentPath);
        }
        // Lock released: a create with a DIFFERENT branch now succeeds — proving
        // the lock guarded a race `git worktree add` alone would not catch.
        const ok = await invokeRoute(
          router,
          'post',
          '/api/projects/:slug/assignments/:aslug/worktree',
          { slug: 'test-project', aslug: 'test-assignment' },
          { repository: repo, branch: 'some-other-branch' },
        );
        expect(ok.statusCode, JSON.stringify(ok.payload)).toBe(200);
      });

      it('branch-off: uses a source assignment\'s repo + branch as parent', async () => {
        await createAssignmentFixture();
        const repo = await setupRepo();
        // The source's branch must exist so the parent-branch pre-flight passes.
        spawnSync('git', ['-C', repo, 'branch', 'feature/src'], { encoding: 'utf-8' });
        await writeProjectAssignment('source-asg', {
          id: 'src-1',
          repository: repo,
          branch: 'feature/src',
        });
        const router = createWriteRouter(testDir);
        // 1. The UI lists source assignments.
        const list = await invokeRoute(
          router,
          'get',
          '/api/projects/:slug/assignments/:aslug/source-assignments',
          { slug: 'test-project', aslug: 'test-assignment' },
          undefined,
        );
        const sources = (list.payload as {
          sourceAssignments: Array<{ id: string; repository: string; branch: string }>;
        }).sourceAssignments;
        const src = sources.find((s) => s.id === 'src-1')!;
        expect(src.branch).toBe('feature/src');
        // 2. It submits the resolved repo + branch-as-parent via the same POST.
        const res = await invokeRoute(
          router,
          'post',
          '/api/projects/:slug/assignments/:aslug/worktree',
          { slug: 'test-project', aslug: 'test-assignment' },
          { repository: src.repository, branch: 'syntaur/branched', parentBranch: src.branch },
        );
        expect(res.statusCode, JSON.stringify(res.payload)).toBe(200);
        const ws = (res.payload as {
          assignment: { workspace: { repository: string; branch: string; parentBranch: string } };
        }).assignment.workspace;
        expect(ws.repository).toBe(repo);
        expect(ws.branch).toBe('syntaur/branched');
        expect(ws.parentBranch).toBe('feature/src');
      });
    });

    describe('POST /api/projects/:slug/assignments/:aslug/worktree', () => {
      it('happy path: creates worktree + updates frontmatter', async () => {
        await createAssignmentFixture();
        const repo = await setupRepo();
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/projects/:slug/assignments/:aslug/worktree',
          { slug: 'test-project', aslug: 'test-assignment' },
          { repository: repo },
        );
        expect(res.statusCode, JSON.stringify(res.payload)).toBe(200);
        const payload = res.payload as { assignment: { workspace: { worktreePath: string | null; branch: string | null; repository: string | null; parentBranch: string | null } } };
        expect(payload.assignment.workspace.worktreePath).toBe(
          resolve(repo, '.worktrees', 'syntaur/test-project/test-assignment'),
        );
        expect(payload.assignment.workspace.branch).toBe('syntaur/test-project/test-assignment');
        expect(payload.assignment.workspace.repository).toBe(repo);
        expect(payload.assignment.workspace.parentBranch).toBe('main');
        // Worktree exists on disk.
        const stat = (await import('node:fs/promises')).stat;
        await expect(stat(resolve(repo, '.worktrees', 'syntaur/test-project/test-assignment'))).resolves.toBeTruthy();
        // Branch was actually created.
        const branchList = spawnSync(
          'git',
          ['-C', repo, 'branch', '--list', 'syntaur/test-project/test-assignment'],
          { encoding: 'utf-8' },
        );
        expect(branchList.stdout.trim()).not.toBe('');
      });

      it('returns 400 when repository is a subdirectory of the repo (not the root)', async () => {
        await createAssignmentFixture();
        const repo = await setupRepo();
        await mkdir(resolve(repo, 'sub'), { recursive: true });
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/projects/:slug/assignments/:aslug/worktree',
          { slug: 'test-project', aslug: 'test-assignment' },
          { repository: resolve(repo, 'sub') },
        );
        expect(res.statusCode).toBe(400);
        const payload = res.payload as { error: string };
        expect(payload.error).toMatch(/working-tree root/i);
      });

      it('returns 409 when workspace.worktreePath is already set', async () => {
        await createAssignmentFixture();
        const repo = await setupRepo();
        const router = createWriteRouter(testDir);
        // First create.
        await invokeRoute(
          router,
          'post',
          '/api/projects/:slug/assignments/:aslug/worktree',
          { slug: 'test-project', aslug: 'test-assignment' },
          { repository: repo },
        );
        // Second create.
        const res = await invokeRoute(
          router,
          'post',
          '/api/projects/:slug/assignments/:aslug/worktree',
          { slug: 'test-project', aslug: 'test-assignment' },
          { repository: repo },
        );
        expect(res.statusCode).toBe(409);
      });

      it('returns 400 when repository is missing', async () => {
        await createAssignmentFixture();
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/projects/:slug/assignments/:aslug/worktree',
          { slug: 'test-project', aslug: 'test-assignment' },
          {},
        );
        expect(res.statusCode).toBe(400);
      });

      it('returns 400 when repository is relative', async () => {
        await createAssignmentFixture();
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/projects/:slug/assignments/:aslug/worktree',
          { slug: 'test-project', aslug: 'test-assignment' },
          { repository: './relative' },
        );
        expect(res.statusCode).toBe(400);
      });

      it('returns 400 when repository does not exist on disk', async () => {
        await createAssignmentFixture();
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/projects/:slug/assignments/:aslug/worktree',
          { slug: 'test-project', aslug: 'test-assignment' },
          { repository: '/nonexistent-path-' + Date.now() },
        );
        expect(res.statusCode).toBe(400);
      });

      it('returns 400 when repository is not a git working tree', async () => {
        await createAssignmentFixture();
        const notGit = resolve(testDir, 'not-git');
        await mkdir(notGit, { recursive: true });
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/projects/:slug/assignments/:aslug/worktree',
          { slug: 'test-project', aslug: 'test-assignment' },
          { repository: notGit },
        );
        expect(res.statusCode).toBe(400);
      });

      it('returns 409 with a plain-language error when the branch already exists', async () => {
        await createAssignmentFixture();
        const repo = await setupRepo();
        // Pre-create the branch syntaur/test-project/test-assignment.
        spawnSync('git', ['-C', repo, 'branch', 'syntaur/test-project/test-assignment'], {
          encoding: 'utf-8',
        });
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/projects/:slug/assignments/:aslug/worktree',
          { slug: 'test-project', aslug: 'test-assignment' },
          { repository: repo },
        );
        // Caught by the pre-flight in plain language (AC #6) — not raw git stderr.
        expect(res.statusCode).toBe(409);
        const payload = res.payload as { error: string; stderr?: string };
        expect(payload.error).toMatch(/already exists/i);
        expect(payload.stderr).toBeUndefined();
        // Frontmatter must NOT be partially populated.
        const after = await readFile(
          resolve(testDir, 'test-project', 'assignments', 'test-assignment', 'assignment.md'),
          'utf-8',
        );
        expect(after).toMatch(/worktreePath:\s*null/);
      });

      it('accepts custom branch override', async () => {
        await createAssignmentFixture();
        const repo = await setupRepo();
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/projects/:slug/assignments/:aslug/worktree',
          { slug: 'test-project', aslug: 'test-assignment' },
          { repository: repo, branch: 'feature/foo' },
        );
        expect(res.statusCode, JSON.stringify(res.payload)).toBe(200);
        const payload = res.payload as { assignment: { workspace: { branch: string | null; worktreePath: string | null } } };
        expect(payload.assignment.workspace.branch).toBe('feature/foo');
        expect(payload.assignment.workspace.worktreePath).toBe(resolve(repo, '.worktrees', 'feature/foo'));
      });

      it('returns 409 when the worktree dir already exists on disk', async () => {
        await createAssignmentFixture();
        const repo = await setupRepo();
        // Pre-create the target directory (no git involvement).
        await mkdir(resolve(repo, '.worktrees', 'syntaur/test-project/test-assignment'), { recursive: true });
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/projects/:slug/assignments/:aslug/worktree',
          { slug: 'test-project', aslug: 'test-assignment' },
          { repository: repo },
        );
        expect(res.statusCode).toBe(409);
        // No branch should have been created.
        const branches = spawnSync('git', ['-C', repo, 'branch', '--list', 'syntaur/test-project/test-assignment'], {
          encoding: 'utf-8',
        });
        expect(branches.stdout.trim()).toBe('');
      });

      it('returns 400 when parentBranch does not exist in the repo', async () => {
        await createAssignmentFixture();
        const repo = await setupRepo();
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/projects/:slug/assignments/:aslug/worktree',
          { slug: 'test-project', aslug: 'test-assignment' },
          { repository: repo, parentBranch: 'nonexistent' },
        );
        expect(res.statusCode).toBe(400);
        // No worktree, no branch, no frontmatter change.
        const after = await readFile(
          resolve(testDir, 'test-project', 'assignments', 'test-assignment', 'assignment.md'),
          'utf-8',
        );
        expect(after).toMatch(/worktreePath:\s*null/);
      });
    });

    describe('POST /api/assignments/:id/worktree', () => {
      async function setupStandalone(id: string, slug: string): Promise<{
        assignmentsDir: string;
        assignmentMd: string;
      }> {
        const assignmentsDir = resolve(testDir, 'standalone');
        const dir = resolve(assignmentsDir, id);
        await mkdir(dir, { recursive: true });
        const assignmentMd = resolve(dir, 'assignment.md');
        await writeFile(
          assignmentMd,
          `---
id: ${id}
slug: ${slug}
title: ${slug}
status: in_progress
priority: medium
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
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

# ${slug}`,
          'utf-8',
        );
        return { assignmentsDir, assignmentMd };
      }

      it('returns 501 when standalone assignments are not configured', async () => {
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/assignments/:id/worktree',
          { id: 'anything' },
          { repository: '/tmp' },
        );
        expect(res.statusCode).toBe(501);
      });

      it('returns 404 when id does not resolve', async () => {
        const { assignmentsDir } = await setupStandalone('uuid-1', 'demo');
        const router = createWriteRouter(testDir, assignmentsDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/assignments/:id/worktree',
          { id: 'uuid-missing' },
          { repository: '/tmp' },
        );
        expect(res.statusCode).toBe(404);
      });

      it('standalone branch uses parsed.slug (NOT the UUID stored in resolved.assignmentSlug)', async () => {
        const { assignmentsDir } = await setupStandalone('uuid-1', 'my-task');
        const repo = await setupRepo();
        const router = createWriteRouter(testDir, assignmentsDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/assignments/:id/worktree',
          { id: 'uuid-1' },
          { repository: repo },
        );
        expect(res.statusCode, JSON.stringify(res.payload)).toBe(200);
        const payload = res.payload as { assignment: { workspace: { branch: string | null } } };
        expect(payload.assignment.workspace.branch).toBe('syntaur/my-task');
      });

      it('project-nested via id-route uses project slug prefix', async () => {
        await createAssignmentFixture();
        const repo = await setupRepo();
        const assignmentsDir = resolve(testDir, 'standalone'); // empty but defined
        await mkdir(assignmentsDir, { recursive: true });
        const router = createWriteRouter(testDir, assignmentsDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/assignments/:id/worktree',
          { id: 'assignment-1' },
          { repository: repo },
        );
        expect(res.statusCode, JSON.stringify(res.payload)).toBe(200);
        const payload = res.payload as { assignment: { workspace: { branch: string | null } } };
        expect(payload.assignment.workspace.branch).toBe('syntaur/test-project/test-assignment');
      });

      // The id-route shares `handleWorktreeCreate` with the project-nested
      // route, but each validation/conflict path must still be pinned here so
      // a future divergence doesn't silently drop a check on standalone.

      it('returns 409 when standalone workspace.worktreePath is already set', async () => {
        const { assignmentsDir } = await setupStandalone('uuid-1', 'my-task');
        const repo = await setupRepo();
        const router = createWriteRouter(testDir, assignmentsDir);
        await invokeRoute(
          router,
          'post',
          '/api/assignments/:id/worktree',
          { id: 'uuid-1' },
          { repository: repo },
        );
        const res = await invokeRoute(
          router,
          'post',
          '/api/assignments/:id/worktree',
          { id: 'uuid-1' },
          { repository: repo },
        );
        expect(res.statusCode).toBe(409);
      });

      it('returns 400 when repository is missing on id-route', async () => {
        const { assignmentsDir } = await setupStandalone('uuid-1', 'my-task');
        const router = createWriteRouter(testDir, assignmentsDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/assignments/:id/worktree',
          { id: 'uuid-1' },
          {},
        );
        expect(res.statusCode).toBe(400);
      });

      it('returns 400 when repository is relative on id-route', async () => {
        const { assignmentsDir } = await setupStandalone('uuid-1', 'my-task');
        const router = createWriteRouter(testDir, assignmentsDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/assignments/:id/worktree',
          { id: 'uuid-1' },
          { repository: './relative' },
        );
        expect(res.statusCode).toBe(400);
      });

      it('returns 400 when repository does not exist on disk on id-route', async () => {
        const { assignmentsDir } = await setupStandalone('uuid-1', 'my-task');
        const router = createWriteRouter(testDir, assignmentsDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/assignments/:id/worktree',
          { id: 'uuid-1' },
          { repository: '/nonexistent-id-path-' + Date.now() },
        );
        expect(res.statusCode).toBe(400);
      });

      it('returns 400 when repository is not a git working tree on id-route', async () => {
        const { assignmentsDir } = await setupStandalone('uuid-1', 'my-task');
        const notGit = resolve(testDir, 'not-git');
        await mkdir(notGit, { recursive: true });
        const router = createWriteRouter(testDir, assignmentsDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/assignments/:id/worktree',
          { id: 'uuid-1' },
          { repository: notGit },
        );
        expect(res.statusCode).toBe(400);
      });

      it('returns 400 when repository is a subdirectory on id-route', async () => {
        const { assignmentsDir } = await setupStandalone('uuid-1', 'my-task');
        const repo = await setupRepo();
        await mkdir(resolve(repo, 'sub'), { recursive: true });
        const router = createWriteRouter(testDir, assignmentsDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/assignments/:id/worktree',
          { id: 'uuid-1' },
          { repository: resolve(repo, 'sub') },
        );
        expect(res.statusCode).toBe(400);
      });

      it('returns 409 with a plain-language error when branch exists (id-route)', async () => {
        const { assignmentsDir } = await setupStandalone('uuid-1', 'my-task');
        const repo = await setupRepo();
        spawnSync('git', ['-C', repo, 'branch', 'syntaur/my-task'], { encoding: 'utf-8' });
        const router = createWriteRouter(testDir, assignmentsDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/assignments/:id/worktree',
          { id: 'uuid-1' },
          { repository: repo },
        );
        expect(res.statusCode).toBe(409);
        const payload = res.payload as { error: string; stderr?: string };
        expect(payload.error).toMatch(/already exists/i);
        expect(payload.stderr).toBeUndefined();
      });

      it('returns 409 when the worktree dir already exists on disk (id-route)', async () => {
        const { assignmentsDir } = await setupStandalone('uuid-1', 'my-task');
        const repo = await setupRepo();
        await mkdir(resolve(repo, '.worktrees', 'syntaur/my-task'), { recursive: true });
        const router = createWriteRouter(testDir, assignmentsDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/assignments/:id/worktree',
          { id: 'uuid-1' },
          { repository: repo },
        );
        expect(res.statusCode).toBe(409);
      });

      it('returns 400 when parentBranch does not exist on id-route', async () => {
        const { assignmentsDir } = await setupStandalone('uuid-1', 'my-task');
        const repo = await setupRepo();
        const router = createWriteRouter(testDir, assignmentsDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/assignments/:id/worktree',
          { id: 'uuid-1' },
          { repository: repo, parentBranch: 'nonexistent' },
        );
        expect(res.statusCode).toBe(400);
      });

      it('accepts custom branch override on id-route', async () => {
        const { assignmentsDir } = await setupStandalone('uuid-1', 'my-task');
        const repo = await setupRepo();
        const router = createWriteRouter(testDir, assignmentsDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/assignments/:id/worktree',
          { id: 'uuid-1' },
          { repository: repo, branch: 'feature/foo' },
        );
        expect(res.statusCode, JSON.stringify(res.payload)).toBe(200);
        const payload = res.payload as { assignment: { workspace: { branch: string | null; worktreePath: string | null } } };
        expect(payload.assignment.workspace.branch).toBe('feature/foo');
        expect(payload.assignment.workspace.worktreePath).toBe(resolve(repo, '.worktrees', 'feature/foo'));
      });
    });
  });
});
