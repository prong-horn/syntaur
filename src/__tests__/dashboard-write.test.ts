import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { RequestHandler, Router } from 'express';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join as joinPath } from 'node:path';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createWriteRouter, worktreeInFlight, setTopLevelField } from '../dashboard/api-write.js';
import { parseTicketFrontmatter } from '../lifecycle/frontmatter.js';
import { planDigest } from '../lifecycle/facts.js';
import { parseComments } from '../dashboard/parser.js';
import { formatCommentEntry } from '../templates/comments.js';
import { useHermeticSyntaurHome } from './hermetic-root.js';

// Hermetic root: these tests pass fixture configs; without a sandboxed
// SYNTAUR_HOME they read the developer’s real ~/.syntaur (ambient workflows
// dir + stages-migrated marker) — false DUAL_SOURCE errors post-2026-07-21.
useHermeticSyntaurHome();

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-write-test-'));
  if (process.env.SYNTAUR_HOME) {
    await writeFile(
      joinPath(process.env.SYNTAUR_HOME, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${testDir}\n---\n`,
    );
  }
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
  method: 'patch' | 'post' | 'get' | 'delete',
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

async function createTicketFixture(): Promise<void> {
  const projectDir = resolve(testDir, 'test-project');
  const ticketDir = resolve(projectDir, 'tickets', 'TP-1-test-ticket');
  await mkdir(ticketDir, { recursive: true });

  await writeFile(resolve(projectDir, 'project.md'), `---
id: project-1
slug: test-project
title: Test Project
prefix: TP
nextTicket: 2
defaultTemplate: feature
archived: false
archivedAt: null
archivedReason: null
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
tags: []
---

# Test Project`, 'utf-8');

  await writeFile(resolve(ticketDir, 'ticket.md'), `---
id: TP-1
slug: test-ticket
title: Test Ticket
status: pending
priority: medium
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
assignee: codex-1
externalIds: []
depends_on: []
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# Test Ticket`, 'utf-8');

  await writeFile(resolve(ticketDir, 'plan.md'), `---
ticket: test-ticket
status: draft
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
---

# Plan`, 'utf-8');

  await writeFile(resolve(ticketDir, 'scratchpad.md'), `---
ticket: test-ticket
updated: "2026-03-20T10:00:00Z"
---

# Scratchpad`, 'utf-8');

  await writeFile(resolve(ticketDir, 'handoff.md'), `---
ticket: test-ticket
updated: "2026-03-20T10:00:00Z"
handoffCount: 1
---

# Handoff Log

## Handoff 1

Initial handoff`, 'utf-8');

  await writeFile(resolve(ticketDir, 'decision-record.md'), `---
ticket: test-ticket
updated: "2026-03-20T10:00:00Z"
decisionCount: 1
---

# Decision Record

## Decision 1

Keep the current layout`, 'utf-8');
}

describe('dashboard write router', () => {
  it('rejects project slug changes', async () => {
    await createTicketFixture();
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

  it('allows direct ticket status edits via PATCH', async () => {
    await createTicketFixture();
    const router = createWriteRouter(testDir);

    const response = await invokeRoute(
      router,
      'patch',
      '/api/tickets/:id',
      { id: 'TP-1' },
      {
        content: `---
id: TP-1
slug: test-ticket
title: Test Ticket
status: completed
priority: medium
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
assignee: codex-1
externalIds: []
depends_on: []
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# Test Ticket`,
      },
    );

    expect(response.statusCode).toBe(200);
    expect((response.payload as any).ticket.status).toBe('completed');
  });

  it('toggles acceptance criteria and refreshes the ticket timestamp', async () => {
    await createTicketFixture();
    const ticketPath = resolve(
      testDir,
      'test-project',
      'tickets',
      'TP-1-test-ticket',
      'ticket.md',
    );

    await writeFile(ticketPath, `---
id: TP-1
slug: test-ticket
title: Test Ticket
status: pending
priority: medium
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
assignee: codex-1
externalIds: []
depends_on: []
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# Test Ticket

## Acceptance Criteria

- [ ] First criterion
- [x] Second criterion

## Context

Keep this paragraph.`, 'utf-8');

    const router = createWriteRouter(testDir);
    const response = await invokeRoute(
      router,
      'patch',
      '/api/tickets/:id/acceptance-criteria/:index',
      { id: 'TP-1', index: '0' },
      { checked: true },
    );

    expect(response.statusCode).toBe(200);
    expect((response.payload as any).content).toContain('- [x] First criterion');
    expect((response.payload as any).content).toContain('updated:');

    const fileContent = await readFile(ticketPath, 'utf-8');
    expect(fileContent).toContain('- [x] First criterion');
    expect(fileContent).toContain('Keep this paragraph.');
    expect(fileContent).not.toContain('updated: "2026-03-20T10:00:00Z"');
  });

  it('appends handoff entries without rewriting prior history', async () => {
    await createTicketFixture();
    const router = createWriteRouter(testDir);

    const response = await invokeRoute(
      router,
      'post',
      '/api/tickets/:id/handoff/entries',
      { id: 'TP-1' },
      {
        title: 'Handoff 2',
        body: 'Second handoff entry',
      },
    );

    expect(response.statusCode).toBe(201);
    expect((response.payload as any).ticket.handoff.handoffCount).toBe(2);
    expect((response.payload as any).content).toContain('Initial handoff');
    expect((response.payload as any).content).toContain('Second handoff entry');

    const fileContent = await readFile(
      resolve(testDir, 'test-project', 'tickets', 'TP-1-test-ticket', 'handoff.md'),
      'utf-8',
    );
    expect(fileContent).toContain('Initial handoff');
    expect(fileContent).toContain('Second handoff entry');
    expect(fileContent).toContain('**Recorded:**');
    expect(fileContent).toContain('## Handoff 2');
  });

  it('appends decision-record entries with heading, Recorded timestamp and bumped count', async () => {
    await createTicketFixture();
    const router = createWriteRouter(testDir);

    const response = await invokeRoute(
      router,
      'post',
      '/api/tickets/:id/decision-record/entries',
      { id: 'TP-1' },
      {
        title: 'Use caching',
        body: 'We will cache harness options in syntaur.db.',
      },
    );

    expect(response.statusCode).toBe(201);
    expect((response.payload as any).ticket.decisionRecord.decisionCount).toBe(2);
    expect((response.payload as any).content).toContain('## Use caching');
    expect((response.payload as any).content).toContain('**Recorded:**');
    expect((response.payload as any).content).toContain('Keep the current layout');

    const fileContent = await readFile(
      resolve(testDir, 'test-project', 'tickets', 'TP-1-test-ticket', 'decision-record.md'),
      'utf-8',
    );
    expect(fileContent).toContain('## Use caching');
    expect(fileContent).toContain('**Recorded:**');
    expect(fileContent).toContain('Keep the current layout');
    expect(fileContent).toMatch(/decisionCount: 2/);
  });

  it('allows blocking without a reason and uses lifecycle transitions for status changes', async () => {
    await createTicketFixture();
    const router = createWriteRouter(testDir);

    // Block without reason succeeds (from pending, which allows block)
    const blockedWithoutReason = await invokeRoute(
      router,
      'post',
      '/api/tickets/:id/transitions/:command',
      { id: 'TP-1', command: 'block' },
      {},
    );

    expect(blockedWithoutReason.statusCode).toBe(200);
    expect((blockedWithoutReason.payload as any).ticket.status).toBe('blocked');
    // Derived-status v3: blocked keys on blockedReason PRESENCE, so a default
    // reason is recorded instead of null (else the block would derive away).
    expect((blockedWithoutReason.payload as any).ticket.blockedReason).toBe('(unspecified)');

    // Unblock: status RE-DERIVES from facts (this bare fixture has placeholder
    // content → draft), not an imperative jump to in_progress.
    const unblocked = await invokeRoute(
      router,
      'post',
      '/api/tickets/:id/transitions/:command',
      { id: 'TP-1', command: 'unblock' },
      {},
    );
    expect(unblocked.statusCode).toBe(200);
    expect((unblocked.payload as any).ticket.status).toBe('draft');
    expect((unblocked.payload as any).ticket.blockedReason).toBeNull();

    // Block with a reason
    const blocked = await invokeRoute(
      router,
      'post',
      '/api/tickets/:id/transitions/:command',
      { id: 'TP-1', command: 'block' },
      { reason: 'Waiting on design review' },
    );
    expect(blocked.statusCode).toBe(200);
    expect((blocked.payload as any).ticket.status).toBe('blocked');
    expect((blocked.payload as any).ticket.blockedReason).toBe('Waiting on design review');
  });

  it('POST /api/tickets/:id/comments appends a comment', async () => {
    await createTicketFixture();
    const router = createWriteRouter(testDir);

    const response = await invokeRoute(
      router,
      'post',
      '/api/tickets/:id/comments',
      { id: 'TP-1' },
      { body: 'Is the migration reversible?', type: 'question', author: 'alice' },
    );

    expect(response.statusCode).toBe(201);
    const commentsPath = resolve(
      testDir,
      'test-project',
      'tickets',
      'TP-1-test-ticket',
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
    await createTicketFixture();
    const router = createWriteRouter(testDir);

    const add = await invokeRoute(
      router,
      'post',
      '/api/tickets/:id/comments',
      { id: 'TP-1' },
      { body: 'Q?', type: 'question', author: 'a' },
    );
    expect(add.statusCode).toBe(201);
    const commentId = (add.payload as any).comment.id as string;

    const toggle = await invokeRoute(
      router,
      'patch',
      '/api/tickets/:id/comments/:commentId/resolved',
      { id: 'TP-1', commentId },
      { resolved: true },
    );
    expect(toggle.statusCode).toBe(200);

    const commentsPath = resolve(
      testDir,
      'test-project',
      'tickets',
      'TP-1-test-ticket',
      'comments.md',
    );
    const content = await readFile(commentsPath, 'utf-8');
    expect(content).toMatch(/^## [a-z0-9]+\n\n[\s\S]*\*\*Resolved:\*\* true/m);
  });

  it('does not register POST /api/tickets standalone create', () => {
    const router = createWriteRouter(testDir);
    expect(() => getRouteHandler(router, 'post', '/api/tickets')).toThrow(/Route not found/);
  });

  it('rejects resolve toggle for a non-question comment', async () => {
    await createTicketFixture();
    const router = createWriteRouter(testDir);

    const add = await invokeRoute(
      router,
      'post',
      '/api/tickets/:id/comments',
      { id: 'TP-1' },
      { body: 'note body', type: 'note', author: 'a' },
    );
    const commentId = (add.payload as any).comment.id as string;

    const toggle = await invokeRoute(
      router,
      'patch',
      '/api/tickets/:id/comments/:commentId/resolved',
      { id: 'TP-1', commentId },
      { resolved: true },
    );
    expect(toggle.statusCode).toBe(400);
    expect((toggle.payload as any).error).toContain('Only questions');
  });

  describe('PATCH /api/tickets/:id/assignee', () => {
    it('updates assignee frontmatter without rewriting body', async () => {
      await createTicketFixture();
      const router = createWriteRouter(testDir);
      const ticketPath = resolve(testDir, 'test-project', 'tickets', 'TP-1-test-ticket', 'ticket.md');
      const bodyBefore = (await readFile(ticketPath, 'utf-8')).split(/^---$/m)[2];

      const res = await invokeRoute(
        router,
        'patch',
        '/api/tickets/:id/assignee',
        { id: 'TP-1' },
        { assignee: 'claude' },
      );
      expect(res.statusCode).toBe(200);

      const after = await readFile(ticketPath, 'utf-8');
      expect(after).toMatch(/^assignee: claude$/m);
      // Body untouched.
      expect(after.split(/^---$/m)[2]).toBe(bodyBefore);
    });

    it('accepts null to clear the assignee', async () => {
      await createTicketFixture();
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'patch',
        '/api/tickets/:id/assignee',
        { id: 'TP-1' },
        { assignee: null },
      );
      expect(res.statusCode).toBe(200);
      const content = await readFile(
        resolve(testDir, 'test-project', 'tickets', 'TP-1-test-ticket', 'ticket.md'),
        'utf-8',
      );
      expect(content).toMatch(/^assignee: null$/m);
    });

    it('rejects non-string non-null assignee', async () => {
      await createTicketFixture();
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'patch',
        '/api/tickets/:id/assignee',
        { id: 'TP-1' },
        { assignee: 42 },
      );
      expect(res.statusCode).toBe(400);
    });

    it('rejects assignee longer than 120 chars', async () => {
      await createTicketFixture();
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'patch',
        '/api/tickets/:id/assignee',
        { id: 'TP-1' },
        { assignee: 'a'.repeat(200) },
      );
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 for missing ticket', async () => {
      await createTicketFixture();
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'patch',
        '/api/tickets/:id/assignee',
        { id: 'TP-99' },
        { assignee: 'claude' },
      );
      expect(res.statusCode).toBe(404);
    });
  });

  describe('PATCH /api/tickets/:id/title', () => {
    const ticketPath = (): string =>
      resolve(testDir, 'test-project', 'tickets', 'TP-1-test-ticket', 'ticket.md');

    it('updates title frontmatter without rewriting body', async () => {
      await createTicketFixture();
      const router = createWriteRouter(testDir);
      const bodyBefore = (await readFile(ticketPath(), 'utf-8')).split(/^---$/m)[2];

      const res = await invokeRoute(
        router,
        'patch',
        '/api/tickets/:id/title',
        { id: 'TP-1' },
        { title: 'Renamed ticket' },
      );
      expect(res.statusCode).toBe(200);

      const after = await readFile(ticketPath(), 'utf-8');
      expect(after).toMatch(/^title: Renamed ticket$/m);
      expect(after.split(/^---$/m)[2]).toBe(bodyBefore);
    });

    it('quotes titles containing YAML metacharacters (colon) so they round-trip', async () => {
      await createTicketFixture();
      const router = createWriteRouter(testDir);

      const res = await invokeRoute(
        router,
        'patch',
        '/api/tickets/:id/title',
        { id: 'TP-1' },
        { title: 'feat: do the thing' },
      );
      expect(res.statusCode).toBe(200);

      const after = await readFile(ticketPath(), 'utf-8');
      // formatYamlValue must quote titles containing `:` to avoid YAML ambiguity.
      expect(after).toMatch(/^title: "feat: do the thing"$/m);
    });

    it('bumps updated when the title changes', async () => {
      await createTicketFixture();
      const router = createWriteRouter(testDir);
      const before = await readFile(ticketPath(), 'utf-8');

      const res = await invokeRoute(
        router,
        'patch',
        '/api/tickets/:id/title',
        { id: 'TP-1' },
        { title: 'Bumped' },
      );
      expect(res.statusCode).toBe(200);

      const after = await readFile(ticketPath(), 'utf-8');
      const bumpedMatch = after.match(/^updated: "(.+)"$/m);
      const originalMatch = before.match(/^updated: "(.+)"$/m);
      expect(bumpedMatch).not.toBeNull();
      expect(originalMatch).not.toBeNull();
      expect(bumpedMatch![1]).not.toEqual(originalMatch![1]);
    });

    it('rejects empty title', async () => {
      await createTicketFixture();
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'patch',
        '/api/tickets/:id/title',
        { id: 'TP-1' },
        { title: '' },
      );
      expect(res.statusCode).toBe(400);
    });

    it('rejects whitespace-only title', async () => {
      await createTicketFixture();
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'patch',
        '/api/tickets/:id/title',
        { id: 'TP-1' },
        { title: '   \t  ' },
      );
      expect(res.statusCode).toBe(400);
    });

    it('rejects title longer than 200 chars', async () => {
      await createTicketFixture();
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'patch',
        '/api/tickets/:id/title',
        { id: 'TP-1' },
        { title: 'a'.repeat(201) },
      );
      expect(res.statusCode).toBe(400);
    });

    it('rejects non-string title', async () => {
      await createTicketFixture();
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'patch',
        '/api/tickets/:id/title',
        { id: 'TP-1' },
        { title: 42 },
      );
      expect(res.statusCode).toBe(400);
    });

    it('rejects title containing a double quote', async () => {
      await createTicketFixture();
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'patch',
        '/api/tickets/:id/title',
        { id: 'TP-1' },
        { title: 'has "quote"' },
      );
      expect(res.statusCode).toBe(400);
    });

    it('rejects title containing a newline', async () => {
      await createTicketFixture();
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'patch',
        '/api/tickets/:id/title',
        { id: 'TP-1' },
        { title: 'line one\nline two' },
      );
      expect(res.statusCode).toBe(400);
    });

    it('rejects title containing a carriage return', async () => {
      await createTicketFixture();
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'patch',
        '/api/tickets/:id/title',
        { id: 'TP-1' },
        { title: 'line one\rline two' },
      );
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 for missing ticket', async () => {
      await createTicketFixture();
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(
        router,
        'patch',
        '/api/tickets/:id/title',
        { id: 'TP-99' },
        { title: 'whatever' },
      );
      expect(res.statusCode).toBe(404);
    });

    it('PATCH /api/tickets/:id/title returns 404 for missing id', async () => {
      await createTicketFixture();
      const router = createWriteRouter(testDir);

      const res = await invokeRoute(
        router,
        'patch',
        '/api/tickets/:id/title',
        { id: 'TP-99' },
        { title: 'whatever' },
      );
      expect(res.statusCode).toBe(404);
    });
  });

  describe('archive / restore endpoints', () => {
    it('archives + restores a project-scoped ticket, preserving status', async () => {
      await createTicketFixture();
      const router = createWriteRouter(testDir);
      const ticketPath = resolve(testDir, 'test-project', 'tickets', 'TP-1-test-ticket', 'ticket.md');

      const archived = await invokeRoute(
        router,
        'post',
        '/api/tickets/:id/archive',
        { id: 'TP-1' },
        { reason: 'no longer needed' },
      );
      expect(archived.statusCode).toBe(200);
      const archDetail = (archived.payload as any).ticket ?? (archived.payload as any).ticket;
      expect(archDetail.archived).toBe(true);
      expect(archDetail.archivedAt).toBeTruthy();
      expect(archDetail.archivedReason).toBe('no longer needed');
      expect(archDetail.status).toBe('pending'); // status untouched
      const archContent = await readFile(ticketPath, 'utf-8');
      expect(archContent).toContain('archived: true');
      expect(archContent).toContain('status: pending');

      const restored = await invokeRoute(
        router,
        'post',
        '/api/tickets/:id/unarchive',
        { id: 'TP-1' },
        {},
      );
      expect(restored.statusCode).toBe(200);
      const restDetail = (restored.payload as any).ticket ?? (restored.payload as any).ticket;
      expect(restDetail.archived).toBe(false);
      expect(restDetail.archivedAt).toBeNull();
      expect(restDetail.archivedReason).toBeNull();
      expect(restDetail.status).toBe('pending'); // prior status preserved
    });

    it('archives + restores a project via the real flag (not statusOverride)', async () => {
      await createTicketFixture();
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

    it('returns 404 archiving a missing project', async () => {
      const router = createWriteRouter(testDir);
      const res = await invokeRoute(router, 'post', '/api/projects/:slug/archive', { slug: 'ghost' }, {});
      expect(res.statusCode).toBe(404);
    });
  });

  it('DELETE /api/tickets/:id removes a project-nested ticket directory', async () => {
    await createTicketFixture();
    const router = createWriteRouter(testDir);
    const ticketDir = resolve(testDir, 'test-project', 'tickets', 'TP-1-test-ticket');

    const res = await invokeRoute(
      router,
      'delete',
      '/api/tickets/:id',
      { id: 'TP-1' },
      {},
    );
    expect(res.statusCode).toBe(200);
    expect((res.payload as { ok: boolean }).ok).toBe(true);
    await expect(readFile(resolve(ticketDir, 'ticket.md'), 'utf-8')).rejects.toThrow();
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
        await createTicketFixture();
        // Add a `repositories:` block to project.md and a sibling ticket
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
        const siblingDir = resolve(testDir, 'test-project', 'tickets', 'TP-2-sibling-with-repo');
        await mkdir(siblingDir, { recursive: true });
        await writeFile(
          resolve(siblingDir, 'ticket.md'),
          `---
id: TP-2
slug: sibling-with-repo
title: Sibling
status: in_progress
priority: medium
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
externalIds: []
depends_on: []
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
        const dupDir = resolve(testDir, 'test-project', 'tickets', 'TP-3-sibling-dup');
        await mkdir(dupDir, { recursive: true });
        await writeFile(
          resolve(dupDir, 'ticket.md'),
          `---
id: TP-3
slug: sibling-dup
title: Sibling Dup
status: in_progress
priority: medium
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
externalIds: []
depends_on: []
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
          { path: '/repo/a', source: 'project', sourceTicketSlug: null },
          { path: '/repo/b', source: 'project', sourceTicketSlug: null },
          { path: '/repo/c', source: 'sibling', sourceTicketSlug: 'sibling-with-repo' },
        ]);
      });

      it('returns [] for an empty project (no repositories, no siblings)', async () => {
        await createTicketFixture();
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

    // --- Redesign: branch listing, source tickets, validation, lock ---

    async function writeProjectTicket(
      folderName: string,
      opts: { id: string; slug: string; repository?: string; branch?: string },
    ): Promise<void> {
      const dir = resolve(testDir, 'test-project', 'tickets', folderName);
      await mkdir(dir, { recursive: true });
      const repo = opts.repository ?? null;
      const branch = opts.branch ?? null;
      const worktreePath = repo && branch ? `${repo}/.worktrees/${branch}` : null;
      await writeFile(
        resolve(dir, 'ticket.md'),
        `---
id: ${opts.id}
slug: ${opts.slug}
title: ${opts.slug} title
status: in_progress
priority: medium
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
externalIds: []
depends_on: []
blockedReason: null
workspace:
  repository: ${repo ?? 'null'}
  worktreePath: ${worktreePath ?? 'null'}
  branch: ${branch ?? 'null'}
  parentBranch: ${repo && branch ? 'main' : 'null'}
tags: []
---

# ${opts.slug}`,
        'utf-8',
      );
    }

    describe('GET repository-branches', () => {
      it('project: returns branches + default', async () => {
        await createTicketFixture();
        const repo = await setupRepo();
        spawnSync('git', ['-C', repo, 'branch', 'develop'], { encoding: 'utf-8' });
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'get',
          '/api/tickets/:id/repository-branches',
          { id: 'TP-1' },
          undefined,
          { repo },
        );
        expect(res.statusCode, JSON.stringify(res.payload)).toBe(200);
        const payload = res.payload as { branches: string[]; defaultBranch: string | null };
        expect(payload.branches).toEqual(expect.arrayContaining(['main', 'develop']));
        expect(payload.defaultBranch).toBe('main');
      });

      it('project: 400 when repo is a subdirectory (not the root)', async () => {
        await createTicketFixture();
        const repo = await setupRepo();
        await mkdir(resolve(repo, 'sub'), { recursive: true });
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'get',
          '/api/tickets/:id/repository-branches',
          { id: 'TP-1' },
          undefined,
          { repo: resolve(repo, 'sub') },
        );
        expect(res.statusCode).toBe(400);
        expect((res.payload as { error: string }).error).toMatch(/working-tree root/i);
      });

      it('project: 400 when repo query is missing', async () => {
        await createTicketFixture();
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'get',
          '/api/tickets/:id/repository-branches',
          { id: 'TP-1' },
          undefined,
          {},
        );
        expect(res.statusCode).toBe(400);
      });

      it('project: 404 when the ticket does not exist', async () => {
        await createTicketFixture();
        const repo = await setupRepo();
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'get',
          '/api/tickets/:id/repository-branches',
          { id: 'no-such-id' },
          undefined,
          { repo },
        );
        expect(res.statusCode).toBe(404);
      });


    });

    describe('GET source-tickets', () => {
      it('project: excludes self + bare tickets, returns configured siblings', async () => {
        await createTicketFixture();
        await writeProjectTicket('TP-1-test-ticket', {
          id: 'TP-1',
          slug: 'test-ticket',
          repository: '/repo/self',
          branch: 'self-branch',
        });
        await writeProjectTicket('TP-2-sibling-configured', {
          id: 'TP-2',
          slug: 'sibling-configured',
          repository: '/repo/sib',
          branch: 'sib-branch',
        });
        await writeProjectTicket('TP-3-sibling-bare', {
          id: 'TP-3',
          slug: 'sibling-bare',
        });
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'get',
          '/api/tickets/:id/source-tickets',
          { id: 'TP-1' },
          undefined,
        );
        expect(res.statusCode).toBe(200);
        const sources = (res.payload as {
          sourceTickets: Array<{ id: string; slug: string; repository: string; branch: string }>;
        }).sourceTickets;
        expect(sources.map((s) => s.slug)).toEqual(['sibling-configured']);
        expect(sources[0]!.id).toBe('TP-2');
        expect(sources[0]!.repository).toBe('/repo/sib');
        expect(sources[0]!.branch).toBe('sib-branch');
      });

      it('project: 404 when the target ticket does not exist', async () => {
        await createTicketFixture();
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'get',
          '/api/tickets/:id/source-tickets',
          { id: 'no-such-id' },
          undefined,
        );
        expect(res.statusCode).toBe(404);
      });

    });

    describe('POST worktree validation + lock + branch-off', () => {
      it('400 on invalid branch name, leaving no partial state', async () => {
        await createTicketFixture();
        const repo = await setupRepo();
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/tickets/:id/worktree',
          { id: 'TP-1' },
          { repository: repo, branch: 'bad name' },
        );
        expect(res.statusCode).toBe(400);
        const fs = await import('node:fs/promises');
        await expect(fs.stat(resolve(repo, '.worktrees', 'bad name'))).rejects.toBeTruthy();
        const content = await fs.readFile(
          resolve(testDir, 'test-project', 'tickets', 'TP-1-test-ticket', 'ticket.md'),
          'utf-8',
        );
        expect(content).toContain('worktreePath: null');
      });

      it('409 when the branch already exists in the repo', async () => {
        await createTicketFixture();
        const repo = await setupRepo();
        spawnSync('git', ['-C', repo, 'branch', 'syntaur/test-project/test-ticket'], {
          encoding: 'utf-8',
        });
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/tickets/:id/worktree',
          { id: 'TP-1' },
          { repository: repo },
        );
        expect(res.statusCode).toBe(409);
        expect((res.payload as { error: string }).error).toMatch(/already exists/i);
      });

      it('trims whitespace around the repository path', async () => {
        await createTicketFixture();
        const repo = await setupRepo();
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/tickets/:id/worktree',
          { id: 'TP-1' },
          { repository: `  ${repo}  ` },
        );
        expect(res.statusCode, JSON.stringify(res.payload)).toBe(200);
        expect(
          (res.payload as { ticket: { workspace: { repository: string } } }).ticket.workspace
            .repository,
        ).toBe(repo);
      });

      it('in-flight lock: 409 while a create is in progress, then succeeds (different branch)', async () => {
        await createTicketFixture();
        const repo = await setupRepo();
        const router = createWriteRouter(testDir);
        const ticketPath = resolve(
          testDir,
          'test-project',
          'tickets',
          'TP-1-test-ticket',
          'ticket.md',
        );
        worktreeInFlight.add(ticketPath);
        try {
          const blocked = await invokeRoute(
            router,
            'post',
            '/api/tickets/:id/worktree',
            { id: 'TP-1' },
            { repository: repo, branch: 'some-other-branch' },
          );
          expect(blocked.statusCode).toBe(409);
          expect((blocked.payload as { error: string }).error).toMatch(/already being created/i);
        } finally {
          worktreeInFlight.delete(ticketPath);
        }
        // Lock released: a create with a DIFFERENT branch now succeeds — proving
        // the lock guarded a race `git worktree add` alone would not catch.
        const ok = await invokeRoute(
          router,
          'post',
          '/api/tickets/:id/worktree',
          { id: 'TP-1' },
          { repository: repo, branch: 'some-other-branch' },
        );
        expect(ok.statusCode, JSON.stringify(ok.payload)).toBe(200);
      });

      it('branch-off: uses a source ticket\'s repo + branch as parent', async () => {
        await createTicketFixture();
        const repo = await setupRepo();
        // The source's branch must exist so the parent-branch pre-flight passes.
        spawnSync('git', ['-C', repo, 'branch', 'feature/src'], { encoding: 'utf-8' });
        await writeProjectTicket('TP-4-source-asg', {
          id: 'TP-4',
          slug: 'source-asg',
          repository: repo,
          branch: 'feature/src',
        });
        const router = createWriteRouter(testDir);
        // 1. The UI lists source tickets.
        const list = await invokeRoute(
          router,
          'get',
          '/api/tickets/:id/source-tickets',
          { id: 'TP-1' },
          undefined,
        );
        const sources = (list.payload as {
          sourceTickets: Array<{ id: string; repository: string; branch: string }>;
        }).sourceTickets;
        const src = sources.find((s) => s.id === 'TP-4')!;
        expect(src.branch).toBe('feature/src');
        // 2. It submits the resolved repo + branch-as-parent via the same POST.
        const res = await invokeRoute(
          router,
          'post',
          '/api/tickets/:id/worktree',
          { id: 'TP-1' },
          { repository: src.repository, branch: 'syntaur/branched', parentBranch: src.branch },
        );
        expect(res.statusCode, JSON.stringify(res.payload)).toBe(200);
        const ws = (res.payload as {
          ticket: { workspace: { repository: string; branch: string; parentBranch: string } };
        }).ticket.workspace;
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
          '/api/tickets/:id/worktree',
          { id: 'TP-1' },
          { repository: repo },
        );
        expect(create.statusCode, JSON.stringify(create.payload)).toBe(200);
        return (
          create.payload as { ticket: { workspace: { worktreePath: string } } }
        ).ticket.workspace.worktreePath;
      }

      it('rebuilds at the exact recorded path, bypassing the configured + branch-exists 409 guards', async () => {
        await createTicketFixture();
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
          '/api/tickets/:id/worktree/recreate',
          { id: 'TP-1' },
          {},
        );
        expect(res.statusCode, JSON.stringify(res.payload)).toBe(200);
        const body = res.payload as { ok: boolean; exact: boolean; branch: string | null };
        expect(body.ok).toBe(true);
        expect(body.branch).toBe('syntaur/test-project/test-ticket');
        expect(body.exact).toBe(true);
        await expect(fs.stat(wtPath)).resolves.toBeTruthy();
      });

      it('ignores a client-supplied path and rebuilds the persisted one (server-authoritative)', async () => {
        await createTicketFixture();
        const repo = await setupRepo();
        const router = createWriteRouter(testDir);
        const wtPath = await createWorktreeThenPath(router, repo);
        const fs = await import('node:fs/promises');
        await fs.rm(wtPath, { recursive: true, force: true });

        const bogus = resolve(testDir, 'attacker-controlled');
        const res = await invokeRoute(
          router,
          'post',
          '/api/tickets/:id/worktree/recreate',
          { id: 'TP-1' },
          { worktreePath: bogus, repository: '/etc' },
        );
        expect(res.statusCode, JSON.stringify(res.payload)).toBe(200);
        // Rebuilt at the recorded path, NOT the body-supplied one.
        await expect(fs.stat(wtPath)).resolves.toBeTruthy();
        await expect(fs.stat(bogus)).rejects.toBeTruthy();
      });

      it('returns 422 when there is no recorded worktree path to recreate', async () => {
        await createTicketFixture();
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/tickets/:id/worktree/recreate',
          { id: 'TP-1' },
          {},
        );
        expect(res.statusCode).toBe(422);
      });

      it('is idempotent (200, alreadyExisted) when the worktree directory still exists', async () => {
        await createTicketFixture();
        const repo = await setupRepo();
        const router = createWriteRouter(testDir);
        await createWorktreeThenPath(router, repo);
        // Do NOT delete — recreate should no-op since the dir is present.
        const res = await invokeRoute(
          router,
          'post',
          '/api/tickets/:id/worktree/recreate',
          { id: 'TP-1' },
          {},
        );
        expect(res.statusCode).toBe(200);
        expect((res.payload as { alreadyExisted?: boolean }).alreadyExisted).toBe(true);
      });
    });

    describe('POST /api/tickets/:id/worktree', () => {
      it('happy path: creates worktree + updates frontmatter', async () => {
        await createTicketFixture();
        const repo = await setupRepo();
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/tickets/:id/worktree',
          { id: 'TP-1' },
          { repository: repo },
        );
        expect(res.statusCode, JSON.stringify(res.payload)).toBe(200);
        const payload = res.payload as { ticket: { workspace: { worktreePath: string | null; branch: string | null; repository: string | null; parentBranch: string | null } } };
        expect(payload.ticket.workspace.worktreePath).toBe(
          resolve(repo, '.worktrees', 'syntaur/test-project/test-ticket'),
        );
        expect(payload.ticket.workspace.branch).toBe('syntaur/test-project/test-ticket');
        expect(payload.ticket.workspace.repository).toBe(repo);
        expect(payload.ticket.workspace.parentBranch).toBe('main');
        // Worktree exists on disk.
        const stat = (await import('node:fs/promises')).stat;
        await expect(stat(resolve(repo, '.worktrees', 'syntaur/test-project/test-ticket'))).resolves.toBeTruthy();
        // Branch was actually created.
        const branchList = spawnSync(
          'git',
          ['-C', repo, 'branch', '--list', 'syntaur/test-project/test-ticket'],
          { encoding: 'utf-8' },
        );
        expect(branchList.stdout.trim()).not.toBe('');
      });

      it('returns 400 when repository is a subdirectory of the repo (not the root)', async () => {
        await createTicketFixture();
        const repo = await setupRepo();
        await mkdir(resolve(repo, 'sub'), { recursive: true });
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/tickets/:id/worktree',
          { id: 'TP-1' },
          { repository: resolve(repo, 'sub') },
        );
        expect(res.statusCode).toBe(400);
        const payload = res.payload as { error: string };
        expect(payload.error).toMatch(/working-tree root/i);
      });

      it('returns 409 when workspace.worktreePath is already set', async () => {
        await createTicketFixture();
        const repo = await setupRepo();
        const router = createWriteRouter(testDir);
        // First create.
        await invokeRoute(
          router,
          'post',
          '/api/tickets/:id/worktree',
          { id: 'TP-1' },
          { repository: repo },
        );
        // Second create.
        const res = await invokeRoute(
          router,
          'post',
          '/api/tickets/:id/worktree',
          { id: 'TP-1' },
          { repository: repo },
        );
        expect(res.statusCode).toBe(409);
      });

      it('returns 400 when repository is missing', async () => {
        await createTicketFixture();
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/tickets/:id/worktree',
          { id: 'TP-1' },
          {},
        );
        expect(res.statusCode).toBe(400);
      });

      it('returns 400 when repository is relative', async () => {
        await createTicketFixture();
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/tickets/:id/worktree',
          { id: 'TP-1' },
          { repository: './relative' },
        );
        expect(res.statusCode).toBe(400);
      });

      it('returns 400 when repository does not exist on disk', async () => {
        await createTicketFixture();
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/tickets/:id/worktree',
          { id: 'TP-1' },
          { repository: '/nonexistent-path-' + Date.now() },
        );
        expect(res.statusCode).toBe(400);
      });

      it('returns 400 when repository is not a git working tree', async () => {
        await createTicketFixture();
        const notGit = resolve(testDir, 'not-git');
        await mkdir(notGit, { recursive: true });
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/tickets/:id/worktree',
          { id: 'TP-1' },
          { repository: notGit },
        );
        expect(res.statusCode).toBe(400);
      });

      it('returns 409 with a plain-language error when the branch already exists', async () => {
        await createTicketFixture();
        const repo = await setupRepo();
        // Pre-create the branch syntaur/test-project/test-ticket.
        spawnSync('git', ['-C', repo, 'branch', 'syntaur/test-project/test-ticket'], {
          encoding: 'utf-8',
        });
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/tickets/:id/worktree',
          { id: 'TP-1' },
          { repository: repo },
        );
        // Caught by the pre-flight in plain language (AC #6) — not raw git stderr.
        expect(res.statusCode).toBe(409);
        const payload = res.payload as { error: string; stderr?: string };
        expect(payload.error).toMatch(/already exists/i);
        expect(payload.stderr).toBeUndefined();
        // Frontmatter must NOT be partially populated.
        const after = await readFile(
          resolve(testDir, 'test-project', 'tickets', 'TP-1-test-ticket', 'ticket.md'),
          'utf-8',
        );
        expect(after).toMatch(/worktreePath:\s*null/);
      });

      it('accepts custom branch override', async () => {
        await createTicketFixture();
        const repo = await setupRepo();
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/tickets/:id/worktree',
          { id: 'TP-1' },
          { repository: repo, branch: 'feature/foo' },
        );
        expect(res.statusCode, JSON.stringify(res.payload)).toBe(200);
        const payload = res.payload as { ticket: { workspace: { branch: string | null; worktreePath: string | null } } };
        expect(payload.ticket.workspace.branch).toBe('feature/foo');
        expect(payload.ticket.workspace.worktreePath).toBe(resolve(repo, '.worktrees', 'feature/foo'));
      });

      it('returns 409 when the worktree dir already exists on disk', async () => {
        await createTicketFixture();
        const repo = await setupRepo();
        // Pre-create the target directory (no git involvement).
        await mkdir(resolve(repo, '.worktrees', 'syntaur/test-project/test-ticket'), { recursive: true });
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/tickets/:id/worktree',
          { id: 'TP-1' },
          { repository: repo },
        );
        expect(res.statusCode).toBe(409);
        // No branch should have been created.
        const branches = spawnSync('git', ['-C', repo, 'branch', '--list', 'syntaur/test-project/test-ticket'], {
          encoding: 'utf-8',
        });
        expect(branches.stdout.trim()).toBe('');
      });

      it('returns 400 when parentBranch does not exist in the repo', async () => {
        await createTicketFixture();
        const repo = await setupRepo();
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/tickets/:id/worktree',
          { id: 'TP-1' },
          { repository: repo, parentBranch: 'nonexistent' },
        );
        expect(res.statusCode).toBe(400);
        // No worktree, no branch, no frontmatter change.
        const after = await readFile(
          resolve(testDir, 'test-project', 'tickets', 'TP-1-test-ticket', 'ticket.md'),
          'utf-8',
        );
        expect(after).toMatch(/worktreePath:\s*null/);
      });
    });

    describe('POST /api/tickets/:id/worktree (id route)', () => {

      it('returns 404 when id does not resolve', async () => {
        await createTicketFixture();
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/tickets/:id/worktree',
          { id: 'TP-99' },
          { repository: '/tmp' },
        );
        expect(res.statusCode).toBe(404);
      });

      it('project-nested via id-route uses project slug prefix', async () => {
        await createTicketFixture();
        const repo = await setupRepo();
        const router = createWriteRouter(testDir);
        const res = await invokeRoute(
          router,
          'post',
          '/api/tickets/:id/worktree',
          { id: 'TP-1' },
          { repository: repo },
        );
        expect(res.statusCode, JSON.stringify(res.payload)).toBe(200);
        const payload = res.payload as { ticket: { workspace: { branch: string | null } } };
        expect(payload.ticket.workspace.branch).toBe('syntaur/test-project/test-ticket');
      });
    });
  });
});

