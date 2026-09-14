import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const CLI_ENTRY = resolve(__dirname, '..', '..', 'bin', 'syntaur.js');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], home: string): Promise<RunResult> {
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

const TICKET = `---
id: TP-1
slug: slug
title: "Example"
status: backlog
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
---
# Example

## Todos

- [ ] Something
`;

const PROGRESS = `---
ticket: slug
entryCount: 0
generated: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
---

# Progress

No progress yet.
`;

describe('CLI --ticket by id', () => {
  let home: string;
  let ticketDir: string;
  let ticketPath: string;
  let progressPath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-ticket-target-cmd-'));
    await writeFile(
      resolve(home, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(home, 'projects')}\n---\n`,
      'utf-8',
    );
    ticketDir = resolve(home, 'projects', 'p', 'tickets', 'TP-1-slug');
    ticketPath = resolve(ticketDir, 'ticket.md');
    progressPath = resolve(ticketDir, 'progress.md');
    await mkdir(ticketDir, { recursive: true });
    await writeFile(
      resolve(home, 'projects', 'p', 'project.md'),
      '---\nslug: p\ntitle: "P"\nprefix: TP\nnextTicket: 2\n---\n# P\n',
      'utf-8',
    );
    await writeFile(ticketPath, TICKET, 'utf-8');
    await writeFile(progressPath, PROGRESS, 'utf-8');
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('plan create resolves --ticket TP-1 without --project', async () => {
    const r = await runCli(['plan', 'create', '--ticket', 'TP-1'], home);
    expect(r.code, r.stderr).toBe(0);
    const plan = await readFile(resolve(ticketDir, 'plan.md'), 'utf-8');
    expect(plan).toContain('# slug — Implementation Plan');
  });

  it('progress log resolves --ticket TP-1 without --project', async () => {
    const r = await runCli(['progress', 'log', 'By ticket id', '--ticket', 'TP-1'], home);
    expect(r.code, r.stderr).toBe(0);
    const content = await readFile(progressPath, 'utf-8');
    expect(content).toContain('By ticket id');
    expect(content).toContain('entryCount: 1');
  });

  it('workspace set resolves --ticket TP-1 without --project', async () => {
    const r = await runCli(
      ['workspace', 'set', '--ticket', 'TP-1', '--branch', 'feat-by-id'],
      home,
    );
    expect(r.code, r.stderr).toBe(0);
    const content = await readFile(ticketPath, 'utf-8');
    expect(content).toContain('branch: feat-by-id');
  });
});
