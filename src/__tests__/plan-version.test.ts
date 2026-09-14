import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { seedMissingBuiltins } from '../ticket-templates/builtins.js';
import { fileExists } from '../utils/fs.js';
import {
  closeEventsDb,
  initEventsDb,
  listEventsByTicket,
  resetEventsDb,
} from '../db/events-db.js';
import { parseTicketFrontmatter } from '../lifecycle/frontmatter.js';

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

const TICKET_MD = `---
id: PD-1
slug: demo
title: "Demo"
project: p
template: legacy
status: backlog
priority: medium
created: "2026-04-23T12:00:00Z"
updated: "2026-04-23T12:00:00Z"
workspace:
  repository: null
  worktree: null
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

function extractTodosSection(content: string): string {
  const match = content.match(/^## Todos\s*$([\s\S]*?)(?=^## |\s*$)/m);
  return match ? `## Todos${match[1]}` : '';
}

const PLAN_MD = `---
ticket: demo
status: backlog
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
  let ticketDir: string;

  beforeEach(async () => {
    syntaurHome = await mkdtemp(join(tmpdir(), 'syntaur-planv-'));
    resetEventsDb();
    initEventsDb(resolve(syntaurHome, 'syntaur.db'));
    await seedMissingBuiltins(syntaurHome);
    projectsDir = resolve(syntaurHome, 'projects');
    await mkdir(projectsDir, { recursive: true });
    await writeFile(
      resolve(syntaurHome, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\nonboarding:\n  completed: true\n---\n`,
    );
    ticketDir = resolve(projectsDir, 'p', 'tickets', 'PD-1-demo');
    await mkdir(ticketDir, { recursive: true });
    await writeFile(resolve(projectsDir, 'p', 'project.md'), '---\nslug: p\ntitle: P\nprefix: PD\nnextTicket: 2\n---\n', 'utf-8');
    await writeFile(resolve(ticketDir, 'ticket.md'), TICKET_MD);
    await writeFile(resolve(ticketDir, 'plan.md'), PLAN_MD);
  });

  afterEach(async () => {
    closeEventsDb();
    resetEventsDb();
    await rm(syntaurHome, { recursive: true, force: true });
  });

  function featureTicket(status: string): string {
    return `---
id: PD-1
slug: demo
title: "Demo"
project: p
template: feature
status: ${status}
priority: medium
created: "2026-04-23T12:00:00Z"
updated: "2026-04-23T12:00:00Z"
depends_on: []
links: []
blocked: null
parked: null
plan:
  file: plan.md
  approvedDigest: null
  approvedAt: null
  approvedBy: null
workspace:
  repository: null
  worktree: null
  branch: null
  parentBranch: null
tags: []
---

# Demo

## Objective

Ship it.
`;
  }

  it('creates plan-v2.md and leaves ticket.md ## Todos unchanged', async () => {
    const before = await readFile(resolve(ticketDir, 'ticket.md'), 'utf-8');
    const result = await runCli(
      ['plan', 'version', '--ticket', 'PD-1', '--project', 'p'],
      syntaurHome,
      syntaurHome,
    );
    expect(result.code, result.stderr).toBe(0);

    const planV2 = await readFile(resolve(ticketDir, 'plan-v2.md'), 'utf-8');
    expect(planV2).toContain('Implementation Plan v2');
    expect(planV2).toContain('Supersedes:');
    expect(planV2).toContain('- [ ] First task');
    expect(planV2).toContain('- [ ] Third task');
    // Checked items from prior plan are NOT carried forward.
    expect(planV2).not.toContain('Second task done');

    const ticket = await readFile(resolve(ticketDir, 'ticket.md'), 'utf-8');
    expect(extractTodosSection(ticket)).toBe(extractTodosSection(before));
  });

  it('does NOT rewrite non-canonical checkbox lines that happen to reference the old plan link', async () => {
    const customTicket = TICKET_MD.replace(
      '- [ ] Implement [plan](./plan.md)\n- [ ] Review implementation of [plan](./plan.md)',
      `- [ ] Implement [plan](./plan.md)
- [ ] Review implementation of [plan](./plan.md)
- [ ] Custom follow-up referencing [plan](./plan.md) in prose`,
    );
    await writeFile(resolve(ticketDir, 'ticket.md'), customTicket);
    const result = await runCli(
      ['plan', 'version', '--ticket', 'PD-1', '--project', 'p'],
      syntaurHome,
      syntaurHome,
    );
    expect(result.code, result.stderr).toBe(0);
    const updated = await readFile(resolve(ticketDir, 'ticket.md'), 'utf-8');
    expect(updated).toContain(
      '- [ ] Custom follow-up referencing [plan](./plan.md) in prose',
    );
    expect(updated).not.toMatch(/\(superseded by plan-v/);
  });

  it('from planning is file-only (status stays planning)', async () => {
    await writeFile(resolve(ticketDir, 'ticket.md'), featureTicket('planning'));
    const result = await runCli(
      ['plan', 'version', '--ticket', 'PD-1', '--project', 'p'],
      syntaurHome,
      syntaurHome,
    );
    expect(result.code, result.stderr).toBe(0);
    const fm = parseTicketFrontmatter(await readFile(resolve(ticketDir, 'ticket.md'), 'utf-8'));
    expect(fm.status).toBe('planning');
    const moved = listEventsByTicket('PD-1').filter((e) => e.type === 'moved');
    expect(moved.length).toBe(0);
  });

  it('from ready returns to planning with plan-version moved event', async () => {
    await writeFile(resolve(ticketDir, 'ticket.md'), featureTicket('ready'));
    const result = await runCli(
      ['plan', 'version', '--ticket', 'PD-1', '--project', 'p'],
      syntaurHome,
      syntaurHome,
    );
    expect(result.code, result.stderr).toBe(0);
    const fm = parseTicketFrontmatter(await readFile(resolve(ticketDir, 'ticket.md'), 'utf-8'));
    expect(fm.status).toBe('planning');
    const moved = listEventsByTicket('PD-1').find((e) => e.type === 'moved');
    expect(moved).toBeTruthy();
    const details = JSON.parse(moved!.details ?? '{}');
    expect(details.verb).toBe('plan-version');
    expect(details.from).toBe('ready');
    expect(details.to).toBe('planning');
  });

  it('from in_progress returns to planning', async () => {
    await writeFile(resolve(ticketDir, 'ticket.md'), featureTicket('in_progress'));
    const result = await runCli(
      ['plan', 'version', '--ticket', 'PD-1', '--project', 'p'],
      syntaurHome,
      syntaurHome,
    );
    expect(result.code, result.stderr).toBe(0);
    const fm = parseTicketFrontmatter(await readFile(resolve(ticketDir, 'ticket.md'), 'utf-8'));
    expect(fm.status).toBe('planning');
  });

  it('refuses when template has no plan role and does not write revision', async () => {
    const quickTicket = featureTicket('backlog').replace('template: feature', 'template: quick');
    await writeFile(resolve(ticketDir, 'ticket.md'), quickTicket);
    const result = await runCli(
      ['plan', 'version', '--ticket', 'PD-1', '--project', 'p'],
      syntaurHome,
      syntaurHome,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/no plan role/);
    expect(await fileExists(resolve(ticketDir, 'plan-v2.md'))).toBe(false);
  });

  it('picks plan-v3.md when plan-v2.md already exists (no clobber)', async () => {
    await writeFile(resolve(ticketDir, 'plan-v2.md'), 'existing v2 body');
    const result = await runCli(
      ['plan', 'version', '--ticket', 'PD-1', '--project', 'p'],
      syntaurHome,
      syntaurHome,
    );
    expect(result.code, result.stderr).toBe(0);
    const v2 = await readFile(resolve(ticketDir, 'plan-v2.md'), 'utf-8');
    expect(v2).toBe('existing v2 body');
    const v3 = await readFile(resolve(ticketDir, 'plan-v3.md'), 'utf-8');
    expect(v3).toContain('Implementation Plan v3');
  });
});
