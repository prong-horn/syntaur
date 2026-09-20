import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendTypedLogEntry, appendProgressLog } from '../lifecycle/log-append.js';
import { parseLogEntries } from '../ticket-templates/log-reader.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'record-append-test-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('appendProgressLog', () => {
  it('scaffolds a missing progress.md with one log entry', async () => {
    const { path, timestamp } = await appendProgressLog({
      ticketDir: testDir,
      ticketRef: 'demo',
      text: 'First entry',
      author: 'human',
    });

    const content = await readFile(path, 'utf-8');
    expect(parseLogEntries(content)).toHaveLength(1);
    expect(content).toContain('First entry');
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('appends a second entry with the newest entry first', async () => {
    await appendProgressLog({
      ticketDir: testDir,
      ticketRef: 'demo',
      text: 'First entry',
      author: 'human',
    });
    await appendProgressLog({
      ticketDir: testDir,
      ticketRef: 'demo',
      text: 'Second entry',
      author: 'human',
    });

    const content = await readFile(join(testDir, 'progress.md'), 'utf-8');
    expect(parseLogEntries(content)).toHaveLength(2);
    const firstHeading = content.indexOf('## ');
    const secondHeading = content.indexOf('## ', firstHeading + 1);
    expect(content.slice(firstHeading, secondHeading)).toContain('Second entry');
    expect(content.slice(secondHeading)).toContain('First entry');
  });
});

describe('appendTypedLogEntry', () => {
  it('writes typed headings on legacy progress.md without rewriting frontmatter', async () => {
    await writeFile(
      join(testDir, 'ticket.md'),
      '---\nid: T-1\nslug: demo\ntemplate: legacy\nstatus: in_progress\n---\n',
    );
    const beforeFm = `---
ticket: T-1
generated: "2026-06-01T00:00:00Z"
---

# Progress

No progress yet.
`;
    await writeFile(join(testDir, 'progress.md'), beforeFm);
    await appendTypedLogEntry({
      ticketDir: testDir,
      ticketId: 'T-1',
      type: 'handoff',
      body: 'Baton passed',
      author: 'human',
    });
    const content = await readFile(join(testDir, 'progress.md'), 'utf-8');
    expect(content.startsWith('---\nticket: T-1\ngenerated: "2026-06-01T00:00:00Z"\n---\n')).toBe(true);
    expect(content).toContain('· handoff · human');
    expect(content).toContain('Baton passed');
    const entries = parseLogEntries(content);
    expect(entries[0].type).toBe('handoff');
  });
});
