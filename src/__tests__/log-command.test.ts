import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { seedMissingBuiltins } from '../ticket-templates/builtins.js';
import {
  closeEventsDb,
  initEventsDb,
  listEventsByTicket,
  resetEventsDb,
} from '../db/events-db.js';
import { appendTypedLogEntry } from '../lifecycle/log-append.js';
import { evaluateGate } from '../ticket-templates/gates.js';
import { buildGateContext } from '../ticket-templates/context.js';
import { fileExists } from '../utils/fs.js';

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

const PROGRESS = `---
ticket: a
entryCount: 0
generated: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
---

# Progress

No progress yet.
`;

describe('syntaur log', () => {
  let home: string;
  let ticketDir: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-log-cmd-'));
    await writeFile(
      join(home, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(home, 'projects')}\n---\n`,
    );
    ticketDir = resolve(home, 'projects', 'p', 'tickets', 'PX-1-a');
    await mkdir(ticketDir, { recursive: true });
    await mkdir(resolve(home, 'projects', 'p'), { recursive: true });
    await writeFile(
      resolve(home, 'projects', 'p', 'project.md'),
      '---\nslug: p\ntitle: P\nprefix: PX\nnextTicket: 2\n---\n',
    );
    await writeFile(
      resolve(ticketDir, 'ticket.md'),
      '---\nid: PX-1\nslug: a\ntemplate: legacy\nstatus: in_progress\n---\n# A\n',
    );
    await seedMissingBuiltins(home);
    await writeFile(resolve(ticketDir, 'progress.md'), PROGRESS);
    resetEventsDb();
    initEventsDb(resolve(home, 'syntaur.db'));
  });

  afterEach(async () => {
    closeEventsDb();
    resetEventsDb();
    await rm(home, { recursive: true, force: true });
  });

  it('appends typed progress to legacy progress.md newest-first', async () => {
    const r = await runCli(['log', 'PX-1', '-t', 'progress', 'Step one', '--project', 'p'], home);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Logged progress to progress\.md/);
    const content = await readFile(resolve(ticketDir, 'progress.md'), 'utf-8');
    expect(content).toContain('· progress · human');
    expect(content).toContain('entryCount: 1');
    const h1 = content.indexOf('# Progress');
    expect(content.indexOf('Step one')).toBeGreaterThan(h1);
  });

  it('refuses review without --verdict and --open', async () => {
    const r = await runCli(['log', 'PX-1', '-t', 'review', 'Needs work', '--project', 'p'], home);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('review requires --verdict and --open');
  });

  it('refuses answer without --answers', async () => {
    const r = await runCli(['log', 'PX-1', '-t', 'answer', 'Yes', '--project', 'p'], home);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('answer requires --answers');
  });

  it('accepts review with verdict and open counts', async () => {
    const r = await runCli(
      [
        'log',
        'PX-1',
        '-t',
        'review',
        '--verdict',
        'changes',
        '--open',
        'high=1,medium=0',
        'Found issues',
        '--project',
        'p',
      ],
      home,
    );
    expect(r.code, r.stderr).toBe(0);
    const content = await readFile(resolve(ticketDir, 'progress.md'), 'utf-8');
    expect(content).toContain('verdict: changes · open: high=1 medium=0');
  });

  it('emits logged events with unique source_key within the same second', async () => {
    const fixed = '2026-09-15T12:00:00Z';
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixed));
    try {
      await appendTypedLogEntry({
        ticketDir,
        ticketId: 'PX-1',
        type: 'note',
        body: 'One',
        author: 'human',
      });
      await appendTypedLogEntry({
        ticketDir,
        ticketId: 'PX-1',
        type: 'note',
        body: 'Two',
        author: 'human',
      });
    } finally {
      vi.useRealTimers();
    }
    const events = listEventsByTicket('PX-1').filter((e) => e.type === 'logged');
    expect(events).toHaveLength(2);
    const keys = events.map((e) => e.source_key);
    expect(new Set(keys).size).toBe(2);
  });

  it('review-clean gate reads approve review entries', async () => {
    await appendTypedLogEntry({
      ticketDir,
      ticketId: 'PX-1',
      type: 'review',
      body: 'LGTM',
      author: 'human',
      keys: { verdict: 'approve · open: high=0 medium=0' },
    });
    const ctx = await buildGateContext(ticketDir);
    const result = await evaluateGate('review-clean', ctx);
    expect(result.pass).toBe(true);
  });
});

describe('syntaur log journal placement', () => {
  let home: string;
  let ticketDir: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-log-journal-'));
    process.env.SYNTAUR_HOME = home;
    await seedMissingBuiltins(home);
    ticketDir = join(home, 'feat');
    await mkdir(ticketDir, { recursive: true });
    await writeFile(
      join(ticketDir, 'ticket.md'),
      `---
id: F-1
slug: feat
template: feature
status: in_progress
---
# Feat
`,
    );
  });

  afterEach(async () => {
    delete process.env.SYNTAUR_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it('appends journal entries oldest-first with purpose frontmatter', async () => {
    await appendTypedLogEntry({
      ticketDir,
      ticketId: 'F-1',
      type: 'progress',
      body: 'First',
      author: 'human',
    });
    await appendTypedLogEntry({
      ticketDir,
      ticketId: 'F-1',
      type: 'progress',
      body: 'Second',
      author: 'human',
    });
    const content = await readFile(join(ticketDir, 'journal.md'), 'utf-8');
    expect(content).toContain('purpose:');
    const first = content.indexOf('First');
    const second = content.indexOf('Second');
    expect(first).toBeLessThan(second);
  });
});

describe('syntaur log chat-note fallback', () => {
  let home: string;
  let ticketDir: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-log-quick-'));
    await writeFile(
      join(home, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(home, 'projects')}\n---\n`,
    );
    ticketDir = resolve(home, 'projects', 's', 'tickets', 'SCR-2-q');
    await mkdir(ticketDir, { recursive: true });
    await mkdir(resolve(home, 'projects', 's'), { recursive: true });
    await writeFile(
      resolve(home, 'projects', 's', 'project.md'),
      '---\nslug: s\ntitle: S\nprefix: SCR\nnextTicket: 3\n---\n',
    );
    await writeFile(
      resolve(ticketDir, 'ticket.md'),
      '---\nid: SCR-2\nslug: q\ntemplate: quick\nstatus: draft\n---\n# Q\n',
    );
    await seedMissingBuiltins(home);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('creates chat/ for quick tickets without a log role', async () => {
    const r = await runCli(['log', 'SCR-2', '-t', 'note', 'Quick note', '--project', 's'], home);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('Logged note to chat');
    expect(await fileExists(resolve(ticketDir, 'chat', 'events.jsonl'))).toBe(true);
  });
});
