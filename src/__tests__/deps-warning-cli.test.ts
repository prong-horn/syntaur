import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { parseAssignmentFrontmatter } from '../lifecycle/frontmatter.js';

const CLI_ENTRY = resolve(__dirname, '..', '..', 'bin', 'syntaur.js');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], syntaurHome: string): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env: { ...process.env, SYNTAUR_HOME: syntaurHome },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

function assignmentMd(slug: string, dependsOn: string[]): string {
  // The frontmatter parser supports `dependsOn: []` (empty inline) or YAML
  // block style — NOT inline non-empty arrays. Emit block style when present.
  const depsYaml =
    dependsOn.length === 0 ? 'dependsOn: []' : `dependsOn:\n${dependsOn.map((d) => `  - ${d}`).join('\n')}`;
  return `---
id: ${slug}-id
slug: ${slug}
title: "${slug}"
project: p1
status: draft
priority: medium
created: "2026-06-09T10:00:00Z"
updated: "2026-06-09T10:00:00Z"
assignee: null
externalIds: []
${depsYaml}
links: []
blockedReason: null
workspace:
  repository: /repo
  worktreePath: null
  branch: feat/x
  parentBranch: main
tags: []
---

# ${slug}

## Objective

A real objective.

## Acceptance Criteria

- [ ] Criterion one
`;
}

describe('deps warning on start/implement (non-blocking)', () => {
  let home: string;
  let mainPath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-deps-'));
    await writeFile(
      join(home, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(home, 'projects')}\n---\n`,
    );
    await mkdir(join(home, 'projects', 'p1'), { recursive: true });
    await writeFile(join(home, 'projects', 'p1', 'project.md'), '---\nslug: p1\n---\n# P1\n');
    // Dependency assignment, NOT terminal (status: draft).
    const depDir = join(home, 'projects', 'p1', 'assignments', 'dep-a');
    await mkdir(depDir, { recursive: true });
    await writeFile(join(depDir, 'assignment.md'), assignmentMd('dep-a', []));
    // Main assignment depends on dep-a.
    const mainDir = join(home, 'projects', 'p1', 'assignments', 'main');
    await mkdir(mainDir, { recursive: true });
    mainPath = join(mainDir, 'assignment.md');
    await writeFile(mainPath, assignmentMd('main', ['dep-a']));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function fm() {
    return parseAssignmentFrontmatter(await readFile(mainPath, 'utf-8'));
  }

  it('implement warns about unmet deps but still succeeds and asserts implementationStarted', async () => {
    const r = await runCli(['implement', 'main', '--project', 'p1'], home);
    expect(r.code).toBe(0);
    expect(r.stderr.toLowerCase()).toContain('unmet depend');
    expect(r.stderr).toContain('dep-a');
    expect((await fm()).implementationStarted).toBe(true);
  });

  it('start also warns about unmet deps but still succeeds', async () => {
    const r = await runCli(['start', 'main', '--project', 'p1'], home);
    expect(r.code).toBe(0);
    expect(r.stderr.toLowerCase()).toContain('unmet depend');
    expect((await fm()).implementationStarted).toBe(true);
  });

  it('no warning when the dependency is terminal (completed)', async () => {
    // Mark dep-a completed so the dependency is satisfied.
    const depPath = join(home, 'projects', 'p1', 'assignments', 'dep-a', 'assignment.md');
    const depContent = await readFile(depPath, 'utf-8');
    await writeFile(depPath, depContent.replace('status: draft', 'status: completed'));

    const r = await runCli(['implement', 'main', '--project', 'p1'], home);
    expect(r.code).toBe(0);
    expect(r.stderr.toLowerCase()).not.toContain('unmet depend');
    expect((await fm()).implementationStarted).toBe(true);
  });
});