describe('statusHistory recording + virtual fields (write router)', () => {
  const PROJ = 'test-project';
  const DEFAULT_FOLDER = 'TP-1-test-ticket';

  function ticketPath(folder = DEFAULT_FOLDER): string {
    return resolve(testDir, PROJ, 'tickets', folder, 'ticket.md');
  }
  async function readFmBySlug(slug: string) {
    const { readdir } = await import('node:fs/promises');
    const ticketsRoot = resolve(testDir, PROJ, 'tickets');
    for (const entry of await readdir(ticketsRoot)) {
      const path = resolve(ticketsRoot, entry, 'ticket.md');
      try {
        const fm = parseTicketFrontmatter(await readFile(path, 'utf-8'));
        if (fm.slug === slug) return fm;
      } catch {
        // skip unreadable
      }
    }
    throw new Error(`ticket with slug "${slug}" not found`);
  }
  async function readFm(folder = DEFAULT_FOLDER) {
    return parseTicketFrontmatter(await readFile(ticketPath(folder), 'utf-8'));
  }

  it('project status-override applies PIN semantics (derived-status v3)', async () => {
    await createTicketFixture();
    const router = createWriteRouter(testDir);
    const res = await invokeRoute(
      router,
      'post',
      '/api/tickets/:id/status-override',
      { id: 'TP-1' },
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
      '/api/tickets/:id/status-override',
      { id: 'TP-1' },
      { status: 'completed' },
    );
    expect(refused.statusCode).toBe(400);
    // status: null clears the pin → re-derives to facts (bare fixture → draft)
    const cleared = await invokeRoute(
      router,
      'post',
      '/api/tickets/:id/status-override',
      { id: 'TP-1' },
      { status: null },
    );
    expect(cleared.statusCode).toBe(200);
    const after = await readFm();
    expect(after.override).toBeNull();
    expect(after.status).toBe('draft');
  });

  it('project status-override is a no-op when the status is unchanged (no new entry)', async () => {
    await createTicketFixture();
    const router = createWriteRouter(testDir);
    // Move to in_progress (a real change → 1 entry).
    await invokeRoute(
      router,
      'post',
      '/api/tickets/:id/status-override',
      { id: 'TP-1' },
      { status: 'in_progress' },
    );
    expect((await readFm()).statusHistory).toHaveLength(1);
    // Re-pinning the SAME status is idempotent → no new entry, pin intact.
    const res = await invokeRoute(
      router,
      'post',
      '/api/tickets/:id/status-override',
      { id: 'TP-1' },
      { status: 'in_progress' },
    );
    expect(res.statusCode).toBe(200);
    const fm = await readFm();
    expect(fm.statusHistory).toHaveLength(1); // still 1
    expect(fm.override?.status).toBe('in_progress');
  });

  it('raw PATCH appends command:edit on a status change, nothing otherwise', async () => {
    await createTicketFixture();
    const router = createWriteRouter(testDir);

    const base = await readFile(ticketPath(), 'utf-8');
    const changed = base.replace('status: pending', 'status: review');
    const r1 = await invokeRoute(
      router,
      'patch',
      '/api/tickets/:id',
      { id: 'TP-1' },
      { content: changed },
    );
    expect(r1.statusCode).toBe(200);
    let fm = await readFm();
    expect(fm.status).toBe('review');
    expect(fm.statusHistory).toHaveLength(1);
    expect(fm.statusHistory[0]).toMatchObject({ from: 'pending', to: 'review', command: 'edit' });

    // A second PATCH that does NOT change the status must append nothing.
    const current = await readFile(ticketPath(), 'utf-8');
    const titleOnly = current.replace('title: Test Ticket', 'title: Renamed Title');
    const r2 = await invokeRoute(
      router,
      'patch',
      '/api/tickets/:id',
      { id: 'TP-1' },
      { content: titleOnly },
    );
    expect(r2.statusCode).toBe(200);
    fm = await readFm();
    expect(fm.statusHistory).toHaveLength(1); // unchanged
    expect(fm.title).toBe('Renamed Title');
  });

  it('raw create seeds a command:create entry', async () => {
    await createTicketFixture(); // creates the project
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
depends_on: []
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
      '/api/projects/:slug/tickets',
      { slug: PROJ },
      { content },
    );
    expect(res.statusCode).toBe(201);
    const fm = await readFmBySlug('fresh-one');
    expect(fm.statusHistory).toHaveLength(1);
    expect(fm.statusHistory[0]).toMatchObject({ from: null, to: 'draft', command: 'create', by: null });
  });

  it('derives completedAt when terminal, clears it on reopen; statusAge is numeric', async () => {
    await createTicketFixture();
    const router = createWriteRouter(testDir);

    // Terminal is reached only via the gated transition (v3) — the override
    // endpoint refuses terminal targets.
    const done = await invokeRoute(
      router,
      'post',
      '/api/tickets/:id/transitions/:command',
      { id: 'TP-1', command: 'complete' },
      {},
    );
    const detail1 = (done.payload as { ticket: { completedAt: string | null; statusAge: number | null } })
      .ticket;
    expect(detail1.completedAt).toBeTruthy();
    expect(typeof detail1.statusAge).toBe('number');
    expect(detail1.statusAge as number).toBeGreaterThanOrEqual(0);

    // Reopen via the gated transition; completedAt must clear and status
    // re-derives (the settle pass) — current status no longer terminal.
    const reopen = await invokeRoute(
      router,
      'post',
      '/api/tickets/:id/transitions/:command',
      { id: 'TP-1', command: 'reopen' },
      {},
    );
    const detail2 = (reopen.payload as { ticket: { completedAt: string | null } }).ticket ?? (reopen.payload as any).ticket;
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
    await createTicketFixture();
    const router = createWriteRouter(testDir);
    const res = await invokeRoute(
      router,
      'post',
      '/api/tickets/:id/comments',
      { id: 'TP-1' },
      { body: 'hi', type: 'note', author: 'alice\ninjected' },
    );
    expect(res.statusCode).toBe(400);
    const commentsPath = resolve(testDir, 'test-project', 'tickets', 'TP-1-test-ticket', 'comments.md');
    let content = '';
    try { content = await readFile(commentsPath, 'utf-8'); } catch { /* not created */ }
    expect(content).not.toContain('**Author:**');
  });

  it('rejects a project comment whose replyTo contains a newline (400)', async () => {
    await createTicketFixture();
    const router = createWriteRouter(testDir);
    const res = await invokeRoute(
      router,
      'post',
      '/api/tickets/:id/comments',
      { id: 'TP-1' },
      { body: 'hi', type: 'note', replyTo: 'abcd\nefgh' },
    );
    expect(res.statusCode).toBe(400);
  });

  it('still accepts a normal project comment (positive control)', async () => {
    await createTicketFixture();
    const router = createWriteRouter(testDir);
    const res = await invokeRoute(
      router,
      'post',
      '/api/tickets/:id/comments',
      { id: 'TP-1' },
      { body: 'all good', type: 'note', author: 'alice' },
    );
    expect(res.statusCode).toBe(201);
  });

});

