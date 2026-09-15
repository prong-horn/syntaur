import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  collectMigrateEntries,
  migrateJournalCommand,
  migrateJournalTicket,
  parseCommentEntriesForMigrate,
  parseDecisionEntriesForMigrate,
  parseHandoffEntriesForMigrate,
  parseProgressEntriesForMigrate,
  parseScratchpadEntryForMigrate,
  renderJournalContent,
  sortMigratableEntries,
  SOURCE_FILES,
  JOURNAL_FILENAME,
  MIGRATE_JOURNAL_BACKUP_DIR,
} from '../commands/migrate-journal.js';
import { parseLogEntries } from '../ticket-templates/log-reader.js';
import { seedMissingBuiltins } from '../ticket-templates/builtins.js';
import { fileExists } from '../utils/fs.js';
import { parseTicketFrontmatter } from '../lifecycle/frontmatter.js';
import { initEventsDb, listEventsByTicket } from '../db/events-db.js';
import { buildShow, renderShowText } from '../ticket-templates/show.js';
import { evaluateGate, type GateContext, type MovedEvent } from '../ticket-templates/gates.js';
import { loadTemplate } from '../ticket-templates/registry.js';
import type { TicketFrontmatter } from '../lifecycle/types.js';
import type { TemplateManifest } from '../ticket-templates/manifest.js';

let home: string;
let ticketDir: string;

const TICKET_MD = `---
id: MJ-1
slug: migrate-me
title: Migrate Me
project: demo
template: legacy
status: in_progress
priority: medium
created: "2026-01-01T00:00:00Z"
updated: "2026-01-02T00:00:00Z"
depends_on: []
links: []
plan:
  file: plan.md
  approvedDigest: null
  approvedAt: null
  approvedBy: null
workspace:
  repository: /repo
  branch: main
  worktree: null
  parentBranch: null
---

# Migrate Me

## Objective

Merge the legacy files.
`;

const PROGRESS_MD = `---
ticket: MJ-1
entryCount: 3
updated: "2026-01-03T00:00:00Z"
---

# Progress

## 2026-01-05T10:00:00Z

Untyped progress body.

## 2026-01-04T12:00:00Z · handoff · human

Typed handoff in progress.

## 2026-01-03T08:00:00Z

Body with sub-heading:

## Summary

Nested section text.
`;

const DECISION_MD = `---
ticket: MJ-1
decisionCount: 2
updated: "2026-01-02T12:00:00Z"
---

# Decision Record

## Decision 1: Use journal

**Recorded:** 2026-01-02T11:00:00Z

We chose journal.

## DR-2: Alt format

No recorded line here.
`;

const HANDOFF_MD = `---
ticket: MJ-1
handoffCount: 2
updated: "2026-01-01T18:00:00Z"
---

# Handoff Log

## Handoff 1: 2026-01-01T16:00:00Z

**From:** agent
**To:** human
**Reason:** done

## Handoff 2

**Recorded:** 2026-01-01T17:00:00Z

Second baton.
`;

const COMMENTS_MD = `---
ticket: MJ-1
entryCount: 4
updated: "2026-01-02T09:00:00Z"
---

# Comments

## q1
**Recorded:** 2026-01-02T08:00:00Z
**Author:** brennen
**Type:** question
**Resolved:** true

Open question text.

## n1
**Recorded:** 2026-01-02T07:00:00Z
**Author:** agent
**Type:** note
**Reply to:** q1

A note with reply.

## f1
**Recorded:** 2026-01-02T06:00:00Z
**Author:** human
**Type:** feedback

Feedback becomes note.

## broken-header
**Recorded:** 2026-01-02T05:00:00Z
**Author:** human

Malformed section without Type line — kept as raw note.
`;

const SCRATCHPAD_MD = `---
ticket: MJ-1
updated: "2026-01-01T20:00:00Z"
---

# Scratchpad

Working notes here.
`;

async function writeFixture(extra: Record<string, string> = {}): Promise<void> {
  await mkdir(ticketDir, { recursive: true });
  await writeFile(resolve(ticketDir, 'ticket.md'), TICKET_MD, 'utf-8');
  await writeFile(resolve(ticketDir, 'plan.md'), '# Plan\n\nDo the merge.\n', 'utf-8');
  await mkdir(resolve(ticketDir, 'chat'), { recursive: true });
  await writeFile(resolve(ticketDir, 'chat', 'events.jsonl'), '{"type":"ping"}\n', 'utf-8');
  const files: Record<string, string> = {
    'progress.md': PROGRESS_MD,
    'decision-record.md': DECISION_MD,
    'handoff.md': HANDOFF_MD,
    'comments.md': COMMENTS_MD,
    'scratchpad.md': SCRATCHPAD_MD,
    ...extra,
  };
  for (const [name, content] of Object.entries(files)) {
    if (content !== '') await writeFile(resolve(ticketDir, name), content, 'utf-8');
  }
}

