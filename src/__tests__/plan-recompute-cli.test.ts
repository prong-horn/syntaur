import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { parseAssignmentFrontmatter } from '../lifecycle/frontmatter.js';

const CLI_ENTRY = resolve(__dirname, '..', '..', 'bin', 'syntaur.js');

async function runCli(args: string[], home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
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
id: pr-test-id
slug: pr-test
title: "Plan Recompute Test"
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

# Plan Recompute Test

## Objective

A real objective.

## Acceptance Criteria

- [ ] Criterion one

## Todos
`;

describe('plan create/version recompute derived status at the source', () => {
  let home: string;
  let aPath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-planrc-'));
    await writeFile(
      join(home, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(home, 'projects')}\n---\n`,
    );
    const aDir = join(home, 'projects', 'p1', 'assignments', 'pr-test');
    await mkdir(aDir, { recursive: true });
    await writeFile(join(home, 'projects', 'p1', 'project.md'), '---\nslug: p1\n---\n# P1\n');
    aPath = join(aDir, 'assignment.md');
    await writeFile(aPath, ASSIGNMENT);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function status(): Promise<string> {
    return parseAssignmentFrontmatter(await readFile(aPath, 'utf-8')).status;
  }

  it('plan version invalidates approval and the derived status drops immediately (no manual recompute)', async () => {
    // Get to an approved plan: recompute → ready_for_planning, plan create, approve → ready_to_implement.
    await runCli(['recompute', 'pr-test', '--project', 'p1'], home);
    await runCli(['plan', 'create', '--assignment', 'pr-test', '--project', 'p1'], home);
    await runCli(['plan', 'approve', 'pr-test', '--project', 'p1'], home);
    expect(await status()).toBe('ready_to_implement');

    // A new plan version invalidates the approval (latest plan file no longer
    // matches planApproval.file). Without recompute-at-source the status would
    // stay 'ready_to_implement' (stale); with it, it drops immediately.
    await runCli(['plan', 'version', '--assignment', 'pr-test', '--project', 'p1'], home);
    expect(await status()).toBe('ready_for_planning');
  });
});
