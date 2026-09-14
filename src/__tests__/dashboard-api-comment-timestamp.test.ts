import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { RequestHandler, Router } from 'express';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createWriteRouter } from '../dashboard/api-write.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-comment-ts-test-'));
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
  const layer = (router as unknown as {
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
  method: 'post',
  path: string,
  params: Record<string, string>,
  body: unknown,
): Promise<MockResponse> {
  const handler = getRouteHandler(router, method, path);
  const response = createMockResponse();
  await handler({ params, body, query: {} } as any, response as any, (() => undefined) as any);
  return response;
}

const TICKET_ID = 'TST-1';

async function createTicketFixture(): Promise<void> {
  const projectDir = resolve(testDir, 'test-project');
  const ticketDir = resolve(projectDir, 'tickets', `${TICKET_ID}-test-ticket`);
  await mkdir(ticketDir, { recursive: true });

  await writeFile(resolve(projectDir, 'project.md'), `---
id: project-1
slug: test-project
title: Test Project
archived: false
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
tags: []
---

# Test Project`, 'utf-8');

  await writeFile(resolve(ticketDir, 'ticket.md'), `---
id: ${TICKET_ID}
slug: test-ticket
title: Test Ticket
status: backlog
priority: medium
blocked: null
parked: null
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
assignee: codex-1
depends_on: []
links: []
workspace:
  repository: null
  worktree: null
  branch: null
  parentBranch: null
tags: []
plan:
  file: null
  approvedDigest: null
  approvedAt: null
  approvedBy: null
---

# Test Ticket`, 'utf-8');
}

describe('B5 — comment write produces a single YAML-quoted updated timestamp', () => {
  it('writes updated: "<iso>" — not a double-encoded updated: "\\"<iso>\\""', async () => {
    await createTicketFixture();
    const router = createWriteRouter(testDir);

    const res = await invokeRoute(
      router,
      'post',
      '/api/tickets/:id/comments',
      { id: TICKET_ID },
      { body: 'first comment', author: 'human', type: 'note' },
    );
    expect(res.statusCode).toBe(201);

    const commentsPath = resolve(
      testDir,
      'test-project',
      'tickets',
      `${TICKET_ID}-test-ticket`,
      'comments.md',
    );
    const content = await readFile(commentsPath, 'utf-8');
    const match = content.match(/^updated:\s*(.*)$/m);
    expect(match).not.toBeNull();
    const raw = match![1].trim();

    // Exactly one YAML-quoted ISO value: updated: "2026-...Z"
    expect(raw).toMatch(/^"\d{4}-\d{2}-\d{2}T[\d:.]+Z"$/);
    // NOT double-encoded: must not contain an escaped inner quote.
    expect(raw).not.toContain('\\"');
    expect(content).not.toMatch(/updated:\s*"\\"/);
  });
});