async function snapshotTicketDir(): Promise<string> {
  const parts: string[] = [];
  for (const name of ['ticket.md', ...SOURCE_FILES, JOURNAL_FILENAME, 'plan.md', 'chat/events.jsonl']) {
    const path = resolve(ticketDir, name);
    if (await fileExists(path)) {
      parts.push(`${name}:\n${await readFile(path, 'utf-8')}`);
    }
  }
  return parts.join('\n---\n');
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'migrate-journal-'));
  process.env.SYNTAUR_HOME = home;
  await writeFile(
    join(home, 'config.md'),
    `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(home, 'projects')}\n---\n`,
  );
  await seedMissingBuiltins(home);
  initEventsDb(resolve(home, 'syntaur.db'));
  ticketDir = resolve(home, 'projects', 'demo', 'tickets', 'MJ-1-migrate-me');
  await mkdir(resolve(home, 'projects', 'demo'), { recursive: true });
  await writeFile(
    resolve(home, 'projects', 'demo', 'project.md'),
    '---\nslug: demo\ntitle: Demo\nprefix: MJ\nnextTicket: 2\n---\n',
  );
});

afterEach(async () => {
  delete process.env.SYNTAUR_HOME;
  await rm(home, { recursive: true, force: true });
});

describe('migrate journal parsers', () => {
  it('maps untyped progress to legacy author and keeps typed entries', () => {
    const { entries } = parseProgressEntriesForMigrate(PROGRESS_MD);
    const untyped = entries.find((e) => e.timestamp === '2026-01-05T10:00:00Z');
    const typed = entries.find((e) => e.type === 'handoff');
    expect(untyped?.author).toBe('legacy');
    expect(typed?.author).toBe('human');
  });

  it('parses Decision N and DR-N titles with undated fallback', () => {
    const { entries, counts } = parseDecisionEntriesForMigrate(DECISION_MD);
    expect(entries[0].body).toContain('**Use journal**');
    expect(entries[1].timestamp).toBe('2026-01-02T12:00:00Z');
    expect(counts.undated).toBe(1);
  });

  it('parses handoffs with heading timestamp and Recorded fallback', () => {
    const { entries, counts } = parseHandoffEntriesForMigrate(HANDOFF_MD);
    expect(entries[0].timestamp).toBe('2026-01-01T16:00:00Z');
    expect(entries[1].timestamp).toBe('2026-01-01T17:00:00Z');
    expect(counts.undated).toBe(0);
  });

  it('turns scratchpad content into a legacy note entry', () => {
    const { entries } = parseScratchpadEntryForMigrate(SCRATCHPAD_MD);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('note');
    expect(entries[0].author).toBe('legacy');
  });

  it('maps comments to note/question, reply line, resolved answer, and raw blocks', () => {
    const { entries, counts } = parseCommentEntriesForMigrate(COMMENTS_MD);
    expect(entries.some((e) => e.type === 'question')).toBe(true);
    expect(entries.some((e) => e.type === 'answer' && e.keys?.answers)).toBe(true);
    expect(entries.some((e) => e.body.startsWith('Reply to: q1'))).toBe(true);
    expect(entries.filter((e) => e.type === 'note').length).toBeGreaterThanOrEqual(2);
    expect(counts.rawBlocks).toBeGreaterThanOrEqual(1);
  });

  it('sorts by timestamp with stable source-order ties', async () => {
    await writeFixture();
    const { entries } = await collectMigrateEntries(ticketDir);
    const sorted = sortMigratableEntries(entries);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i].timestamp.localeCompare(sorted[i - 1].timestamp)).toBeGreaterThanOrEqual(0);
    }
  });

  it('demotes H2 sub-headings so journal re-parses without extra entries', async () => {
    await writeFixture();
    const { entries } = await collectMigrateEntries(ticketDir);
    const journal = renderJournalContent(entries, 'test purpose');
    const reparsed = parseLogEntries(journal);
    const nested = reparsed.find((e) => e.body.includes('Nested section text'));
    expect(nested).toBeDefined();
    expect(nested!.body).toContain('### Summary');
    expect(reparsed.filter((e) => e.timestamp === 'Summary')).toHaveLength(0);
  });
});

