import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { parseAssignmentFrontmatter } from '../lifecycle/frontmatter.js';

const CLI_ENTRY = resolve(__dirname, '..', '..', 'bin', 'syntaur.js');

async function runCli(
  args: string[],
  home: string,
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd,
      env: { ...process.env, SYNTAUR_HOME: home },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => res({ code: code ?? -1, stdout, stderr }));
  });
}

const ASSIGNMENT = `---
id: ctx-test-id
slug: ctx-test
title: "Context Recompute Test"
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

# Context Recompute Test

## Objective

A real objective.

## Acceptance Criteria

- [ ] Criterion one
`;

describe('syntaur recompute resolves the assignment from cwd .syntaur/context.json', () => {
  let home: string;
  let workspace: string;
  let aPath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-rcctx-'));
    await writeFile(
      join(home, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(home, 'projects')}\n---\n`,
    );
    const aDir = join(home, 'projects', 'p1', 'assignments', 'ctx-test');
    await mkdir(aDir, { recursive: true });
    await writeFile(join(home, 'projects', 'p1', 'project.md'), '---\nslug: p1\n---\n# P1\n');
    aPath = join(aDir, 'assignment.md');
    await writeFile(aPath, ASSIGNMENT);

    // A separate "workspace" cwd bound to the assignment via context.json.
    workspace = await mkdtemp(join(tmpdir(), 'syntaur-ws-'));
    await mkdir(join(workspace, '.syntaur'), { recursive: true });
    await writeFile(
      join(workspace, '.syntaur', 'context.json'),
      JSON.stringify({ projectSlug: 'p1', assignmentSlug: 'ctx-test', assignmentDir: aDir }),
    );
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  async function status(): Promise<string> {
    return parseAssignmentFrontmatter(await readFile(aPath, 'utf-8')).status;
  }

  it('recompute with no positional arg resolves from context.json and recomputes', async () => {
    const r = await runCli(['recompute'], home, workspace);
    expect(r.code).toBe(0);
    // draft + real objective + ACs derives to ready_for_planning.
    expect(await status()).toBe('ready_for_planning');
  });

  it('--if-migrated is a no-op when the migration marker is absent (D6 gate)', async () => {
    const r = await runCli(['recompute', '--if-migrated'], home, workspace);
    expect(r.code).toBe(0);
    // No derive-migrated marker → gated implicit trigger does nothing.
    expect(await status()).toBe('draft');
  });

  it('--if-migrated runs once the migration marker is present', async () => {
    await writeFile(join(home, 'derive-migrated'), '2026-06-17T00:00:00Z\n');
    const r = await runCli(['recompute', '--if-migrated'], home, workspace);
    expect(r.code).toBe(0);
    expect(await status()).toBe('ready_for_planning');
  });
});
