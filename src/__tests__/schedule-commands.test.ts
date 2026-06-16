import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scheduleCommand } from '../commands/schedule.js';
import { listJobs, readJob } from '../schedules/store.js';

let dir: string;
let logs: string[];
let errs: string[];

class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`);
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'syntaur-sched-cli-'));
  process.env.SYNTAUR_SCHEDULES_DIR = dir;
  process.env.SYNTAUR_HOME = dir; // isolate readConfig() → defaults
  logs = [];
  errs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errs.push(a.map(String).join(' '));
  });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.SYNTAUR_SCHEDULES_DIR;
  delete process.env.SYNTAUR_HOME;
  await rm(dir, { recursive: true, force: true });
});

async function run(argv: string[]): Promise<void> {
  try {
    await scheduleCommand.parseAsync(argv, { from: 'user' });
  } catch (err) {
    if (err instanceof ExitError) return;
    throw err;
  }
}

describe('schedule CLI', () => {
  it('lists every verb in --help', () => {
    const help = scheduleCommand.helpInformation();
    for (const verb of ['create', 'list', 'show', 'cancel', 'reschedule', 'retry', 'hold', 'release', 'kill', 'tick', 'fire-due', 'install', 'uninstall']) {
      expect(help).toContain(verb);
    }
  });

  it('creates a cron job and lists it', async () => {
    await run(['create', '--assignment', 'scheduled-agents', '--agent', 'claude', '--cron', '0 3 * * *', '--tz', 'UTC']);
    const jobs = await listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].trigger).toEqual({ kind: 'cron', expr: '0 3 * * *', tz: 'UTC' });
    expect(jobs[0].unattended).toBe(true);

    await run(['list']);
    expect(logs.join('\n')).toContain(jobs[0].id);
  });

  it('refuses an unattended Warp schedule', async () => {
    await run(['create', '--assignment', 'a', '--agent', 'claude', '--in', '5h', '--terminal', 'warp']);
    expect(errs.join('\n')).toMatch(/warp/i);
    expect(await listJobs()).toHaveLength(0);
  });

  it('errors when no trigger is given', async () => {
    await run(['create', '--assignment', 'a', '--agent', 'claude']);
    expect(errs.join('\n')).toMatch(/trigger is required/);
  });

  it('hold → release → cancel transitions via the CLI', async () => {
    await run(['create', '--assignment', 'a', '--agent', 'claude', '--at', '2026-06-15T12:00:00Z']);
    const id = (await listJobs())[0].id;
    await run(['hold', id]);
    expect((await readJob(id))?.attempt.state).toBe('held');
    await run(['release', id]);
    expect((await readJob(id))?.attempt.state).toBe('eligible');
    await run(['cancel', id]);
    expect((await readJob(id))?.attempt.state).toBe('cancelled');
  });

  it('reschedule swaps the trigger and re-arms', async () => {
    await run(['create', '--assignment', 'a', '--agent', 'claude', '--at', '2026-06-15T12:00:00Z']);
    const id = (await listJobs())[0].id;
    await run(['reschedule', id, '--cron', '*/10 * * * *', '--tz', 'UTC']);
    const job = await readJob(id);
    expect(job?.trigger).toEqual({ kind: 'cron', expr: '*/10 * * * *', tz: 'UTC' });
    expect(job?.attempt.state).toBe('eligible');
  });
});
