import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { retemplateCommand } from '../commands/retemplate.js';
import { seedMissingBuiltins } from '../ticket-templates/builtins.js';
import { fileExists } from '../utils/fs.js';
import { parseTicketFrontmatter } from '../lifecycle/frontmatter.js';
import { initEventsDb, listEventsByTicket } from '../db/events-db.js';

let home: string;
let ticketDir: string;

const QUICK_TICKET = `---
id: RT-1
slug: quick-one
title: Quick One
project: p
template: quick
status: draft
priority: low
created: "2026-04-20T12:00:00Z"
updated: "2026-04-20T12:00:00Z"
depends_on: []
links: []
plan:
  file: null
  approvedDigest: null
  approvedAt: null
  approvedBy: null
---

# Quick One
`;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'retemplate-test-'));
  process.env.SYNTAUR_HOME = home;
  await writeFile(
    join(home, 'config.md'),
    `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(home, 'projects')}\n---\n`,
  );
  await seedMissingBuiltins(home);
  initEventsDb(resolve(home, 'events.db'));
  ticketDir = resolve(home, 'projects', 'p', 'tickets', 'RT-1-quick-one');
  await mkdir(ticketDir, { recursive: true });
  await mkdir(resolve(home, 'projects', 'p'), { recursive: true });
  await writeFile(
    resolve(home, 'projects', 'p', 'project.md'),
    '---\nslug: p\ntitle: P\nprefix: RT\nnextTicket: 2\n---\n',
  );
  await writeFile(resolve(ticketDir, 'ticket.md'), QUICK_TICKET, 'utf-8');
});

afterEach(async () => {
  delete process.env.SYNTAUR_HOME;
  await rm(home, { recursive: true, force: true });
});

describe('retemplate', () => {
  it('quick → feature adds journal.md without deleting ticket.md', async () => {
    const result = await retemplateCommand('RT-1', 'feature', { project: 'p' });
    expect(result.to).toBe('feature');
    expect(result.written).toContain('journal.md');
    expect(await fileExists(resolve(ticketDir, 'ticket.md'))).toBe(true);
    const fm = parseTicketFrontmatter(await readFile(resolve(ticketDir, 'ticket.md'), 'utf-8'));
    expect(fm.template).toBe('feature');
  });

  it('feature at in_progress adds plan.md', async () => {
    await retemplateCommand('RT-1', 'feature', { project: 'p' });
    const inProgress = QUICK_TICKET.replace('template: quick', 'template: feature').replace(
      'status: draft',
      'status: in_progress',
    );
    await writeFile(resolve(ticketDir, 'ticket.md'), inProgress, 'utf-8');
    const result = await retemplateCommand('RT-1', 'feature', { project: 'p' });
    expect(result.written).toContain('plan.md');
    const fm = parseTicketFrontmatter(await readFile(resolve(ticketDir, 'ticket.md'), 'utf-8'));
    expect(fm.plan.file).toBe('plan.md');
  });

  it('refuses unknown template', async () => {
    await expect(retemplateCommand('RT-1', 'nope', { project: 'p' })).rejects.toThrow(
      /template nope not found/,
    );
  });

  it('records a retemplated event', async () => {
    await retemplateCommand('RT-1', 'feature', { project: 'p' });
    const events = listEventsByTicket('RT-1');
    const row = events.find((e) => e.type === 'retemplated');
    expect(row).toBeTruthy();
    const details =
      typeof row?.details === 'string' ? JSON.parse(row.details) : row?.details;
    expect(details).toMatchObject({ from: 'quick', to: 'feature', written: ['journal.md'] });
  });
});
