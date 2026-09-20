import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  migrateV2Command,
  V2_MIGRATED_MARKER,
  injectRecordedLines,
  stripRecordFrontmatter,
  listDerivedProjectFiles,
} from '../commands/migrate-v2.js';
import { collectMigrateEntries } from '../commands/migrate-journal.js';
import { fileExists } from '../utils/fs.js';
import { renderConfig } from '../templates/config.js';

let home: string;

async function seedLegacyTicket(): Promise<string> {
  const projectDir = resolve(home, 'projects', 'legacy');
  const ticketDir = resolve(projectDir, 'tickets', 'LEG-1-old');
  await mkdir(ticketDir, { recursive: true });
  await writeFile(
    resolve(projectDir, 'project.md'),
    '---\nslug: legacy\ntitle: Legacy\nprefix: LEG\nnextTicket: 2\n---\n',
  );
  await writeFile(resolve(projectDir, 'manifest.md'), '# manifest\n');
  await writeFile(resolve(projectDir, '_status.md'), '# status\n');
  await writeFile(
    resolve(ticketDir, 'ticket.md'),
    `---
id: LEG-1
slug: old
title: Old
template: legacy
status: in_progress
project: legacy
---
# Old
`,
  );
  await writeFile(
    resolve(ticketDir, 'progress.md'),
    `---
ticket: LEG-1
entryCount: 1
generated: "2026-01-01T00:00:00Z"
updated: "2026-01-02T00:00:00Z"
---
# Progress

## 2026-01-02T00:00:00Z

hello
`,
  );
  await writeFile(
    resolve(ticketDir, 'comments.md'),
    `---
ticket: LEG-1
entryCount: 1
generated: "2026-01-01T00:00:00Z"
updated: "2026-01-02T00:00:00Z"
---
# Comments

## c1
**Recorded:** 2026-01-02T00:00:00Z
**Author:** human
**Type:** note

note body
`,
  );
  await writeFile(
    resolve(ticketDir, 'decision-record.md'),
    `---
ticket: LEG-1
decisionCount: 2
updated: "2026-01-03T00:00:00Z"
---
# Decision Record

## Decision A

First.

## Decision B

Second.
`,
  );
  await writeFile(
    resolve(ticketDir, 'handoff.md'),
    `---
ticket: LEG-1
handoffCount: 1
updated: "2026-01-04T00:00:00Z"
---
# Handoff Log

## Handoff 1

Baton text.
`,
  );
  await writeFile(resolve(ticketDir, 'scratchpad.md'), '---\nticket: LEG-1\nupdated: "2026-01-01"\n---\n# Scratch\n');
  return ticketDir;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'migrate-v2-derived-'));
  await writeFile(
    resolve(home, 'config.md'),
    renderConfig({ defaultProjectDir: resolve(home, 'projects') }),
  );
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('derived step helpers', () => {
  it('injectRecordedLines is idempotent for decisions and handoffs', () => {
    const decision = `---\nticket: x\nupdated: "2026-01-03T00:00:00Z"\n---\n\n## One\n\nBody.\n`;
    const once = injectRecordedLines('decision-record', decision, '2026-01-03T00:00:00Z');
    expect(once.decisions).toBe(1);
    const twice = injectRecordedLines('decision-record', once.content, '2026-01-03T00:00:00Z');
    expect(twice.decisions).toBe(0);
    expect(twice.content).toBe(once.content);

    const handoff = `---\nticket: x\nupdated: "2026-01-04T00:00:00Z"\n---\n\n## Handoff 1\n\nBaton.\n`;
    const h1 = injectRecordedLines('handoff', handoff, '2026-01-04T00:00:00Z');
    expect(h1.handoffs).toBe(1);
    const h2 = injectRecordedLines('handoff', h1.content, '2026-01-04T00:00:00Z');
    expect(h2.handoffs).toBe(0);
  });

  it('stripRecordFrontmatter drops the four counter keys', () => {
    const raw = `---
ticket: x
entryCount: 1
handoffCount: 2
decisionCount: 3
updated: "2026-01-01T00:00:00Z"
generated: "2026-01-01T00:00:00Z"
---
# Body
`;
    const { content, stripped } = stripRecordFrontmatter(raw);
    expect(stripped.entryCount).toBe(1);
    expect(stripped.updated).toBe(1);
    expect(content).not.toMatch(/^entryCount:/m);
    expect(content).toContain('generated:');
  });
});

