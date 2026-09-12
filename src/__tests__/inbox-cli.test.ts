import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInbox, inboxCommand } from '../commands/inbox.js';
import { inboxRowKey, rowFingerprint, setSnooze, snoozeFilePath } from '../inbox/index.js';
import { readFile } from 'node:fs/promises';
import { clearStatusConfigCache } from '../dashboard/api.js';
import { formatCommentEntry, type Comment } from '../templates/index.js';
import { formatChatQuestionMarker } from '../chat/questions.js';

/**
 * CLI-wiring tests for `syntaur inbox` (T2). The predicate matrix is covered by
 * the T1 aggregate/predicate suites — here we exercise option parsing, the
 * human + JSON output, error paths, and `--help`. We seed a temp `SYNTAUR_HOME`
 * (config.md → defaultProjectDir) and let `runInbox` resolve dirs + status-config
 * exactly as the real command does, mirroring `search-command.test.ts`.
 */

let root: string;
let projectsDir: string;
let standaloneDir: string;
let origSyntaurHome: string | undefined;

interface SeedOpts {
  id: string;
  slug: string;
  title?: string;
  status: string;
  project?: string | null; // null/undefined → standalone
  blockedReason?: string;
  comments?: Comment[];
  statusHistory?: string[];
  updated?: string;
}

/** Create a real on-disk ticket fixture under the seeded SYNTAUR_HOME. */
async function seed(o: SeedOpts): Promise<void> {
  const standalone = o.project === undefined || o.project === null;
  const dir = standalone
    ? join(standaloneDir, o.slug)
    : join(projectsDir, o.project as string, 'tickets', o.slug);
  await mkdir(dir, { recursive: true });

  const fm: string[] = [
    `id: ${o.id}`,
    `slug: ${o.slug}`,
    `title: ${o.title ?? o.slug}`,
    `status: ${o.status}`,
    `project: ${standalone ? 'null' : o.project}`,
  ];
  if (o.blockedReason) fm.push(`blockedReason: ${o.blockedReason}`);
  if (o.updated) fm.push(`updated: "${o.updated}"`);
  if (o.statusHistory) {
    fm.push('statusHistory:');
    fm.push(...o.statusHistory.map((l) => `  ${l}`));
  }
  await writeFile(join(dir, 'ticket.md'), `---\n${fm.join('\n')}\n---\n# ${o.title ?? o.slug}\n`);

  if (o.comments && o.comments.length > 0) {
    const body = o.comments.map(formatCommentEntry).join('\n');
    await writeFile(
      join(dir, 'comments.md'),
      `---\nassignment: ${o.slug}\nentryCount: ${o.comments.length}\nupdated: "2026-06-16T00:00:00Z"\n---\n\n# Comments\n\n${body}\n`,
    );
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'syntaur-inbox-cli-'));
  projectsDir = join(root, 'projects');
  standaloneDir = join(root, 'tickets'); // ticketsDir() = <home>/assignments
  await mkdir(projectsDir, { recursive: true });
  await mkdir(standaloneDir, { recursive: true });

  // An explicit config.md points the CLI's `readConfig().defaultProjectDir` at
  // this temp tree (the in-code default is captured before SYNTAUR_HOME is set).
  await writeFile(
    join(root, 'config.md'),
    `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\n---\n`,
  );

  origSyntaurHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = root;
  // getStatusConfig() caches module-globally; clear so each test resolves fresh
  // against the temp SYNTAUR_HOME (default status config here).
  clearStatusConfigCache();
});

