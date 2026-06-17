import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { RequestHandler, Router } from 'express';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createWriteRouter, worktreeInFlight, setTopLevelField } from '../dashboard/api-write.js';
import { parseAssignmentFrontmatter } from '../lifecycle/frontmatter.js';
import { parseComments } from '../dashboard/parser.js';
import { formatCommentEntry } from '../templates/comments.js';

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
    // Derived-status v3: blocked keys on blockedReason PRESENCE, so a default
    // reason is recorded instead of null (else the block would derive away).
    expect((blockedWithoutReason.payload as any).assignment.blockedReason).toBe('(unspecified)');

    // Unblock: status RE-DERIVES from facts (this bare fixture has placeholder
    // content → draft), not an imperative jump to in_progress.
    const unblocked = await invokeRoute(
      router,
      'post',
      '/api/projects/:slug/assignments/:aslug/transitions/:command',
      { slug: 'test-project', aslug: 'test-assignment', command: 'unblock' },
      {},
    );
    expect(unblocked.statusCode).toBe(200);
    expect((unblocked.payload as any).assignment.status).toBe('draft');
    expect((unblocked.payload as any).assignment.blockedReason).toBeNull();

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

  it('POST /api/assignments/:id/transitions/start settles to derived status', async () => {
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
    // Derived-status v3: the imperative target settles to derived reality —
    // a bare standalone assignment (placeholder content) derives to draft.
    expect((start.payload as any).assignment.status).toBe('draft');
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

  describe('archive / restore endpoints', () => {
    it('archives + restores a project-scoped assignment, preserving status', async () => {
      await createAssignmentFixture();
      const router = createWriteRouter(testDir);
      const assignmentPath = resolve(testDir, 'test-project', 'assignments', 'test-assignment', 'assignment.md');

      const archived = await invokeRoute(
        router,
        'post',
        '/api/projects/:slug/assignments/:aslug/archive',
        { slug: 'test-project', aslug: 'test-assignment' },
        { reason: 'no longer needed' },
      );
      expect(archived.statusCode).toBe(200);
      const archDetail = (archived.payload as any).assignment;
      expect(archDetail.archived).toBe(true);
      expect(archDetail.archivedAt).toBeTruthy();
      expect(archDetail.archivedReason).toBe('no longer needed');
      expect(archDetail.status).toBe('pending'); // status untouched
      const archContent = await readFile(assignmentPath, 'utf-8');
      expect(archContent).toContain('archived: true');
      expect(archContent).toContain('status: pending');

      const restored = await invokeRoute(
        router,
        'post',
        '/api/projects/:slug/assignments/:aslug/unarchive',
        { slug: 'test-project', aslug: 'test-assignment' },
        {},
      );
      expect(restored.statusCode).toBe(200);
      const restDetail = (restored.payload as any).assignment;
      expect(restDetail.archived).toBe(false);
      expect(restDetail.archivedAt).toBeNull();
      expect(restDetail.archivedReason).toBeNull();
      expect(restDetail.status).toBe('pending'); // prior status preserved
    });

    it('archives + restores a project via the real flag (not statusOverride)', async () => {
      await createAssignmentFixture();
      const router = createWriteRouter(testDir);
      const projectPath = resolve(testDir, 'test-project', 'project.md');

      const archived = await invokeRoute(
        router,
        'post',
        '/api/projects/:slug/archive',
        { slug: 'test-project' },
        {},
      );
      expect(archived.statusCode).toBe(200);
      expect((archived.payload as any).project.archived).toBe(true);
      const archContent = await readFile(projectPath, 'utf-8');
      expect(archContent).toContain('archived: true');
      expect(archContent).not.toContain('statusOverride: archived');

      const restored = await invokeRoute(
        router,
        'post',
        '/api/projects/:slug/unarchive',
        { slug: 'test-project' },
        {},
      );
      expect(restored.statusCode).toBe(200);
      expect((restored.payload as any).project.archived).toBe(false);
    });

    it('archives + restores a standalone assignment', async () => {
      const assignmentsDir = resolve(testDir, 'standalone');
      const sdir = resolve(assignmentsDir, 'sa-uuid-1');
      await mkdir(sdir, { recursive: true });
      await writeFile(
        resolve(sdir, 'assignment.md'),
        `---\nid: sa-uuid-1\nslug: solo-task\ntitle: Solo\nstatus: in_progress\npriority: medium\ncreated: "2026-03-20T10:00:00Z"\nupdated: "2026-03-20T10:00:00Z"\nassignee: null\nexternalIds: []\ndependsOn: []\nblockedReason: null\nworkspace:\n  repository: null\n  worktreePath: null\n  branch: null\n  parentBranch: null\ntags: []\n---\n\n# Solo`,
        'utf-8',
      );
      const router = createWriteRouter(testDir, assignmentsDir);

      const archived = await invokeRoute(
        router,
        'post',
        '/api/assignments/:id/archive',
        { id: 'sa-uuid-1' },
        {},
      );
      expect(archived.statusCode).toBe(200);
      expect((archived.payload as any).assignment.archived).toBe(true);
      expect((archived.payload as any).assignment.status).toBe('in_progress');

      const restored = await invokeRoute(
        router,
        'post',
        '/api/assignments/:id/unarchive',
        { id: 'sa-uuid-1' },
        {},
      );
      expect(restored.statusCode).toBe(200);
      expect((restored.payload as any).assignment.archived).toBe(false);
      expect((restored.payload as any).assignment.status).toBe('in_progress');
    });

    it('returns 404 archiving a missing project', async () => {
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(router, 'post', '/api/projects/:slug/archive', { slug: 'ghost' }, {});
      expect(res.statusCode).toBe(404);
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

      it('project: 404 when the assignment does not exist', async () => {
        await createAssignmentFixture();
        const repo = await setupRepo();
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'get',
          '/api/projects/:slug/assignments/:aslug/repository-branches',
          { slug: 'test-project', aslug: 'no-such-assignment' },
          undefined,
          { repo },
        );
        expect(res.statusCode).toBe(404);
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

      it('standalone: 404 when the assignment id is unknown', async () => {
        const assignmentsDir = resolve(testDir, 'standalone');
        await mkdir(assignmentsDir, { recursive: true });
        const repo = await setupRepo();
        const router = createWriteRouter(testDir, assignmentsDir);
        const res = await invokeRoute(
          router,
          'get',
          '/api/assignments/:id/repository-branches',
          { id: 'nope' },
          undefined,
          { repo },
        );
        expect(res.statusCode).toBe(404);
      });

      it('standalone: returns branches when configured', async () => {
        const assignmentsDir = resolve(testDir, 'standalone');
        await mkdir(assignmentsDir, { recursive: true });
        await writeStandaloneAssignment(assignmentsDir, 'uuid-1', 'task', {});
        const repo = await setupRepo();
        const router = createWriteRouter(testDir, assignmentsDir);
        const res = await invokeRoute(
          router,
          'get',
          '/api/assignments/:id/repository-branches',
          { id: 'uuid-1' },
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

      it('project: 404 when the target assignment does not exist', async () => {
        await createAssignmentFixture();
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'get',
          '/api/projects/:slug/assignments/:aslug/source-assignments',
          { slug: 'test-project', aslug: 'no-such-assignment' },
          undefined,
        );
        expect(res.statusCode).toBe(404);
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

    describe('POST worktree/recreate', () => {
      async function createWorktreeThenPath(router: Router, repo: string): Promise<string> {
        const create = await invokeRoute(
          router,
          'post',
          '/api/projects/:slug/assignments/:aslug/worktree',
          { slug: 'test-project', aslug: 'test-assignment' },
          { repository: repo },
        );
        expect(create.statusCode, JSON.stringify(create.payload)).toBe(200);
        return (
          create.payload as { assignment: { workspace: { worktreePath: string } } }
        ).assignment.workspace.worktreePath;
      }

      it('rebuilds at the exact recorded path, bypassing the configured + branch-exists 409 guards', async () => {
        await createAssignmentFixture();
        const repo = await setupRepo();
        const router = createWriteRouter(testDir);
        const wtPath = await createWorktreeThenPath(router, repo);

        const fs = await import('node:fs/promises');
        // Manual delete: remove the dir WITHOUT `git worktree remove` (leaves
        // metadata + the still-existing branch — both would 409 the create flow).
        await fs.rm(wtPath, { recursive: true, force: true });
        await expect(fs.stat(wtPath)).rejects.toBeTruthy();

        const res = await invokeRoute(
          router,
          'post',
          '/api/projects/:slug/assignments/:aslug/worktree/recreate',
          { slug: 'test-project', aslug: 'test-assignment' },
          {},
        );
        expect(res.statusCode, JSON.stringify(res.payload)).toBe(200);
        const body = res.payload as { ok: boolean; exact: boolean; branch: string | null };
        expect(body.ok).toBe(true);
        expect(body.branch).toBe('syntaur/test-project/test-assignment');
        expect(body.exact).toBe(true);
        await expect(fs.stat(wtPath)).resolves.toBeTruthy();
      });

      it('ignores a client-supplied path and rebuilds the persisted one (server-authoritative)', async () => {
        await createAssignmentFixture();
        const repo = await setupRepo();
        const router = createWriteRouter(testDir);
        const wtPath = await createWorktreeThenPath(router, repo);
        const fs = await import('node:fs/promises');
        await fs.rm(wtPath, { recursive: true, force: true });

        const bogus = resolve(testDir, 'attacker-controlled');
        const res = await invokeRoute(
          router,
          'post',
          '/api/projects/:slug/assignments/:aslug/worktree/recreate',
          { slug: 'test-project', aslug: 'test-assignment' },
          { worktreePath: bogus, repository: '/etc' },
        );
        expect(res.statusCode, JSON.stringify(res.payload)).toBe(200);
        // Rebuilt at the recorded path, NOT the body-supplied one.
        await expect(fs.stat(wtPath)).resolves.toBeTruthy();
        await expect(fs.stat(bogus)).rejects.toBeTruthy();
      });

      it('returns 422 when there is no recorded worktree path to recreate', async () => {
        await createAssignmentFixture();
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/projects/:slug/assignments/:aslug/worktree/recreate',
          { slug: 'test-project', aslug: 'test-assignment' },
          {},
        );
        expect(res.statusCode).toBe(422);
      });

      it('is idempotent (200, alreadyExisted) when the worktree directory still exists', async () => {
        await createAssignmentFixture();
        const repo = await setupRepo();
        const router = createWriteRouter(testDir);
        await createWorktreeThenPath(router, repo);
        // Do NOT delete — recreate should no-op since the dir is present.
        const res = await invokeRoute(
          router,
          'post',
          '/api/projects/:slug/assignments/:aslug/worktree/recreate',
          { slug: 'test-project', aslug: 'test-assignment' },
          {},
        );
        expect(res.statusCode).toBe(200);
        expect((res.payload as { alreadyExisted?: boolean }).alreadyExisted).toBe(true);
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

describe('statusHistory recording + virtual fields (write router)', () => {
  const PROJ = 'test-project';
  const ASSIGN = 'test-assignment';

  function assignmentPath(slug = ASSIGN): string {
    return resolve(testDir, PROJ, 'assignments', slug, 'assignment.md');
  }
  async function readFm(slug = ASSIGN) {
    return parseAssignmentFrontmatter(await readFile(assignmentPath(slug), 'utf-8'));
  }

  it('project status-override applies PIN semantics (derived-status v3)', async () => {
    await createAssignmentFixture();
    const router = createWriteRouter(testDir);
    const res = await invokeRoute(
      router,
      'post',
      '/api/projects/:slug/assignments/:aslug/status-override',
      { slug: PROJ, aslug: ASSIGN },
      { status: 'in_progress' },
    );
    expect(res.statusCode).toBe(200);
    const fm = await readFm();
    expect(fm.status).toBe('in_progress');
    expect(fm.override).toMatchObject({ status: 'in_progress', source: 'human' });
    expect(fm.statusHistory).toHaveLength(1);
    expect(fm.statusHistory[0]).toMatchObject({
      from: 'pending',
      to: 'in_progress',
      command: 'pin',
      by: 'human',
    });
    // terminal pins are refused — the gated path owns terminal
    const refused = await invokeRoute(
      router,
      'post',
      '/api/projects/:slug/assignments/:aslug/status-override',
      { slug: PROJ, aslug: ASSIGN },
      { status: 'completed' },
    );
    expect(refused.statusCode).toBe(400);
    // status: null clears the pin → re-derives to facts (bare fixture → draft)
    const cleared = await invokeRoute(
      router,
      'post',
      '/api/projects/:slug/assignments/:aslug/status-override',
      { slug: PROJ, aslug: ASSIGN },
      { status: null },
    );
    expect(cleared.statusCode).toBe(200);
    const after = await readFm();
    expect(after.override).toBeNull();
    expect(after.status).toBe('draft');
  });

  it('project status-override is a no-op when the status is unchanged (no new entry)', async () => {
    await createAssignmentFixture();
    const router = createWriteRouter(testDir);
    // Move to in_progress (a real change → 1 entry).
    await invokeRoute(
      router,
      'post',
      '/api/projects/:slug/assignments/:aslug/status-override',
      { slug: PROJ, aslug: ASSIGN },
      { status: 'in_progress' },
    );
    expect((await readFm()).statusHistory).toHaveLength(1);
    // Re-pinning the SAME status is idempotent → no new entry, pin intact.
    const res = await invokeRoute(
      router,
      'post',
      '/api/projects/:slug/assignments/:aslug/status-override',
      { slug: PROJ, aslug: ASSIGN },
      { status: 'in_progress' },
    );
    expect(res.statusCode).toBe(200);
    const fm = await readFm();
    expect(fm.statusHistory).toHaveLength(1); // still 1
    expect(fm.override?.status).toBe('in_progress');
  });

  it('raw PATCH appends command:edit on a status change, nothing otherwise', async () => {
    await createAssignmentFixture();
    const router = createWriteRouter(testDir);

    const base = await readFile(assignmentPath(), 'utf-8');
    const changed = base.replace('status: pending', 'status: review');
    const r1 = await invokeRoute(
      router,
      'patch',
      '/api/projects/:slug/assignments/:aslug',
      { slug: PROJ, aslug: ASSIGN },
      { content: changed },
    );
    expect(r1.statusCode).toBe(200);
    let fm = await readFm();
    expect(fm.status).toBe('review');
    expect(fm.statusHistory).toHaveLength(1);
    expect(fm.statusHistory[0]).toMatchObject({ from: 'pending', to: 'review', command: 'edit' });

    // A second PATCH that does NOT change the status must append nothing.
    const current = await readFile(assignmentPath(), 'utf-8');
    const titleOnly = current.replace('title: Test Assignment', 'title: Renamed Title');
    const r2 = await invokeRoute(
      router,
      'patch',
      '/api/projects/:slug/assignments/:aslug',
      { slug: PROJ, aslug: ASSIGN },
      { content: titleOnly },
    );
    expect(r2.statusCode).toBe(200);
    fm = await readFm();
    expect(fm.statusHistory).toHaveLength(1); // unchanged
    expect(fm.title).toBe('Renamed Title');
  });

  it('raw create seeds a command:create entry', async () => {
    await createAssignmentFixture(); // creates the project
    const router = createWriteRouter(testDir);
    const content = `---
id: placeholder
slug: fresh-one
title: Fresh One
status: draft
priority: medium
created: "2026-03-21T10:00:00Z"
updated: "2026-03-21T10:00:00Z"
assignee: null
externalIds: []
dependsOn: []
links: []
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# Fresh One
`;
    const res = await invokeRoute(
      router,
      'post',
      '/api/projects/:slug/assignments',
      { slug: PROJ },
      { content },
    );
    expect(res.statusCode).toBe(201);
    const fm = await readFm('fresh-one');
    expect(fm.statusHistory).toHaveLength(1);
    expect(fm.statusHistory[0]).toMatchObject({ from: null, to: 'draft', command: 'create', by: null });
  });

  it('derives completedAt when terminal, clears it on reopen; statusAge is numeric', async () => {
    await createAssignmentFixture();
    const router = createWriteRouter(testDir);

    // Terminal is reached only via the gated transition (v3) — the override
    // endpoint refuses terminal targets.
    const done = await invokeRoute(
      router,
      'post',
      '/api/projects/:slug/assignments/:aslug/transitions/:command',
      { slug: PROJ, aslug: ASSIGN, command: 'complete' },
      {},
    );
    const detail1 = (done.payload as { assignment: { completedAt: string | null; statusAge: number | null } })
      .assignment;
    expect(detail1.completedAt).toBeTruthy();
    expect(typeof detail1.statusAge).toBe('number');
    expect(detail1.statusAge as number).toBeGreaterThanOrEqual(0);

    // Reopen via the gated transition; completedAt must clear and status
    // re-derives (the settle pass) — current status no longer terminal.
    const reopen = await invokeRoute(
      router,
      'post',
      '/api/projects/:slug/assignments/:aslug/transitions/:command',
      { slug: PROJ, aslug: ASSIGN, command: 'reopen' },
      {},
    );
    const detail2 = (reopen.payload as { assignment: { completedAt: string | null } }).assignment;
    expect(detail2.completedAt).toBeNull();
  });
});

describe('setTopLevelField (AC5: scoped to frontmatter)', () => {
  it('inserts into frontmatter and does NOT rewrite a body line starting with the key', () => {
    const content = [
      '---',
      'id: abc',
      'title: "My project"',
      '---',
      '',
      '# My project',
      '',
      'workspace: this prose line must stay untouched',
    ].join('\n');

    const out = setTopLevelField(content, 'workspace', 'syntaur');

    // Frontmatter gained the field…
    const fmEnd = out.indexOf('\n---', 4);
    const fm = out.slice(0, fmEnd);
    expect(fm).toContain('workspace: syntaur');
    // …and the body prose line is intact (not rewritten).
    expect(out).toContain('workspace: this prose line must stay untouched');
  });

  it('updates an existing frontmatter field in place', () => {
    const content = ['---', 'archived: false', '---', '', 'body'].join('\n');
    const out = setTopLevelField(content, 'archived', true);
    expect(out).toContain('archived: true');
    expect(out).not.toContain('archived: false');
  });
});

// AC1: a newline in author/replyTo breaks parseComments' single-line header
// regex → the whole comment is dropped on read. Reject it at the write boundary.
describe('comment write-boundary newline validation (AC1)', () => {
  it('rejects a project comment whose author contains a newline (400, nothing written)', async () => {
    await createAssignmentFixture();
    const router = createWriteRouter(testDir);
    const res = await invokeRoute(
      router,
      'post',
      '/api/projects/:slug/assignments/:aslug/comments',
      { slug: 'test-project', aslug: 'test-assignment' },
      { body: 'hi', type: 'note', author: 'alice\ninjected' },
    );
    expect(res.statusCode).toBe(400);
    const commentsPath = resolve(testDir, 'test-project', 'assignments', 'test-assignment', 'comments.md');
    let content = '';
    try { content = await readFile(commentsPath, 'utf-8'); } catch { /* not created */ }
    expect(content).not.toContain('**Author:**');
  });

  it('rejects a project comment whose replyTo contains a newline (400)', async () => {
    await createAssignmentFixture();
    const router = createWriteRouter(testDir);
    const res = await invokeRoute(
      router,
      'post',
      '/api/projects/:slug/assignments/:aslug/comments',
      { slug: 'test-project', aslug: 'test-assignment' },
      { body: 'hi', type: 'note', replyTo: 'abcd\nefgh' },
    );
    expect(res.statusCode).toBe(400);
  });

  it('still accepts a normal project comment (positive control)', async () => {
    await createAssignmentFixture();
    const router = createWriteRouter(testDir);
    const res = await invokeRoute(
      router,
      'post',
      '/api/projects/:slug/assignments/:aslug/comments',
      { slug: 'test-project', aslug: 'test-assignment' },
      { body: 'all good', type: 'note', author: 'alice' },
    );
    expect(res.statusCode).toBe(201);
  });

  it('rejects a standalone comment whose author contains a newline (400)', async () => {
    const assignmentsDir = resolve(testDir, 'standalone');
    await mkdir(assignmentsDir, { recursive: true });
    const router = createWriteRouter(testDir, assignmentsDir);
    const create = await invokeRoute(router, 'post', '/api/assignments', {}, { title: 'Task' });
    const id = (create.payload as any).assignment.id as string;
    const res = await invokeRoute(
      router,
      'post',
      '/api/assignments/:id/comments',
      { id },
      { body: 'hi', type: 'note', author: 'bob\nx' },
    );
    expect(res.statusCode).toBe(400);
  });
});

// AC2: parseComments split on bare `^## ` truncates a comment body that contains
// a markdown `## ` heading. It must only split at real comment headers.
describe('parseComments preserves a body containing a "## " line (AC2)', () => {
  const skeleton = (entries: string) =>
    `---\nassignment: a\nentryCount: 9\ngenerated: "2026-06-17T00:00:00Z"\nupdated: "2026-06-17T00:00:00Z"\n---\n\n# Comments\n\n${entries}`;

  it('keeps the full body when it contains a "## Section" heading', () => {
    const entry = formatCommentEntry({
      id: 'ab12',
      timestamp: '2026-06-17T00:00:00Z',
      author: 'alice',
      type: 'note',
      body: 'intro line\n\n## Section\n\nmore body text',
    });
    const parsed = parseComments(skeleton(entry));
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].body).toContain('## Section');
    expect(parsed.entries[0].body).toContain('more body text');
  });

  it('still separates two real comments when the first body has a "## " line', () => {
    const first = formatCommentEntry({
      id: 'aaaa', timestamp: '2026-06-17T00:00:00Z', author: 'alice', type: 'note',
      body: 'before\n\n## Heading\n\nafter',
    });
    const second = formatCommentEntry({
      id: 'bbbb', timestamp: '2026-06-17T01:00:00Z', author: 'bob', type: 'note',
      body: 'second comment', replyTo: 'aaaa',
    });
    const parsed = parseComments(skeleton(`${first}\n${second}`));
    expect(parsed.entries.map((e) => e.id)).toEqual(['aaaa', 'bbbb']);
    expect(parsed.entries[0].body).toContain('## Heading');
    expect(parsed.entries[0].body).toContain('after');
    expect(parsed.entries[1].body).toBe('second comment');
  });

  it('still parses a header with no blank line before **Recorded:** (backward-compat guard)', () => {
    // The header regex tolerates `## id\n**Recorded:**` (no blank line); the
    // split lookahead must not regress that older spacing.
    const md = skeleton('## cd34\n**Recorded:** 2026-06-17T00:00:00Z\n**Author:** alice\n**Type:** note\n\nbody here\n');
    const parsed = parseComments(md);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].id).toBe('cd34');
    expect(parsed.entries[0].body).toContain('body here');
  });
});
