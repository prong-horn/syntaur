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

async function createAssignmentFixture(): Promise<void> {
  const projectDir = resolve(testDir, 'test-project');
  const assignmentDir = resolve(projectDir, 'assignments', 'test-assignment');
  await mkdir(assignmentDir, { recursive: true });

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
}

describe('B5 — comment write produces a single YAML-quoted updated timestamp', () => {
  it('writes updated: "<iso>" — not a double-encoded updated: "\\"<iso>\\""', async () => {
    await createAssignmentFixture();
    const router = createWriteRouter(testDir);

    const res = await invokeRoute(
      router,
      'post',
      '/api/projects/:slug/assignments/:aslug/comments',
      { slug: 'test-project', aslug: 'test-assignment' },
      { body: 'first comment', author: 'human', type: 'note' },
    );
    expect(res.statusCode).toBe(201);

    const commentsPath = resolve(
      testDir,
      'test-project',
      'assignments',
      'test-assignment',
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