describe('migrate journal apply', () => {
  it('merges all sources, switches template, deletes sources, and emits retemplated', async () => {
    await writeFixture();
    const beforePlan = await readFile(resolve(ticketDir, 'plan.md'), 'utf-8');
    const beforeChat = await readFile(resolve(ticketDir, 'chat', 'events.jsonl'), 'utf-8');

    const result = await migrateJournalTicket(ticketDir, {
      targetTemplate: 'feature',
      purpose: 'Append-only log for progress, decisions, handoffs, questions, answers, and reviews.',
      apply: true,
      ticketId: 'MJ-1',
      projectSlug: 'demo',
    });

    expect(result.totalEntries).toBeGreaterThan(0);
    expect(await fileExists(resolve(ticketDir, JOURNAL_FILENAME))).toBe(true);
    for (const file of SOURCE_FILES) {
      expect(await fileExists(resolve(ticketDir, file))).toBe(false);
    }
    expect(await fileExists(resolve(ticketDir, MIGRATE_JOURNAL_BACKUP_DIR))).toBe(false);

    const fm = parseTicketFrontmatter(await readFile(resolve(ticketDir, 'ticket.md'), 'utf-8'));
    expect(fm.template).toBe('feature');

    const journal = await readFile(resolve(ticketDir, JOURNAL_FILENAME), 'utf-8');
    expect(journal).toContain('purpose:');
    const reparsed = parseLogEntries(journal);
    expect(reparsed.length).toBe(result.totalEntries);

    const events = listEventsByTicket('MJ-1');
    expect(events.some((e) => e.type === 'retemplated')).toBe(true);

    expect(await readFile(resolve(ticketDir, 'plan.md'), 'utf-8')).toBe(beforePlan);
    expect(await readFile(resolve(ticketDir, 'chat', 'events.jsonl'), 'utf-8')).toBe(beforeChat);
  });

  it('dry-run leaves the ticket byte-identical', async () => {
    await writeFixture();
    const before = await snapshotTicketDir();
    await migrateJournalTicket(ticketDir, {
      targetTemplate: 'feature',
      purpose: 'purpose text',
      apply: false,
      ticketId: 'MJ-1',
      projectSlug: 'demo',
    });
    const after = await snapshotTicketDir();
    expect(after).toBe(before);
  });

  it('refuses when only journal.md remains', async () => {
    await writeFixture();
    await migrateJournalTicket(ticketDir, {
      targetTemplate: 'feature',
      purpose: 'purpose text',
      apply: true,
      ticketId: 'MJ-1',
      projectSlug: 'demo',
    });
    const second = await migrateJournalTicket(ticketDir, {
      targetTemplate: 'feature',
      purpose: 'purpose text',
      apply: false,
      ticketId: 'MJ-1',
      projectSlug: 'demo',
    });
    expect(second.refused).toBe(true);
  });

  it('refuses non-legacy tickets without journal.md', async () => {
    await writeFixture({ 'progress.md': '', 'decision-record.md': '', 'handoff.md': '', 'comments.md': '', 'scratchpad.md': '' });
    for (const file of SOURCE_FILES) {
      await rm(resolve(ticketDir, file), { force: true });
    }
    await writeFile(
      resolve(ticketDir, 'ticket.md'),
      TICKET_MD.replace('template: legacy', 'template: feature'),
      'utf-8',
    );
    const result = await migrateJournalTicket(ticketDir, {
      targetTemplate: 'feature',
      purpose: 'purpose text',
      apply: false,
      ticketId: 'MJ-1',
      projectSlug: 'demo',
    });
    expect(result.refused).toBe(true);
  });

  it('rolls back when delete step fails after backup marker', async () => {
    await writeFixture();
    await expect(
      migrateJournalTicket(ticketDir, {
        targetTemplate: 'feature',
        purpose: 'purpose text',
        apply: true,
        ticketId: 'MJ-1',
        projectSlug: 'demo',
        hooks: {
          beforeDeleteSources: async () => {
            throw new Error('delete failed');
          },
        },
      }),
    ).rejects.toThrow('delete failed');

    expect(await fileExists(resolve(ticketDir, JOURNAL_FILENAME))).toBe(false);
    expect(await fileExists(resolve(ticketDir, 'progress.md'))).toBe(true);
    const fm = parseTicketFrontmatter(await readFile(resolve(ticketDir, 'ticket.md'), 'utf-8'));
    expect(fm.template).toBe('legacy');
    expect(await fileExists(resolve(ticketDir, MIGRATE_JOURNAL_BACKUP_DIR))).toBe(true);
  });

  it('resumes when journal.md and sources coexist (template legacy)', async () => {
    await writeFixture();
    const { entries } = await collectMigrateEntries(ticketDir);
    const journal = renderJournalContent(entries, 'purpose text');
    await writeFile(resolve(ticketDir, JOURNAL_FILENAME), journal, 'utf-8');

    const result = await migrateJournalTicket(ticketDir, {
      targetTemplate: 'feature',
      purpose: 'purpose text',
      apply: true,
      ticketId: 'MJ-1',
      projectSlug: 'demo',
    });

    expect(result.resumed).toBe(true);
    expect(await fileExists(resolve(ticketDir, 'progress.md'))).toBe(false);
    expect(parseTicketFrontmatter(await readFile(resolve(ticketDir, 'ticket.md'), 'utf-8')).template).toBe(
      'feature',
    );
  });

  it('resumes when journal exists and template already switched', async () => {
    await writeFixture();
    const { entries } = await collectMigrateEntries(ticketDir);
    await writeFile(resolve(ticketDir, JOURNAL_FILENAME), renderJournalContent(entries, 'purpose'), 'utf-8');
    await writeFile(
      resolve(ticketDir, 'ticket.md'),
      TICKET_MD.replace('template: legacy', 'template: feature'),
      'utf-8',
    );

    const result = await migrateJournalTicket(ticketDir, {
      targetTemplate: 'feature',
      purpose: 'purpose text',
      apply: true,
      ticketId: 'MJ-1',
      projectSlug: 'demo',
    });

    expect(result.resumed).toBe(true);
    expect(await fileExists(resolve(ticketDir, 'progress.md'))).toBe(false);
  });

  it('createBackup failure removes partial backup and leaves sources', async () => {
    await writeFixture();

    await expect(
      migrateJournalTicket(ticketDir, {
        targetTemplate: 'feature',
        purpose: 'purpose text',
        apply: true,
        ticketId: 'MJ-1',
        projectSlug: 'demo',
        hooks: {
          copySourceFile: async () => {
            throw new Error('copy failed');
          },
        },
      }),
    ).rejects.toThrow(/backup copy failed/);

    expect(await fileExists(resolve(ticketDir, 'progress.md'))).toBe(true);
    expect(await fileExists(resolve(ticketDir, MIGRATE_JOURNAL_BACKUP_DIR))).toBe(false);
  });

  it('--all summarizes migrated and refused tickets', async () => {
    await writeFixture();
    const refusedDir = resolve(home, 'projects', 'demo', 'tickets', 'MJ-2-refused');
    await mkdir(refusedDir, { recursive: true });
    await writeFile(
      resolve(refusedDir, 'ticket.md'),
      TICKET_MD.replace('id: MJ-1', 'id: MJ-2').replace('slug: migrate-me', 'slug: refused'),
      'utf-8',
    );
    await writeFile(resolve(refusedDir, JOURNAL_FILENAME), '---\npurpose: x\n---\n', 'utf-8');

    const lines = await migrateJournalCommand('MJ-1', {
      project: 'demo',
      all: true,
      apply: false,
      dir: home,
    });
    const summary = lines.find((l) => l.text.includes('--all:'));
    expect(summary?.text).toMatch(/1 migrated, 1 refused/);
  });
});

