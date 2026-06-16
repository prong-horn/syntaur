import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  serializeJobFile,
  parseJobFile,
  readJob,
  writeJob,
  listJobs,
  deleteJob,
  jobPath,
  newJobId,
  ScheduleParseError,
} from '../schedules/store.js';
import {
  type ScheduledJob,
  freshAttempt,
  defaultLimits,
  defaultTiming,
} from '../schedules/types.js';

function sampleJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: newJobId(),
    assignmentId: 'scheduled-agents',
    agentId: 'claude',
    promptTemplate: 'plan @assignment',
    playbook: null,
    terminalPreference: 'terminal-app',
    unattended: true,
    limits: defaultLimits(),
    trigger: { kind: 'cron', expr: '0 3 * * *' },
    timing: defaultTiming(),
    note: 'nightly planner',
    createdAt: '2026-06-15T00:00:00Z',
    updatedAt: '2026-06-15T00:00:00Z',
    attempt: freshAttempt(),
    ...overrides,
  };
}

describe('schedules store', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'syntaur-sched-'));
    process.env.SYNTAUR_SCHEDULES_DIR = dir;
  });
  afterEach(async () => {
    delete process.env.SYNTAUR_SCHEDULES_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips serialize → parse losslessly', () => {
    const job = sampleJob();
    const parsed = parseJobFile(serializeJobFile(job));
    expect(parsed).toEqual(job);
  });

  it('round-trips every trigger kind', () => {
    const triggers: ScheduledJob['trigger'][] = [
      { kind: 'at', at: '2026-06-16T03:00:00Z' },
      { kind: 'in', durationMs: 18_000_000, anchorIso: '2026-06-15T00:00:00Z' },
      { kind: 'cron', expr: '*/5 * * * *', tz: 'America/Chicago' },
      { kind: 'after-reset', provider: 'claude', anchor: { windowStartIso: '2026-06-15T09:00:00Z', windowKind: 'rolling-5h' } },
      { kind: 'when-status', status: 'ready_to_implement' },
      { kind: 'when-plan-lands', assignmentId: 'other-assignment' },
    ];
    for (const trigger of triggers) {
      const job = sampleJob({ trigger });
      expect(parseJobFile(serializeJobFile(job)).trigger).toEqual(trigger);
    }
  });

  it('writes atomically and reads back via the store', async () => {
    const job = sampleJob();
    const written = await writeJob(job);
    expect(written.updatedAt).not.toBe(job.updatedAt); // updatedAt is bumped
    const read = await readJob(job.id);
    expect(read?.id).toBe(job.id);
    expect(read?.trigger).toEqual(job.trigger);
  });

  it('returns null for a missing job', async () => {
    expect(await readJob('job-does-not-exist')).toBeNull();
  });

  it('lists jobs sorted by createdAt and skips corrupt files', async () => {
    await writeJob(sampleJob({ createdAt: '2026-06-15T02:00:00Z' }));
    await writeJob(sampleJob({ createdAt: '2026-06-15T01:00:00Z' }));
    await writeFile(join(dir, 'garbage.md'), 'not a job', 'utf-8');
    const jobs = await listJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs[0].createdAt < jobs[1].createdAt).toBe(true);
  });

  it('rejects malformed frontmatter', () => {
    expect(() => parseJobFile('no frontmatter here')).toThrow(ScheduleParseError);
    expect(() => parseJobFile('---\nid: "x"\nbroken line\n---\n')).toThrow(ScheduleParseError);
    expect(() => parseJobFile('---\nid: not-json\n---\n')).toThrow(ScheduleParseError);
  });

  it('rejects a job missing a required field', () => {
    const job = sampleJob();
    const text = serializeJobFile(job).replace(/^agentId: .*$/m, '');
    expect(() => parseJobFile(text)).toThrow(ScheduleParseError);
  });

  it('deletes the job file and its event log', async () => {
    const job = sampleJob();
    await writeJob(job);
    await writeFile(join(dir, `${job.id}.jsonl`), '{}\n', 'utf-8');
    await deleteJob(job.id);
    expect(await readJob(job.id)).toBeNull();
    await expect(readFile(jobPath(job.id), 'utf-8')).rejects.toThrow();
  });
});
