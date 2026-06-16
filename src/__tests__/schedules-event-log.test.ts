import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, readEvents, eventLogPath } from '../schedules/event-log.js';

describe('schedules event log', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'syntaur-sched-evt-'));
    process.env.SYNTAUR_SCHEDULES_DIR = dir;
  });
  afterEach(async () => {
    delete process.env.SYNTAUR_SCHEDULES_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it('appends events and reads them back in order', async () => {
    await appendEvent('job-1', 'created');
    await appendEvent('job-1', 'fired', { trigger: 'cron' });
    await appendEvent('job-1', 'running', { sessionId: 's-1' });
    const events = await readEvents('job-1');
    expect(events.map((e) => e.type)).toEqual(['created', 'fired', 'running']);
    expect(events[1].data).toEqual({ trigger: 'cron' });
    expect(events.every((e) => typeof e.at === 'string')).toBe(true);
  });

  it('returns [] for a job with no log', async () => {
    expect(await readEvents('job-nope')).toEqual([]);
  });

  it('tolerates a torn final line', async () => {
    await appendEvent('job-2', 'created');
    await appendFile(eventLogPath('job-2'), '{"type":"fired","at":"2026', 'utf-8'); // no newline, truncated
    const events = await readEvents('job-2');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('created');
  });

  it('creates the schedules dir on first append', async () => {
    await rm(dir, { recursive: true, force: true }); // dir gone
    await appendEvent('job-3', 'created');
    expect(await readEvents('job-3')).toHaveLength(1);
  });
});
