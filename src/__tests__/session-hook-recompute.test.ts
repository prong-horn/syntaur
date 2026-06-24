import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { parseAssignmentFrontmatter } from '../lifecycle/frontmatter.js';
import { initSessionDb, resetSessionDb } from '../dashboard/session-db.js';
import { openEngagement } from '../db/engagement-db.js';

const CLI_ENTRY = resolve(__dirname, '..', '..', 'bin', 'syntaur.js');
const REPO_ROOT = resolve(__dirname, '..', '..');
const CLAUDE_HOOK = resolve(REPO_ROOT, 'platforms/claude-code/hooks/session-cleanup.sh');
const CODEX_HOOK = resolve(REPO_ROOT, 'platforms/codex/scripts/session-cleanup.sh');

const ASSIGNMENT = `---
id: hook-test-id
slug: hook-test
title: "Hook Recompute Test"
project: p1
status: draft
priority: medium
created: "2026-06-09T10:00:00Z"
updated: "2026-06-09T10:00:00Z"
assignee: null
externalIds: []
dependsOn: []
links: []
blockedReason: null
workspace:
  repository: /repo
  worktreePath: null
  branch: feat/x
  parentBranch: main
tags: []
---

# Hook Recompute Test

## Objective

A real objective.

## Acceptance Criteria

- [ ] Criterion one
`;

interface Ctx {
  home: string;
  workspace: string;
  binDir: string;
  aPath: string;
}

async function setup(withMarker: boolean): Promise<Ctx> {
  const home = await mkdtemp(join(tmpdir(), 'syntaur-hook-'));
  await writeFile(
    join(home, 'config.md'),
    `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(home, 'projects')}\n---\n`,
  );
  const aDir = join(home, 'projects', 'p1', 'assignments', 'hook-test');
  await mkdir(aDir, { recursive: true });
  await writeFile(join(home, 'projects', 'p1', 'project.md'), '---\nslug: p1\n---\n# P1\n');
  const aPath = join(aDir, 'assignment.md');
  await writeFile(aPath, ASSIGNMENT);
  if (withMarker) await writeFile(join(home, 'derive-migrated'), '2026-06-17T00:00:00Z\n');

  // Seed the session DB the hook subprocess reads ($SYNTAUR_HOME/syntaur.db):
  // open an engagement for session 'abc' (the payload's session_id) bound to the
  // assignment. recompute is keyed on this engagement via --session-id — the
  // open-else-latest read recovers it even after the hook's `session stop`
  // closes it. resetSessionDb()/close so the file flushes and the subprocess
  // opens it fresh. The not-migrated test also seeds it, so the ONLY thing
  // gating recompute there is the missing --if-migrated marker, not the target.
  const dbPath = resolve(home, 'syntaur.db');
  const db = initSessionDb(dbPath);
  openEngagement({
    sessionId: 'abc',
    assignmentId: 'hook-test-id',
    projectSlug: 'p1',
    assignmentSlug: 'hook-test',
    stage: 'implement',
    startedAt: '2026-06-18T00:00:00Z',
  });
  db.close();
  resetSessionDb();

  const workspace = await mkdtemp(join(tmpdir(), 'syntaur-hookws-'));
  await mkdir(join(workspace, '.syntaur'), { recursive: true });
  await writeFile(
    join(workspace, '.syntaur', 'context.json'),
    JSON.stringify({ projectSlug: 'p1', assignmentSlug: 'hook-test', assignmentDir: aDir }),
  );

  // A `syntaur` shim on PATH that execs the worktree's built CLI.
  const binDir = await mkdtemp(join(tmpdir(), 'syntaur-bin-'));
  const shim = join(binDir, 'syntaur');
  await writeFile(shim, `#!/usr/bin/env bash\nexec "${process.execPath}" "${CLI_ENTRY}" "$@"\n`);
  await chmod(shim, 0o755);

  return { home, workspace, binDir, aPath };
}

async function runHook(hook: string, ctx: Ctx): Promise<number> {
  return new Promise((res) => {
    const child = spawn('bash', [hook], {
      env: {
        ...process.env,
        PATH: `${ctx.binDir}:${process.env.PATH ?? ''}`,
        SYNTAUR_HOME: ctx.home,
      },
    });
    child.stdin.end(JSON.stringify({ cwd: ctx.workspace, session_id: 'abc' }));
    child.on('close', (code) => res(code ?? -1));
  });
}

describe('SessionEnd hooks recompute derived status (migration-gated, bounded)', () => {
  let ctxs: Ctx[] = [];
  afterEach(async () => {
    for (const c of ctxs) {
      await rm(c.home, { recursive: true, force: true });
      await rm(c.workspace, { recursive: true, force: true });
      await rm(c.binDir, { recursive: true, force: true });
    }
    ctxs = [];
  });

  async function status(aPath: string): Promise<string> {
    return parseAssignmentFrontmatter(await readFile(aPath, 'utf-8')).status;
  }

  it('claude hook recomputes when migrated and exits 0', async () => {
    const ctx = await setup(true);
    ctxs.push(ctx);
    const code = await runHook(CLAUDE_HOOK, ctx);
    expect(code).toBe(0);
    expect(await status(ctx.aPath)).toBe('ready_for_planning');
  });

  it('claude hook is a no-op when not migrated (still exits 0)', async () => {
    const ctx = await setup(false);
    ctxs.push(ctx);
    const code = await runHook(CLAUDE_HOOK, ctx);
    expect(code).toBe(0);
    expect(await status(ctx.aPath)).toBe('draft');
  });

  it('codex hook recomputes when migrated and exits 0', async () => {
    const ctx = await setup(true);
    ctxs.push(ctx);
    const code = await runHook(CODEX_HOOK, ctx);
    expect(code).toBe(0);
    expect(await status(ctx.aPath)).toBe('ready_for_planning');
  });
});
