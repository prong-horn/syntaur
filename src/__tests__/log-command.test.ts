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
import {
  closeSessionDb,
  initSessionDb,
  resetSessionDb,
} from '../dashboard/session-db.js';
import { appendSession } from '../dashboard/agent-sessions.js';
import { openEngagement } from '../db/engagement-db.js';
import { appendTypedLogEntry } from '../lifecycle/log-append.js';
import { evaluateGate } from '../ticket-templates/gates.js';
import { buildGateContext } from '../ticket-templates/context.js';
import { fileExists } from '../utils/fs.js';
import { LOG_ENTRY_TYPES } from '../ticket-templates/manifest.js';
import { parseLogEntries } from '../ticket-templates/log-reader.js';
import { runLog } from '../commands/log.js';
import { loadTemplate } from '../ticket-templates/registry.js';
import { resolveLogRole } from '../lifecycle/log-append.js';
import { VerbRefusedError } from '../lifecycle/verbs.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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

  it('logs each of the seven entry types', async () => {
    let answerTarget = '';
    for (const type of LOG_ENTRY_TYPES) {
      const opts =
        type === 'review'
          ? ['--verdict', 'approve', '--open', 'high=0,medium=0']
          : type === 'answer'
            ? ['--answers', answerTarget]
            : [];
      const r = await runCli(['log', 'PX-1', '-t', type, `${type} body`, '--project', 'p', ...opts], home);
      expect(r.code, `${type}: ${r.stderr}`).toBe(0);
      expect(r.stdout).toMatch(new RegExp(`Logged ${type} to progress\\.md`));
      if (type === 'question') {
        const entries = parseLogEntries(await readFile(resolve(ticketDir, 'progress.md'), 'utf-8'));
        answerTarget = entries.find((e) => e.type === 'question')!.timestamp;
      }
    }
  });

  it('refuses a type that is not in the manifest entryTypes', async () => {
    const prevHome = process.env.SYNTAUR_HOME;
    process.env.SYNTAUR_HOME = home;
    await mkdir(resolve(home, 'templates', 'progress-only'), { recursive: true });
    await writeFile(
      resolve(home, 'templates', 'progress-only', 'template.md'),
      `---
id: progress-only
version: 1
description: Progress-only test template
whenToUse: Tests entryTypes refusal
stages:
  - id: backlog
    label: Backlog
    instructions: Queued.
files:
  - path: journal.md
    role: log
    writer: cli
    createOn: ticket-creation
    description: Progress-only journal
    entryTypes:
      - progress
---
`,
    );
    const limitedDir = resolve(home, 'projects', 'p', 'tickets', 'PX-2-limited');
    await mkdir(limitedDir, { recursive: true });
    await writeFile(
      resolve(limitedDir, 'ticket.md'),
      '---\nid: PX-2\nslug: limited\ntemplate: progress-only\nstatus: in_progress\n---\n',
    );
    const manifest = await loadTemplate(home, 'progress-only');
    expect(manifest.files.find((f) => f.role === 'log')?.entryTypes).toEqual(['progress']);
    await expect(resolveLogRole(limitedDir)).resolves.toMatchObject({ logPath: 'journal.md' });
    await expect(
      runLog('PX-2', 'Nope', { type: 'review', project: 'p' }, limitedDir),
    ).rejects.toBeInstanceOf(VerbRefusedError);
    process.env.SYNTAUR_HOME = prevHome;
  });

  it('refuses answer when the question timestamp does not exist', async () => {
    const r = await runCli(
      ['log', 'PX-1', '-t', 'answer', 'Yes', '--answers', '2026-01-01T00:00:00Z', '--project', 'p'],
      home,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('No question entry');
  });

  it('stores a PNG attachment under chat/attachments and names it in the key line', async () => {
    const pngPath = resolve(ticketDir, 'shot.png');
    await writeFile(pngPath, PNG_1X1);
    const r = await runCli(
      ['log', 'PX-1', '-t', 'note', 'With image', '--attach', pngPath, '--project', 'p'],
      home,
    );
    expect(r.code, r.stderr).toBe(0);
    const content = await readFile(resolve(ticketDir, 'progress.md'), 'utf-8');
    const stored = content.match(/attachments: (.+)/)?.[1]?.trim();
    expect(stored).toBeTruthy();
    expect(await fileExists(resolve(ticketDir, 'chat', 'attachments', stored!))).toBe(true);
  });

  it('uses --agent when provided', async () => {
    const r = await runCli(
      ['log', 'PX-1', '-t', 'note', 'Agent authored', '--agent', 'cursor', '--project', 'p'],
      home,
    );
    expect(r.code, r.stderr).toBe(0);
    const content = await readFile(resolve(ticketDir, 'progress.md'), 'utf-8');
    expect(content).toContain('· note · cursor');
  });

  it('uses the session agent when no --agent is given', async () => {
    const sessionId = 'log-session-agent';
    const prevHome = process.env.SYNTAUR_HOME;
    const prevSession = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.SYNTAUR_HOME = home;
    process.env.CLAUDE_CODE_SESSION_ID = sessionId;
    resetSessionDb();
    initSessionDb(resolve(home, 'syntaur.db'));
    try {
      openEngagement({
        sessionId,
        ticketId: 'PX-1',
        projectSlug: 'p',
        ticketSlug: 'a',
        startedAt: '2026-01-01T00:00:00Z',
      });
      await appendSession('', {
        projectSlug: 'p',
        ticketSlug: 'a',
        ticketId: 'PX-1',
        agent: 'pi',
        sessionId,
        started: '2026-01-01T00:00:00Z',
        status: 'active',
        path: '/w',
      });
      await runLog('PX-1', 'From session', { type: 'note', project: 'p' }, ticketDir);
    } finally {
      closeSessionDb();
      resetSessionDb();
      process.env.SYNTAUR_HOME = prevHome;
      process.env.CLAUDE_CODE_SESSION_ID = prevSession;
    }
    const content = await readFile(resolve(ticketDir, 'progress.md'), 'utf-8');
    expect(content).toContain('· note · pi');
  });

  it('defaults author to human without a session agent', async () => {
    const r = await runCli(['log', 'PX-1', '-t', 'note', 'Human note', '--project', 'p'], home);
    expect(r.code, r.stderr).toBe(0);
    const content = await readFile(resolve(ticketDir, 'progress.md'), 'utf-8');
    expect(content).toContain('· note · human');
  });

  it('emits logged events with source_key log~ID~ts~n', async () => {
    const fixed = '2026-09-15T12:00:00Z';
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixed));
    try {
      await appendTypedLogEntry({
        ticketDir,
        ticketId: 'PX-1',
        type: 'note',
        body: 'Evented',
        author: 'human',
      });
    } finally {
      vi.useRealTimers();
    }
    const events = listEventsByTicket('PX-1').filter((e) => e.type === 'logged');
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.source_key).toMatch(/^log~PX-1~2026-09-15T12:00:00Z~\d+$/);
    }
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
