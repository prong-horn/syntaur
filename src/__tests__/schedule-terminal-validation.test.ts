import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scheduleCommand } from '../commands/schedule.js';
import { listJobs } from '../schedules/store.js';
import { TERMINAL_CHOICES } from '../utils/terminal-schema.js';

let dir: string;
let logs: string[];
let errs: string[];

class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`);
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'syntaur-sched-term-'));
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

describe('schedule create --terminal validation (B10)', () => {
  it('rejects an invalid --terminal at create with a clear error listing valid choices', async () => {
    await run([
      'create',
      '--assignment',
      'a',
      '--agent',
      'claude',
      '--at',
      '2026-06-15T12:00:00Z',
      '--terminal',
      'foo',
    ]);
    const msg = errs.join('\n');
    expect(msg).toMatch(/--terminal "foo" is not a known choice/);
    // Error names every valid choice for remediation.
    for (const choice of TERMINAL_CHOICES) {
      expect(msg).toContain(choice);
    }
    // No job was persisted from the rejected create.
    expect(await listJobs()).toHaveLength(0);
  });

  it('accepts every valid --terminal choice', async () => {
    for (const choice of TERMINAL_CHOICES) {
      // Use --interactive so the unattended Warp gate doesn't reject 'warp'.
      await run([
        'create',
        '--assignment',
        'a',
        '--agent',
        'claude',
        '--at',
        '2026-06-15T12:00:00Z',
        '--terminal',
        choice,
        '--interactive',
      ]);
    }
    expect(errs.join('\n')).toBe('');
    const jobs = await listJobs();
    expect(jobs).toHaveLength(TERMINAL_CHOICES.length);
    expect(new Set(jobs.map((j) => j.terminalPreference))).toEqual(new Set(TERMINAL_CHOICES));
  });
});