describe('migrate journal show and gates', () => {
  function gateCtx(
    fm: TicketFrontmatter,
    manifest: TemplateManifest,
    log: string,
    moves: MovedEvent[] = [],
  ): GateContext {
    return {
      ticketDir,
      fm,
      manifest,
      ticketBody: '# Migrate Me',
      logEntries: parseLogEntries(log),
      dependencyStages: new Map(),
      moves,
    };
  }

  it('show renders merged ticket and done gates pass after review entry', async () => {
    await writeFixture();
    await migrateJournalTicket(ticketDir, {
      targetTemplate: 'feature',
      purpose: 'Append-only log for progress, decisions, handoffs, questions, answers, and reviews.',
      apply: true,
      ticketId: 'MJ-1',
      projectSlug: 'demo',
    });

    const journalPath = resolve(ticketDir, JOURNAL_FILENAME);
    let journal = await readFile(journalPath, 'utf-8');
    journal += `\n## 2026-09-15T12:00:00Z · review · human\nverdict: approve · open: high=0 medium=0\n\nClean review.\n`;
    await writeFile(journalPath, journal, 'utf-8');

    const show = await buildShow(home, ticketDir);
    const text = renderShowText(show);
    expect(text).toContain('MJ-1');

    const manifest = await loadTemplate(home, 'feature');
    const fm = parseTicketFrontmatter(await readFile(resolve(ticketDir, 'ticket.md'), 'utf-8'));
    const moves: MovedEvent[] = [
      { at: '2026-09-14T00:00:00Z', to: 'review', from: 'in_progress', verb: 'submit' },
    ];
    const reviewGate = await evaluateGate('review-clean', gateCtx(fm, manifest, journal, moves));
    expect(reviewGate.pass).toBe(true);
  });
});
