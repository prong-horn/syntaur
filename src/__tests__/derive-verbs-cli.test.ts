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

describe('derived-status CLI verbs (end-to-end)', () => {
  let home: string;
  let ticketPath: string;
  let ticketFolder: string;

  const TICKET = `---
id: VRB-1
slug: verb-test
title: "Verb Test"
project: p1
template: legacy
status: draft
priority: medium
created: "2026-06-09T10:00:00Z"
updated: "2026-06-09T10:00:00Z"
assignee: null
externalIds: []
depends_on: []
links: []
blockedReason: null
workspace:
  repository: /repo
  worktreePath: null
  branch: feat/x
  parentBranch: main
tags: []
---

# Verb Test

## Objective

A real objective.

## Acceptance Criteria

- [ ] Criterion one
- [ ] Criterion two
`;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-verbs-'));
    await writeFile(
      join(home, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(home, 'projects')}\n---\n`,
    );
    ticketFolder = join(home, 'projects', 'p1', 'tickets', 'VRB-1-verb-test');
    await mkdir(ticketFolder, { recursive: true });
    await writeFile(join(home, 'projects', 'p1', 'project.md'), '---\nslug: p1\nprefix: VRB\nnextTicket: 2\n---\n# P1\n');
    ticketPath = join(ticketFolder, 'ticket.md');
    await writeFile(ticketPath, TICKET);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function fm() {
    return parseTicketFrontmatter(await readFile(ticketPath, 'utf-8'));
  }

  it('the full forward flow: recompute → approve → implement → review', async () => {
    // recompute: real objective + ACs → ready_for_planning
    let r = await runCli(['recompute', 'VRB-1', '--project', 'p1'], home);
    expect(r.code).toBe(0);
    expect((await fm()).status).toBe('ready_for_planning');

    // plan approve requires a plan file
    r = await runCli(['plan', 'approve', 'VRB-1', '--project', 'p1'], home);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('No plan file');

    await writeFile(join(ticketFolder, 'plan.md'), '# Plan');
    r = await runCli(['plan', 'approve', 'VRB-1', '--project', 'p1'], home);
    expect(r.code).toBe(0);
    let f = await fm();
    expect(f.status).toBe('ready_to_implement'); // the motivating rule
    expect(f.plan?.file).toBe('plan.md');

    // implement asserts the fact; derived → in_progress
    r = await runCli(['implement', 'VRB-1', '--project', 'p1'], home);
    expect(r.code).toBe(0);
    f = await fm();
    expect(f.status).toBe('in_progress');
    expect(f.implementationStarted).toBe(true);

    // request review → review phase
    r = await runCli(['request-review', 'VRB-1', '--project', 'p1'], home);
    expect(r.code).toBe(0);
    expect((await fm()).status).toBe('review');

    // history recorded each dimension change exactly once per change
    const history = (await fm()).statusHistory;
    expect(history.map((e) => e.to)).toEqual([
      'ready_for_planning',
      'ready_to_implement',
      'in_progress',
      'review',
    ]);
  });

  it('block/unblock are fact verbs: phase survives the blockade', async () => {
    await runCli(['recompute', 'VRB-1', '--project', 'p1'], home);
    let r = await runCli(['block', 'VRB-1', '--project', 'p1', '--reason', 'vendor down'], home);
    expect(r.code).toBe(0);
    let f = await fm();
    expect(f.status).toBe('blocked');
    expect(f.phase).toBe('ready_for_planning'); // orthogonal: not erased
    expect(f.blockedReason).toBe('vendor down');

    r = await runCli(['unblock', 'VRB-1', '--project', 'p1'], home);
    expect(r.code).toBe(0);
    f = await fm();
    expect(f.status).toBe('ready_for_planning'); // self-cleared back to facts
    expect(f.blockedReason).toBeNull();
  });

  it('pin/unpin: sticky override with divergence, terminal targets refused', async () => {
    await runCli(['recompute', 'VRB-1', '--project', 'p1'], home);

    let r = await runCli(['status', 'pin', 'VRB-1', 'completed', '--project', 'p1'], home);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('terminal');

    r = await runCli(
      ['status', 'pin', 'VRB-1', 'in_progress', '--project', 'p1', '--reason', 'forcing'],
      home,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('would otherwise be ready_for_planning');
    let f = await fm();
    expect(f.status).toBe('in_progress');
    expect(f.override?.status).toBe('in_progress');

    r = await runCli(['status', 'unpin', 'VRB-1', '--project', 'p1'], home);
    expect(r.code).toBe(0);
    f = await fm();
    expect(f.status).toBe('ready_for_planning');
    expect(f.override).toBeNull();
  });

  it('park/unpark; terminal tickets freeze facts', async () => {
    let r = await runCli(['park', 'VRB-1', '--project', 'p1'], home);
    expect(r.code).toBe(0);
    // no 'parked' status defined → headline falls back to phase
    let f = await fm();
    expect(f.parked).toBe(true);

    r = await runCli(['unpark', 'VRB-1', '--project', 'p1'], home);
    expect((await fm()).parked).toBe(false);

    // complete (gated) then try a fact verb → refused
    await runCli(['complete', 'VRB-1', '--project', 'p1'], home);
    expect((await fm()).status).toBe('completed');
    r = await runCli(['park', 'VRB-1', '--project', 'p1'], home);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('terminal');
  });

  it('migrate-derive seeds facts and reports divergence', async () => {
    // simulate a legacy in-flight ticket: command-set status, no facts
    let content = await readFile(ticketPath, 'utf-8');
    content = content.replace('status: draft', 'status: in_progress');
    await writeFile(ticketPath, content);
    await writeFile(join(ticketFolder, 'plan.md'), '# Plan');

    const dry = await runCli(['migrate-derive', '--dry-run'], home);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain('[dry-run]');
    // dry-run must not write
    expect((await fm()).implementationStarted).toBe(false);

    const real = await runCli(['migrate-derive'], home);
    expect(real.code).toBe(0);
    const f = await fm();
    expect(f.implementationStarted).toBe(true); // seeded from in_progress
    // plan exists but never approved → derived regresses and the report says so
    expect(f.status).toBe('ready_for_planning');
    expect(real.stdout).toContain('in_progress → ready_for_planning');
  });

  it('ls --query filters on facts and dimensions', async () => {
    await runCli(['recompute', 'VRB-1', '--project', 'p1'], home);
    await runCli(['block', 'VRB-1', '--project', 'p1', '--reason', 'x'], home);

    let r = await runCli(
      ['ls', '--query', 'disposition:blocked AND phase:ready_for_planning', '--json'],
      home,
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).tickets).toHaveLength(1);

    r = await runCli(['ls', '--query', 'planApproved:true', '--json'], home);
    expect(JSON.parse(r.stdout).tickets).toHaveLength(0);

    r = await runCli(['ls', '--query', 'bogus:true', '--json'], home);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('Unknown field');
  });
});