afterEach(async () => {
  if (origSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = origSyntaurHome;
  clearStatusConfigCache();
  await rm(root, { recursive: true, force: true });
});

describe('runInbox — JSON shape', () => {
  it('returns the InboxResult shape with counts Record + JSON-safe items', async () => {
    await seed({ id: 'r1', slug: 'rev', status: 'review', project: 'p1' });
    await seed({
      id: 'q1',
      slug: 'qs',
      status: 'in_progress',
      project: 'p1',
      comments: [
        { id: 'c1', timestamp: '2026-06-15T00:00:00Z', author: 'h', type: 'question', body: 'which?', resolved: false },
      ],
    });

    const result = await runInbox({});
    // Round-trips cleanly (no Map / non-serializable fields).
    const round = JSON.parse(JSON.stringify(result));
    expect(round).toEqual(result);

    expect(result.total).toBe(2);
    expect(result.counts).toEqual({ question: 1, review: 1, 'plan-approval': 0 });
    const review = result.items.find((i) => i.category === 'review')!;
    expect(review).toMatchObject({
      project: 'p1',
      ticketSlug: 'rev',
      ticketId: 'r1',
      category: 'review',
      action: { verb: 'Accept', command: 'syntaur complete rev --project p1' },
    });
    expect(typeof review.since).toBe('string');
    expect(typeof review.ageMs).toBe('number');
  });

  it('empty inbox returns the zeroed InboxResult', async () => {
    const result = await runInbox({});
    expect(result).toEqual({
      items: [],
      counts: { question: 0, review: 0, 'plan-approval': 0 },
      total: 0,
      snoozedCount: 0,
      liftedSnoozeKeys: [],
    });
  });
});

describe('runInbox — --type filter', () => {
  beforeEach(async () => {
    await seed({ id: 'r1', slug: 'rev', status: 'review', project: 'p1' });
    await seed({
      id: 'q1',
      slug: 'qs',
      status: 'in_progress',
      project: 'p1',
      comments: [
        { id: 'c1', timestamp: '2026-06-15T00:00:00Z', author: 'h', type: 'question', body: 'open?', resolved: false },
      ],
    });
  });

  it('restricts to the requested categories (comma-split, trimmed)', async () => {
    const result = await runInbox({ type: 'question' });
    expect(result.total).toBe(1);
    expect(result.counts).toEqual({ question: 1, review: 0, 'plan-approval': 0 });
    expect(result.items[0].category).toBe('question');
  });

  it('accepts multiple categories with surrounding whitespace', async () => {
    const result = await runInbox({ type: ' review , question ' });
    expect(result.total).toBe(2);
  });

  it('throws a clean error on an unknown category (no stack trace)', async () => {
    await expect(runInbox({ type: 'bogus' })).rejects.toThrow(
      /Unknown --type category: "bogus"\. Valid: question, review, plan-approval\./,
    );
  });

  it('rejects blocked as an unknown category', async () => {
    await expect(runInbox({ type: 'blocked' })).rejects.toThrow(
      /Unknown --type category: "blocked"\. Valid: question, review, plan-approval\./,
    );
  });

  it('rejects an unknown category even when mixed with valid ones', async () => {
    await expect(runInbox({ type: 'review,bogus' })).rejects.toThrow(/Unknown --type category: "bogus"/);
  });
});

describe('runInbox — --project filter', () => {
  beforeEach(async () => {
    await seed({ id: 'r1', slug: 'r1', status: 'review', project: 'p1' });
    await seed({ id: 'r2', slug: 'r2', status: 'review', project: 'p2' });
    await seed({ id: 's1', slug: 's1', status: 'review' }); // standalone
  });

  it('restricts to one project slug', async () => {
    const result = await runInbox({ project: 'p1' });
    expect(result.total).toBe(1);
    expect(result.items.every((i) => i.project === 'p1')).toBe(true);
  });
});

describe('runInbox — --limit parsing', () => {
  beforeEach(async () => {
    await seed({ id: 'r1', slug: 'r1', status: 'review', project: 'p1' });
    await seed({ id: 'r2', slug: 'r2', status: 'review', project: 'p1' });
    await seed({ id: 'r3', slug: 'r3', status: 'review', project: 'p1' });
  });

  it('truncates items but keeps full counts/total', async () => {
    const result = await runInbox({ limit: '2' });
    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(3);
    expect(result.counts.review).toBe(3);
  });

  it('rejects a non-positive / non-numeric --limit', async () => {
    await expect(runInbox({ limit: '0' })).rejects.toThrow(/Invalid --limit value/);
    await expect(runInbox({ limit: 'x' })).rejects.toThrow(/Invalid --limit value/);
  });
});

describe('inbox human output (grouped, smoke)', () => {
  it('prints the header summary, grouped sections, and the exact action command', async () => {
    await seed({ id: 'r1', slug: 'rev', title: 'Review me', status: 'review', project: 'p1' });
    await seed({
      id: 'q1',
      slug: 'qs',
      title: 'Has a question',
      status: 'in_progress',
      project: 'p1',
      comments: [
        { id: 'c1', timestamp: '2026-06-15T00:00:00Z', author: 'h', type: 'question', body: 'which option?', resolved: false },
      ],
    });

    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
      logs.push(String(m));
    });
    try {
      await inboxCommand.parseAsync(['node', 'inbox']);
    } finally {
      spy.mockRestore();
    }
    const out = logs.join('\n');

    expect(out).toMatch(/items? need you/);
    expect(out).toContain('review 1');
    expect(out).toContain('question 1');
    expect(out).toContain('Review me');
    expect(out).toContain('[p1/rev]');
    expect(out).toContain('→ syntaur complete rev --project p1');
    expect(out).toContain('→ syntaur comment qs "<answer>" --reply-to c1 --project p1');
  });

  it('prints a clear empty-state message when nothing needs the human', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
      logs.push(String(m));
    });
    try {
      await inboxCommand.parseAsync(['node', 'inbox']);
    } finally {
      spy.mockRestore();
    }
    expect(logs.join('\n')).toContain('Nothing needs you.');
  });

  it('prints the dashboard Open chat URL for a chat-sourced question', async () => {
    await mkdir(join(projectsDir, 'p1'), { recursive: true });
    await writeFile(
      join(projectsDir, 'p1', 'project.md'),
      `---\nslug: p1\ntitle: P1\ncreated: "2026-01-01"\nupdated: "2026-01-01"\n---\n# P1\n`,
    );
    const marker = formatChatQuestionMarker({
      kind: 'reply',
      itemId: 'turn-1:1',
      turnId: 'turn-1',
    });
    await writeFile(join(root, 'dashboard-port'), '4999\n');
    await seed({
      id: 'q1',
      slug: 'chat-row',
      title: 'Chat row',
      status: 'in_progress',
      project: 'p1',
      comments: [
        {
          id: 'c9',
          timestamp: '2026-06-16T00:00:00Z',
          author: 'claude',
          type: 'question',
          body: `Which name?\n\n${marker}`,
          resolved: false,
        },
      ],
    });

    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
      logs.push(String(m));
    });
    try {
      await inboxCommand.parseAsync(['node', 'inbox', '--project', 'p1']);
    } finally {
      spy.mockRestore();
    }
    const out = logs.join('\n');
    expect(out).toContain(
      '→ http://localhost:4999/projects/p1/tickets/chat-row?tab=chat#turn-1:1',
    );
  });

  it('--json prints the structured InboxResult', async () => {
    await seed({ id: 'r1', slug: 'rev', status: 'review', project: 'p1' });
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
      logs.push(String(m));
    });
    try {
      await inboxCommand.parseAsync(['node', 'inbox', '--json']);
    } finally {
      spy.mockRestore();
    }
    const parsed = JSON.parse(logs.join('\n'));
    expect(parsed.total).toBe(1);
    expect(parsed.counts.review).toBe(1);
    expect(parsed.items[0].action.command).toBe('syntaur complete rev --project p1');
  });
});

