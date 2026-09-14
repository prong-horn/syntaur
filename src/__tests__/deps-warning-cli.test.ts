import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { parseTicketFrontmatter } from '../lifecycle/frontmatter.js';

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

function ticketMd(id: string, slug: string, depends_on: string[]): string {
  const depsYaml =
    depends_on.length === 0 ? 'depends_on: []' : `depends_on:\n${depends_on.map((d) => `  - ${d}`).join('\n')}`;
  return `---
id: ${id}
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
    await writeFile(join(home, 'projects', 'p1', 'project.md'), '---\nslug: p1\nprefix: DEP\nnextTicket: 3\n---\n# P1\n');
    const depDir = join(home, 'projects', 'p1', 'tickets', 'DEP-1-dep-a');
    await mkdir(depDir, { recursive: true });
    await writeFile(join(depDir, 'ticket.md'), ticketMd('DEP-1', 'dep-a', []));
    const mainDir = join(home, 'projects', 'p1', 'tickets', 'MAIN-1-main');
    await mkdir(mainDir, { recursive: true });
    mainPath = join(mainDir, 'ticket.md');
    await writeFile(mainPath, ticketMd('MAIN-1', 'main', ['DEP-1']));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function fm() {
    return parseTicketFrontmatter(await readFile(mainPath, 'utf-8'));
  }

  it('implement warns about unmet deps but still succeeds and asserts implementationStarted', async () => {
    const r = await runCli(['implement', 'MAIN-1', '--project', 'p1'], home);
    expect(r.code).toBe(0);
    expect(r.stderr.toLowerCase()).toContain('unmet depend');
    expect(r.stderr).toContain('DEP-1');
    expect((await fm()).implementationStarted).toBe(true);
  });

  it('start also warns about unmet deps but still succeeds', async () => {
    const r = await runCli(['start', 'MAIN-1', '--project', 'p1'], home);
    expect(r.code).toBe(0);
    expect(r.stderr.toLowerCase()).toContain('unmet depend');
    expect((await fm()).implementationStarted).toBe(true);
  });

  it('no warning when the dependency is terminal (completed)', async () => {
    const depPath = join(home, 'projects', 'p1', 'tickets', 'DEP-1-dep-a', 'ticket.md');
    const depContent = await readFile(depPath, 'utf-8');
    await writeFile(depPath, depContent.replace('status: draft', 'status: completed'));

    const r = await runCli(['implement', 'MAIN-1', '--project', 'p1'], home);
    expect(r.code).toBe(0);
    expect(r.stderr.toLowerCase()).not.toContain('unmet depend');
    expect((await fm()).implementationStarted).toBe(true);
  });
});
