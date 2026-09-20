import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  formatHistoryLine,
  parseGitLog,
  renderHistoryText,
  runHistory,
} from '../commands/history.js';
import { renderTimelineTable } from '../commands/timeline.js';
import {
  closeEventsDb,
  initEventsDb,
  recordEvent,
  resetEventsDb,
} from '../db/events-db.js';

let home: string;
let projectsDir: string;
const prevHome = process.env.HOME;
const prevSyntaur = process.env.SYNTAUR_HOME;

const PROJECT = 'demo';
const SLUG = 'first';
const TICKET_ID = 'DEM-1';

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    SYNTAUR_HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

function git(args: string[]): void {
  const r = spawnSync('git', args, { encoding: 'utf-8', env: gitEnv() });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || 'git failed');
}

function ticketMd(): string {
  return `---
id: ${TICKET_ID}
slug: ${SLUG}
title: First
project: ${PROJECT}
template: feature
status: backlog
priority: medium
created: "2026-01-01T00:00:00Z"
updated: "2026-01-02T00:00:00Z"
depends_on: []
links: []
tags: []
blocked: null
parked: null
workspace:
  repository: null
  branch: null
  worktree: null
  parentBranch: null
plan:
  file: null
  approvedDigest: null
  approvedAt: null
  approvedBy: null
---
## Objective

Test.
`;
}

async function seedTicket(): Promise<void> {
  const ticketDir = resolve(projectsDir, PROJECT, 'tickets', `${TICKET_ID}-${SLUG}`);
  await mkdir(ticketDir, { recursive: true });
  await writeFile(resolve(ticketDir, 'ticket.md'), ticketMd(), 'utf-8');
  await writeFile(
    resolve(projectsDir, PROJECT, 'project.md'),
    `---\nslug: ${PROJECT}\ntitle: "demo"\n---\n`,
    'utf-8',
  );
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'syntaur-history-'));
  projectsDir = join(home, 'projects');
  process.env.HOME = home;
  process.env.SYNTAUR_HOME = home;
  await writeFile(
    join(home, 'config.md'),
    `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\n---\n`,
  );
});

