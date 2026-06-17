import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInbox, inboxCommand } from '../commands/inbox.js';
import { clearStatusConfigCache } from '../dashboard/api.js';
import { formatCommentEntry, type Comment } from '../templates/index.js';

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
}

/** Create a real on-disk assignment fixture under the seeded SYNTAUR_HOME. */
async function seed(o: SeedOpts): Promise<void> {
  const standalone = o.project === undefined || o.project === null;
  const dir = standalone
    ? join(standaloneDir, o.slug)
    : join(projectsDir, o.project as string, 'assignments', o.slug);
  await mkdir(dir, { recursive: true });

  const fm: string[] = [
    `id: ${o.id}`,
    `slug: ${o.slug}`,
    `title: ${o.title ?? o.slug}`,
    `status: ${o.status}`,
    `project: ${standalone ? 'null' : o.project}`,
  ];
  if (o.blockedReason) fm.push(`blockedReason: ${o.blockedReason}`);
  await writeFile(join(dir, 'assignment.md'), `---\n${fm.join('\n')}\n---\n# ${o.title ?? o.slug}\n`);

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
  standaloneDir = join(root, 'assignments'); // assignmentsDir() = <home>/assignments
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
    await seed({ id: 'b1', slug: 'blk', status: 'blocked', project: 'p1', blockedReason: 'api' });

    const result = await runInbox({});
    // Round-trips cleanly (no Map / non-serializable fields).
    const round = JSON.parse(JSON.stringify(result));
    expect(round).toEqual(result);

    expect(result.total).toBe(2);
    expect(result.counts).toEqual({ review: 1, blocked: 1, question: 0, 'plan-approval': 0 });
    const review = result.items.find((i) => i.category === 'review')!;
    expect(review).toMatchObject({
      project: 'p1',
      assignmentSlug: 'rev',
      assignmentId: 'r1',
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
      counts: { review: 0, blocked: 0, question: 0, 'plan-approval': 0 },
      total: 0,
    });
  });
});

describe('runInbox — --type filter', () => {
  beforeEach(async () => {
    await seed({ id: 'r1', slug: 'rev', status: 'review', project: 'p1' });
    await seed({ id: 'b1', slug: 'blk', status: 'blocked', project: 'p1' });
  });

  it('restricts to the requested categories (comma-split, trimmed)', async () => {
    const result = await runInbox({ type: 'blocked' });
    expect(result.total).toBe(1);
    expect(result.counts).toEqual({ review: 0, blocked: 1, question: 0, 'plan-approval': 0 });
    expect(result.items[0].category).toBe('blocked');
  });

  it('accepts multiple categories with surrounding whitespace', async () => {
    const result = await runInbox({ type: ' review , blocked ' });
    expect(result.total).toBe(2);
  });

  it('throws a clean error on an unknown category (no stack trace)', async () => {
    await expect(runInbox({ type: 'bogus' })).rejects.toThrow(
      /Unknown --type category: "bogus"\. Valid: review, blocked, question, plan-approval\./,
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

describe('inbox --help', () => {
  it('lists the command flags', () => {
    const cliEntry = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
    const out = execFileSync('node', [cliEntry, 'inbox', '--help'], { encoding: 'utf-8' });
    expect(out).toContain('--project');
    expect(out).toContain('--type');
    expect(out).toContain('--limit');
    expect(out).toContain('--json');
  });
});