describe('migrate v2 derived step', () => {
  it('dry-run prints counts and writes nothing', async () => {
    await seedLegacyTicket();
    await writeFile(
      resolve(home, V2_MIGRATED_MARKER),
      `rename-ids 2026-01-01T00:00:00.000Z\ntemplates 2026-01-01T00:00:01.000Z\nstatuses 2026-01-01T00:00:02.000Z\n`,
    );
    const manifestBefore = await readFile(resolve(home, 'projects', 'legacy', 'manifest.md'), 'utf-8');
    const { lines } = await migrateV2Command({ root: home, apply: false });
    expect(lines.some((l) => l.includes('derived:'))).toBe(true);
    expect(lines.some((l) => l.includes('counters:'))).toBe(true);
    expect(await fileExists(resolve(home, 'projects', 'legacy', 'manifest.md'))).toBe(true);
    expect(await readFile(resolve(home, 'projects', 'legacy', 'manifest.md'), 'utf-8')).toBe(
      manifestBefore,
    );
  });

  it('apply removes derived files, strips counters, and appends derived ledger line', async () => {
    const ticketDir = await seedLegacyTicket();
    await writeFile(
      resolve(home, V2_MIGRATED_MARKER),
      `rename-ids 2026-01-01T00:00:00.000Z\ntemplates 2026-01-01T00:00:01.000Z\nstatuses 2026-01-01T00:00:02.000Z\n`,
    );
    const before = await stat(home);
    const { lines } = await migrateV2Command({ root: home, apply: true });
    expect(lines.some((l) => l.includes('derived:'))).toBe(true);
    const projectDir = resolve(home, 'projects', 'legacy');
    expect(await listDerivedProjectFiles(projectDir)).toEqual([]);
    const progress = await readFile(resolve(ticketDir, 'progress.md'), 'utf-8');
    expect(progress).not.toMatch(/^entryCount:/m);
    expect(progress).not.toMatch(/^updated:/m);
    const decision = await readFile(resolve(ticketDir, 'decision-record.md'), 'utf-8');
    expect(decision).toContain('**Recorded:** 2026-01-03T00:00:00Z');
    const handoff = await readFile(resolve(ticketDir, 'handoff.md'), 'utf-8');
    expect(handoff).toContain('**Recorded:** 2026-01-04T00:00:00Z');
    const scratch = await readFile(resolve(ticketDir, 'scratchpad.md'), 'utf-8');
    expect(scratch).toMatch(/^updated:/m);
    const marker = await readFile(resolve(home, V2_MIGRATED_MARKER), 'utf-8');
    expect(marker).toContain('derived ');
    const after = await stat(home);
    expect(after.mtimeMs).toBeGreaterThanOrEqual(before.mtimeMs);
  });

  it('runs derived alone when the first three ledger lines exist', async () => {
    await seedLegacyTicket();
    await writeFile(
      resolve(home, V2_MIGRATED_MARKER),
      `rename-ids 2026-01-01T00:00:00.000Z\ntemplates 2026-01-01T00:00:01.000Z\nstatuses 2026-01-01T00:00:02.000Z\n`,
    );
    const { lines } = await migrateV2Command({ root: home, apply: false });
    expect(lines.some((l) => l.includes('derived:'))).toBe(true);
    expect(lines.some((l) => l.includes('templates:'))).toBe(false);
  });

  it('second apply reports migration already complete', async () => {
    await seedLegacyTicket();
    await writeFile(
      resolve(home, V2_MIGRATED_MARKER),
      `rename-ids 2026-01-01T00:00:00.000Z\ntemplates 2026-01-01T00:00:01.000Z\nstatuses 2026-01-01T00:00:02.000Z\n`,
    );
    await migrateV2Command({ root: home, apply: true });
    await expect(migrateV2Command({ root: home, apply: true })).rejects.toThrow(/already completed/);
  });

  it('migrate journal entries match before and after the derived strip', async () => {
    const ticketDir = await seedLegacyTicket();
    const legacyEntries = await collectMigrateEntries(ticketDir);
    await writeFile(
      resolve(home, V2_MIGRATED_MARKER),
      `rename-ids 2026-01-01T00:00:00.000Z\ntemplates 2026-01-01T00:00:01.000Z\nstatuses 2026-01-01T00:00:02.000Z\n`,
    );
    await migrateV2Command({ root: home, apply: true });
    const strippedEntries = await collectMigrateEntries(ticketDir);
    expect(strippedEntries.entries).toEqual(legacyEntries.entries);
  });

  it('comments preamble uses generated after strip', async () => {
    const projectDir = resolve(home, 'projects', 'legacy');
    const ticketDir = resolve(projectDir, 'tickets', 'LEG-1-old');
    await mkdir(ticketDir, { recursive: true });
    await writeFile(resolve(projectDir, 'project.md'), '---\nslug: legacy\n---\n');
    await writeFile(resolve(ticketDir, 'ticket.md'), '---\nid: LEG-1\ntemplate: legacy\n---\n');
    await writeFile(
      resolve(ticketDir, 'comments.md'),
      `---
ticket: LEG-1
generated: "2026-06-01T12:00:00Z"
updated: "2026-06-02T12:00:00Z"
---
# Comments

Free-text preamble before headers.

## c1
**Recorded:** 2026-06-02T08:00:00Z
**Author:** human
**Type:** note

body
`,
    );
    await writeFile(
      resolve(home, V2_MIGRATED_MARKER),
      `rename-ids 2026-01-01T00:00:00.000Z\ntemplates 2026-01-01T00:00:01.000Z\nstatuses 2026-01-01T00:00:02.000Z\n`,
    );
    await migrateV2Command({ root: home, apply: true });
    const { entries } = await collectMigrateEntries(ticketDir);
    const preamble = entries.find((e) => e.source === 'comments.md' && e.body.includes('Free-text'));
    expect(preamble?.timestamp).toBe('2026-06-01T12:00:00Z');
  });
});