afterEach(async () => {
  closeEventsDb();
  resetEventsDb();
  process.env.HOME = prevHome;
  if (prevSyntaur === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = prevSyntaur;
  await rm(home, { recursive: true, force: true });
});

describe('parseGitLog', () => {
  it('parses name-only blocks', () => {
    const stdout = `abc123\x1f2026-01-02T00:00:00Z\x1fsecond
projects/demo/tickets/DEM-1-first/ticket.md

def456\x1f2026-01-01T00:00:00Z\x1ffirst
projects/demo/tickets/DEM-1-first/ticket.md
projects/demo/tickets/DEM-1-first/progress.md
`;
    const entries = parseGitLog(stdout);
    expect(entries).toHaveLength(2);
    expect(entries[0].subject).toBe('second');
    expect(entries[0].files).toHaveLength(1);
    expect(entries[1].files).toHaveLength(2);
  });
});

describe('runHistory', () => {
  it('lists commits touching the ticket folder newest-first', async () => {
    git(['-C', home, 'init', '-q']);
    git(['-C', home, 'config', 'user.name', 'Syntaur']);
    git(['-C', home, 'config', 'user.email', 'syntaur@localhost']);
    await writeFile(join(home, 'README.txt'), 'root\n', 'utf-8');
    git(['-C', home, 'add', '-A']);
    git(['-C', home, 'commit', '-q', '-m', 'initial home']);

    await seedTicket();
    const ticketPath = join(
      projectsDir,
      PROJECT,
      'tickets',
      `${TICKET_ID}-${SLUG}`,
      'ticket.md',
    );
    git(['-C', home, 'add', ticketPath]);
    git(['-C', home, 'commit', '-q', '-m', 'ticket create']);
    await writeFile(ticketPath, ticketMd() + '\nEdit one\n', 'utf-8');
    git(['-C', home, 'add', ticketPath]);
    git(['-C', home, 'commit', '-q', '-m', 'ticket edit']);

    await writeFile(join(home, 'other.txt'), 'elsewhere\n', 'utf-8');
    git(['-C', home, 'add', 'other.txt']);
    git(['-C', home, 'commit', '-q', '-m', 'unrelated']);

    const entries = await runHistory(TICKET_ID, { project: PROJECT });
    if (typeof entries === 'string') throw new Error('expected git entries');
    expect(entries).toHaveLength(2);
    expect(entries[0].subject).toBe('ticket edit');
    expect(entries[1].subject).toBe('ticket create');
    expect(renderHistoryText(entries)).toMatch(/\(1 files\)/);
    expect(entries.every((e) => e.files.length >= 1)).toBe(true);
  });

  it('honours --limit', async () => {
    git(['-C', home, 'init', '-q']);
    git(['-C', home, 'config', 'user.name', 'Syntaur']);
    git(['-C', home, 'config', 'user.email', 'syntaur@localhost']);
    await seedTicket();
    const ticketPath = join(
      projectsDir,
      PROJECT,
      'tickets',
      `${TICKET_ID}-${SLUG}`,
      'ticket.md',
    );
    git(['-C', home, 'add', ticketPath]);
    git(['-C', home, 'commit', '-q', '-m', 'one']);
    await writeFile(ticketPath, ticketMd() + '\n2\n', 'utf-8');
    git(['-C', home, 'add', ticketPath]);
    git(['-C', home, 'commit', '-q', '-m', 'two']);

    const entries = (await runHistory(TICKET_ID, { project: PROJECT, limit: 1 })) as unknown[];
    expect(entries).toHaveLength(1);
    expect((entries[0] as { subject: string }).subject).toBe('two');
  });

  it('returns JSON-shaped records', async () => {
    git(['-C', home, 'init', '-q']);
    git(['-C', home, 'config', 'user.name', 'Syntaur']);
    git(['-C', home, 'config', 'user.email', 'syntaur@localhost']);
    await seedTicket();
    const ticketPath = join(
      projectsDir,
      PROJECT,
      'tickets',
      `${TICKET_ID}-${SLUG}`,
      'ticket.md',
    );
    git(['-C', home, 'add', ticketPath]);
    git(['-C', home, 'commit', '-q', '-m', 'seed']);
    const entries = (await runHistory(TICKET_ID, { project: PROJECT })) as Array<{
      sha: string;
      at: string;
      subject: string;
      files: string[];
    }>;
    expect(entries[0]).toMatchObject({
      subject: 'seed',
      files: expect.arrayContaining([expect.stringContaining('ticket.md')]),
    });
    expect(entries[0].sha).toMatch(/^[0-9a-f]{40}$/);
    expect(entries[0].at).toMatch(/^\d{4}-/);
  });

  it('errors when the home is not a git repository', async () => {
    await seedTicket();
    await expect(runHistory(TICKET_ID, { project: PROJECT })).rejects.toThrow(
      /not a git repository/,
    );
  });

  it('--events renders the timeline table without git', async () => {
    await seedTicket();
    resetEventsDb();
    initEventsDb(join(home, 'syntaur.db'));
    recordEvent({
      ticketId: TICKET_ID,
      at: '2026-01-03T00:00:00Z',
      actor: 'human',
      type: 'moved',
      details: { from: 'backlog', to: 'planning', verb: 'derive' },
      sourceKey: 'hist-test-1',
    });
    const table = (await runHistory(TICKET_ID, { project: PROJECT, events: true })) as string;
    expect(table).toContain('moved');
    expect(table).toContain('human');
    expect(renderTimelineTable([])).toBe('No events.');
  });

  it('prints empty message text helper', () => {
    expect(renderHistoryText([])).toBe('No commits touch this ticket yet.');
    expect(formatHistoryLine({
      sha: 'abcdef1234567890',
      at: '2026-01-01T00:00:00Z',
      subject: 'test',
      files: ['a', 'b'],
    })).toBe('2026-01-01T00:00:00Z  abcdef1  test  (2 files)');
  });
});
