import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { parseTicketFrontmatter } from '../lifecycle/frontmatter.js';
import { seedMissingBuiltins } from '../ticket-templates/builtins.js';

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

function featureTicketMd(
  id: string,
  slug: string,
  status: string,
  depends_on: string[],
  opts: { approved?: boolean; workspace?: boolean } = {},
): string {
  const planBody = '# Plan\n\nApproved implementation plan.\n';
  const digest = createHash('sha256').update(planBody, 'utf-8').digest('hex');
  const depsYaml =
    depends_on.length === 0
      ? 'depends_on: []'
      : `depends_on:\n${depends_on.map((d) => `  - ${d}`).join('\n')}`;
  const workspaceYaml = opts.workspace
    ? `workspace:
  repository: /repo
  branch: feat/x
  worktree: /repo/wt
  parentBranch: main`
    : `workspace:
  repository: null
  branch: null
  worktree: null
  parentBranch: null`;
  return `---
id: ${id}
slug: ${slug}
title: "${slug}"
project: p1
template: feature
status: ${status}
priority: medium
created: "2026-06-09T10:00:00Z"
updated: "2026-06-09T10:00:00Z"
assignee: null
${depsYaml}
links: []
blocked: null
parked: null
plan:
  file: plan.md
  approvedDigest: ${opts.approved ? digest : 'null'}
  approvedAt: ${opts.approved ? '"2026-06-09T10:00:00Z"' : 'null'}
  approvedBy: ${opts.approved ? 'human' : 'null'}
${workspaceYaml}
tags: []
---

# ${slug}

## Objective

A real objective.

## Acceptance Criteria

- [x] Criterion one
`;
}

describe('deps-done gate on start', () => {
  let home: string;
  let mainPath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-deps-'));
    await seedMissingBuiltins(home);
    await writeFile(
      join(home, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(home, 'projects')}\n---\n`,
    );
    await mkdir(join(home, 'projects', 'p1'), { recursive: true });
    await writeFile(join(home, 'projects', 'p1', 'project.md'), '---\nslug: p1\nprefix: DEP\nnextTicket: 3\n---\n# P1\n');
    const depDir = join(home, 'projects', 'p1', 'tickets', 'DEP-1-dep-a');
    await mkdir(depDir, { recursive: true });
    await writeFile(join(depDir, 'ticket.md'), featureTicketMd('DEP-1', 'dep-a', 'backlog', []));
    await writeFile(join(depDir, 'plan.md'), '# Plan\n\nBody.\n', 'utf-8');
    const mainDir = join(home, 'projects', 'p1', 'tickets', 'MAIN-1-main');
    await mkdir(mainDir, { recursive: true });
    mainPath = join(mainDir, 'ticket.md');
    await writeFile(
      mainPath,
      featureTicketMd('MAIN-1', 'main', 'ready', ['DEP-1'], { approved: true, workspace: true }),
    );
    await writeFile(join(mainDir, 'plan.md'), '# Plan\n\nApproved implementation plan.\n', 'utf-8');
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function fm() {
    return parseTicketFrontmatter(await readFile(mainPath, 'utf-8'));
  }

  it('start fails the deps-done gate when a dependency is not done', async () => {
    const r = await runCli(['start', 'MAIN-1', '--project', 'p1'], home);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('deps-done');
    expect(r.stderr).toContain('DEP-1');
    expect((await fm()).status).toBe('ready');
  });

  it('start succeeds when the dependency is done', async () => {
    const depPath = join(home, 'projects', 'p1', 'tickets', 'DEP-1-dep-a', 'ticket.md');
    const depContent = await readFile(depPath, 'utf-8');
    await writeFile(depPath, depContent.replace('status: backlog', 'status: done'));

    const r = await runCli(['start', 'MAIN-1', '--project', 'p1'], home);
    expect(r.code).toBe(0);
    expect((await fm()).status).toBe('in_progress');
  });

  it('start with --force skips deps-done and moves anyway', async () => {
    const r = await runCli(['start', 'MAIN-1', '--project', 'p1', '--force'], home);
    expect(r.code).toBe(0);
    expect((await fm()).status).toBe('in_progress');
  });
});