describe('runInbox — max-age and snoozes', () => {
  const now = Date.now();
  const oldAt = new Date(now - 30 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const freshAt = new Date(now - 12 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  it('--max-age 1 hides an old review', async () => {
    await seed({
      id: 'old-r',
      slug: 'old-rev',
      status: 'review',
      project: 'p1',
      statusHistory: [`- at: "${oldAt}"`, '  to: review', '  command: review'],
    });
    await seed({
      id: 'new-r',
      slug: 'new-rev',
      status: 'review',
      project: 'p1',
      statusHistory: [`- at: "${freshAt}"`, '  to: review', '  command: review'],
    });
    const result = await runInbox({ maxAge: '1' });
    expect(result.items.map((i) => i.ticketSlug)).toEqual(['new-rev']);
  });

  it('rejects invalid --max-age', async () => {
    await expect(runInbox({ maxAge: 'abc' })).rejects.toThrow(
      /--max-age must be a positive number of days/,
    );
  });

  it('hides a snoozed row from JSON and human output', async () => {
    await seed({ id: 'r1', slug: 'rev', status: 'review', project: 'p1' });
    const before = await runInbox({});
    const row = before.items[0];
    const key = inboxRowKey(row);
    await setSnooze(
      snoozeFilePath(),
      key,
      {
        until: new Date(now + 7 * 86_400_000).toISOString(),
        fingerprint: rowFingerprint(row),
        createdAt: new Date(now).toISOString(),
      },
      now,
    );
    const result = await runInbox({});
    expect(result.items).toHaveLength(0);
    expect(result.snoozedCount).toBe(1);

    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
      logs.push(String(m));
    });
    try {
      await inboxCommand.parseAsync(['node', 'inbox']);
    } finally {
      spy.mockRestore();
    }
    expect(logs.join('\n')).not.toContain('[p1/rev]');
  });

  it('--show-snoozed lists snoozed rows in JSON and the Snoozed section', async () => {
    await seed({ id: 'r1', slug: 'rev', title: 'Snoozed rev', status: 'review', project: 'p1' });
    const before = await runInbox({});
    const row = before.items[0];
    const key = inboxRowKey(row);
    await setSnooze(
      snoozeFilePath(),
      key,
      {
        until: new Date(now + 86_400_000).toISOString(),
        fingerprint: rowFingerprint(row),
        createdAt: new Date(now).toISOString(),
      },
      now,
    );
    const result = await runInbox({ showSnoozed: true });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].snoozed).toBeDefined();

    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
      logs.push(String(m));
    });
    try {
      await inboxCommand.parseAsync(['node', 'inbox', '--show-snoozed']);
    } finally {
      spy.mockRestore();
    }
    const out = logs.join('\n');
    expect(out).toContain('Snoozed (1)');
    expect(out).toContain('Snoozed rev');
  });

  it('prunes a lifted until-change entry from the store after a run', async () => {
    await seed({
      id: 'lift-r',
      slug: 'lift-rev',
      status: 'review',
      project: 'p1',
      updated: '2025-01-01T00:00:00Z',
      statusHistory: ['- at: "2025-01-01T00:00:00Z"', '  to: review', '  command: review'],
    });
    const before = await runInbox({});
    const row = before.items[0];
    const key = inboxRowKey(row);
    await setSnooze(
      snoozeFilePath(),
      key,
      { until: null, fingerprint: 'stale', createdAt: new Date(now).toISOString() },
      now,
    );
    await runInbox({});
    const store = JSON.parse(await readFile(snoozeFilePath(), 'utf-8'));
    expect(store[key]).toBeUndefined();
  });
});

describe('inbox --help', () => {
  it('lists the command flags', () => {
    const cliEntry = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
    const out = execFileSync('node', [cliEntry, 'inbox', '--help'], { encoding: 'utf-8' });
    expect(out).toContain('--project');
    expect(out).toContain('--type');
    expect(out).toContain('--limit');
    expect(out).toContain('--json');
    expect(out).toContain('--max-age');
    expect(out).toContain('--show-snoozed');
  });
});