// AC2: parseComments split on bare `^## ` truncates a comment body that contains
// a markdown `## ` heading. It must only split at real comment headers.
describe('parseComments preserves a body containing a "## " line (AC2)', () => {
  const skeleton = (entries: string) =>
    `---\nticket: a\nentryCount: 9\ngenerated: "2026-06-17T00:00:00Z"\nupdated: "2026-06-17T00:00:00Z"\n---\n\n# Comments\n\n${entries}`;

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

  it('does not split on a body "## " heading followed by a lone **Recorded:** line', () => {
    // Adversarial body: a markdown heading + a line that merely starts with
    // **Recorded:** but is NOT a real comment header (no Author/Type prelude).
    const entry = formatCommentEntry({
      id: 'ef56',
      timestamp: '2026-06-17T00:00:00Z',
      author: 'alice',
      type: 'note',
      body: '## Meeting Notes\n\n**Recorded:** locally during testing\n\ntrailing body',
    });
    const parsed = parseComments(skeleton(entry));
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].body).toContain('## Meeting Notes');
    expect(parsed.entries[0].body).toContain('trailing body');
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

describe('POST plan/approve routes', () => {
  async function seedProjectPlanTicket(opts?: { withPlan?: boolean }): Promise<void> {
    const projectDir = resolve(testDir, 'plan-project');
    const ticketDir = resolve(projectDir, 'tickets', 'PP-1-plan-ticket');
    await mkdir(ticketDir, { recursive: true });
    await writeFile(
      resolve(projectDir, 'project.md'),
      `---
id: plan-project-id
slug: plan-project
title: Plan Project
prefix: PP
nextTicket: 2
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
---
# Plan Project`,
      'utf-8',
    );
    await writeFile(
      resolve(ticketDir, 'ticket.md'),
      `---
id: PP-1
slug: plan-ticket
title: Plan Ticket
status: ready_for_planning
priority: medium
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
project: plan-project
---
# Plan Ticket`,
      'utf-8',
    );
    if (opts?.withPlan !== false) {
      await writeFile(resolve(ticketDir, 'plan.md'), '# Plan body\n', 'utf-8');
    }
  }

  it('POST /api/tickets/:id/plan/approve writes plan', async () => {
    await seedProjectPlanTicket();
    const router = createWriteRouter(testDir);
    const response = await invokeRoute(
      router,
      'post',
      '/api/tickets/:id/plan/approve',
      { id: 'PP-1' },
      {},
    );
    expect(response.statusCode).toBe(200);
    const ticket = (response.payload as { ticket: { status: string } }).ticket ?? (response.payload as any).ticket;
    expect(ticket.status).toBe('ready_to_implement');

    const content = await readFile(
      resolve(testDir, 'plan-project', 'tickets', 'PP-1-plan-ticket', 'ticket.md'),
      'utf-8',
    );
    const fm = parseTicketFrontmatter(content);
    expect(fm.plan?.file).toBe('plan.md');
    expect(fm.plan?.approvedDigest).toBe(planDigest('# Plan body\n'));
  });

  it('POST /api/tickets/:id/plan/approve returns 409 without a plan file', async () => {
    await seedProjectPlanTicket({ withPlan: false });
    const router = createWriteRouter(testDir);
    const response = await invokeRoute(
      router,
      'post',
      '/api/tickets/:id/plan/approve',
      { id: 'PP-1' },
      {},
    );
    expect(response.statusCode).toBe(409);
    expect((response.payload as { error: string }).error).toContain('No plan file');
  });

  it('POST /api/tickets/:id/plan/approve returns 404 for unknown ticket', async () => {
    const router = createWriteRouter(testDir);
    const response = await invokeRoute(
      router,
      'post',
      '/api/tickets/:id/plan/approve',
      { id: 'missing-plan-id' },
      {},
    );
    expect(response.statusCode).toBe(404);
  });

});
