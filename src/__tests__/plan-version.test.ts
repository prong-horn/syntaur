import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const CLI_ENTRY = resolve(__dirname, '..', '..', 'bin', 'syntaur.js');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], cwd: string, syntaurHome: string): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd,
      env: { ...process.env, SYNTAUR_HOME: syntaurHome },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

const ASSIGNMENT_MD = `---
id: abc-1
slug: demo
title: "Demo"
project: p
status: in_progress
priority: medium
created: "2026-04-23T12:00:00Z"
updated: "2026-04-23T12:00:00Z"
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# Demo

## Todos

- [x] Create [plan](./plan.md)
- [x] Review [plan](./plan.md)
- [ ] Implement [plan](./plan.md)
- [ ] Review implementation of [plan](./plan.md)

## Links

- [Progress](./progress.md)
`;

const PLAN_MD = `---
assignment: demo
status: in_progress
created: "2026-04-23T12:00:00Z"
updated: "2026-04-23T12:00:00Z"
---

# Demo plan

## Tasks

- [ ] First task
- [x] Second task done
- [ ] Third task

## Verification

Run.
`;

describe('syntaur plan version', () => {
  let syntaurHome: string;
  let projectsDir: string;
  let assignmentDir: string;

  beforeEach(async () => {
    syntaurHome = await mkdtemp(join(tmpdir(), 'syntaur-planv-'));
    projectsDir = resolve(syntaurHome, 'projects');
    await mkdir(projectsDir, { recursive: true });
    await writeFile(
      resolve(syntaurHome, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\nonboarding:\n  completed: true\n---\n`,
    );
    assignmentDir = resolve(projectsDir, 'p', 'assignments', 'demo');
    await mkdir(assignmentDir, { recursive: true });
    await writeFile(resolve(assignmentDir, 'assignment.md'), ASSIGNMENT_MD);
    await writeFile(resolve(assignmentDir, 'plan.md'), PLAN_MD);
  });

  afterEach(async () => {
    await rm(syntaurHome, { recursive: true, force: true });
  });

  it('creates plan-v2.md and rewrites assignment.md ## Todos with the four-todo cycle', async () => {
    const result = await runCli(
      ['plan', 'version', '--assignment', 'demo', '--project', 'p'],
      syntaurHome,
      syntaurHome,
    );
    expect(result.code, result.stderr).toBe(0);

    const planV2 = await readFile(resolve(assignmentDir, 'plan-v2.md'), 'utf-8');
    expect(planV2).toContain('Implementation Plan v2');
    expect(planV2).toContain('Supersedes:');
    expect(planV2).toContain('- [ ] First task');
    expect(planV2).toContain('- [ ] Third task');
    // Checked items from prior plan are NOT carried forward.
    expect(planV2).not.toContain('Second task done');

    const assignment = await readFile(resolve(assignmentDir, 'assignment.md'), 'utf-8');
    // All four prior todos rewritten with strikethrough + superseded tag.
    expect(assignment).toMatch(/- \[x\] ~~Create \[plan\]\(\.\/plan\.md\)~~ \(superseded by plan-v2\)/);
    expect(assignment).toMatch(/- \[x\] ~~Review \[plan\]\(\.\/plan\.md\)~~ \(superseded by plan-v2\)/);
    expect(assignment).toMatch(/- \[x\] ~~Implement \[plan\]\(\.\/plan\.md\)~~ \(superseded by plan-v2\)/);
    expect(assignment).toMatch(
      /- \[x\] ~~Review implementation of \[plan\]\(\.\/plan\.md\)~~ \(superseded by plan-v2\)/,
    );
    // Fresh four-todo cycle pointing at plan-v2.md.
    expect(assignment).toContain('- [ ] Create [plan v2](./plan-v2.md)');
    expect(assignment).toContain('- [ ] Review [plan v2](./plan-v2.md)');
    expect(assignment).toContain('- [ ] Implement [plan v2](./plan-v2.md)');
    expect(assignment).toContain(
      '- [ ] Review implementation of [plan v2](./plan-v2.md)',
    );
    // Original todos are still present (never deleted).
    expect(assignment.match(/Create \[plan\]/g)?.length).toBe(1);
  });

  it('picks plan-v3.md when plan-v2.md already exists (no clobber)', async () => {
    await writeFile(resolve(assignmentDir, 'plan-v2.md'), 'existing v2 body');
    const result = await runCli(
      ['plan', 'version', '--assignment', 'demo', '--project', 'p'],
      syntaurHome,
      syntaurHome,
    );
    expect(result.code, result.stderr).toBe(0);
    const v2 = await readFile(resolve(assignmentDir, 'plan-v2.md'), 'utf-8');
    expect(v2).toBe('existing v2 body');
    const v3 = await readFile(resolve(assignmentDir, 'plan-v3.md'), 'utf-8');
    expect(v3).toContain('Implementation Plan v3');
  });
});
