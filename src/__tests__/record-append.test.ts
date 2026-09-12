import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendProgressEntry, appendProgressLog } from '../lifecycle/progress-append.js';
import { appendDecisionEntry } from '../lifecycle/log-append.js';
import { parseProgress } from '../dashboard/parser.js';
import { parseDecisionRecord } from '../dashboard/parser.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'record-append-test-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('appendProgressLog', () => {
  it('scaffolds a missing progress.md and lands entryCount: 1', async () => {
    const { path, timestamp } = await appendProgressLog({
      ticketDir: testDir,
      ticketRef: 'demo',
      text: 'First entry',
    });

    const content = await readFile(path, 'utf-8');
    const parsed = parseProgress(content);
    expect(parsed.entryCount).toBe(1);
    expect(parsed.body).toContain('First entry');
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('gives entryCount: 2 on a second call with the newest entry first', async () => {
    await appendProgressLog({
      ticketDir: testDir,
      ticketRef: 'demo',
      text: 'First entry',
    });
    await appendProgressLog({
      ticketDir: testDir,
      ticketRef: 'demo',
      text: 'Second entry',
    });

    const content = await readFile(join(testDir, 'progress.md'), 'utf-8');
    const parsed = parseProgress(content);
    expect(parsed.entryCount).toBe(2);
    const firstHeading = content.indexOf('## ');
    const secondHeading = content.indexOf('## ', firstHeading + 1);
    expect(content.slice(firstHeading, secondHeading)).toContain('Second entry');
    expect(content.slice(secondHeading)).toContain('First entry');
  });
});

describe('appendProgressEntry', () => {
  it('throws on a frontmatter-less file', () => {
    expect(() =>
      appendProgressEntry('# Progress\n\nnothing yet\n', 'text', '2026-09-07T12:00:00Z'),
    ).toThrow('progress.md has no YAML frontmatter.');
  });
});

describe('appendDecisionEntry', () => {
  it('scaffolds, writes ## title + **Recorded:**, returns { number: 1 }', async () => {
    const result = await appendDecisionEntry({
      ticketDir: testDir,
      ticketRef: 'demo',
      title: 'Use X',
      body: 'We chose X because it is simpler.',
    });

    expect(result).toEqual({ number: 1, title: 'Use X' });

    const content = await readFile(join(testDir, 'decision-record.md'), 'utf-8');
    expect(content).toContain('## Use X');
    expect(content).toContain('**Recorded:**');
    expect(content).toContain('We chose X because it is simpler.');
    const parsed = parseDecisionRecord(content);
    expect(parsed.decisionCount).toBe(1);
  });

  it('returns 2 on a second call with decisionCount: 2', async () => {
    await appendDecisionEntry({
      ticketDir: testDir,
      ticketRef: 'demo',
      title: 'First',
      body: 'One',
    });
    const result = await appendDecisionEntry({
      ticketDir: testDir,
      ticketRef: 'demo',
      title: 'Second',
      body: 'Two',
    });

    expect(result.number).toBe(2);
    const content = await readFile(join(testDir, 'decision-record.md'), 'utf-8');
    const parsed = parseDecisionRecord(content);
    expect(parsed.decisionCount).toBe(2);
    expect(content).toContain('## Second');
    expect(content).toContain('## First');
  });
});
