import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  runMaintenanceTick,
  runSummarizePass,
  stopMaintenanceLoop,
  _resetSummarizeInFlightForTests,
} from '../dashboard/maintenance-loop.js';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
} from '../dashboard/session-db.js';
import {
  appendSession,
  claimSummarize,
  recordSummarizeFailure,
  listSessionsNeedingSummary,
} from '../dashboard/agent-sessions.js';
import type { AgentSession } from '../dashboard/types.js';

let sandbox: string;
let projectsDir: string;
let assignmentsDir: string;
let dbPath: string;
let prevHome: string | undefined;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-sum-trigger-'));
  projectsDir = resolve(sandbox, 'projects');
  assignmentsDir = resolve(sandbox, 'assignments');
  dbPath = resolve(sandbox, 'syntaur.db');
  await mkdir(projectsDir, { recursive: true });
  await mkdir(assignmentsDir, { recursive: true });
  prevHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = resolve(sandbox, 'home');
  await mkdir(resolve(sandbox, 'home'), { recursive: true });
  await writeFile(resolve(sandbox, 'home', 'config.md'), '---\nsession.autoTrack: off\n---\n');
  resetSessionDb();
  _resetSummarizeInFlightForTests();
});

afterEach(async () => {
  await stopMaintenanceLoop();
  _resetSummarizeInFlightForTests();
  closeSessionDb();
  if (prevHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = prevHome;
  await rm(sandbox, { recursive: true, force: true });
});

describe('maintenance tick wiring', () => {
  it('invokes the injected summarize pass with a small batch cap', async () => {
    initSessionDb(dbPath);
    const calls: Array<{ limit: number }> = [];
    let signalCalled!: () => void;
    const called = new Promise<void>((r) => {
      signalCalled = r;
    });
    await runMaintenanceTick({
      projectsDir,
      assignmentsDir,
      summarizeAfterScan: async (opts) => {
        calls.push(opts);
        signalCalled();
        return [];
      },
    });
    await called;

    expect(calls).toHaveLength(1);
    expect(calls[0].limit).toBe(2);
  });

  it('returns from runMaintenanceTick WITHOUT waiting for a slow summarize pass', async () => {
    initSessionDb(dbPath);
    let released!: () => void;
    const gate = new Promise<void>((r) => {
      released = r;
    });
    let passEntered = false;
    await runMaintenanceTick({
      projectsDir,
      assignmentsDir,
      summarizeAfterScan: async () => {
        passEntered = true;
        await gate;
        return [];
      },
    });
    expect(passEntered).toBe(true);
    released();
    _resetSummarizeInFlightForTests();
  });

  it('does not surface a rejection from the detached summarize pass', async () => {
    initSessionDb(dbPath);
    await expect(
      runMaintenanceTick({
        projectsDir,
        assignmentsDir,
        summarizeAfterScan: async () => {
          throw new Error('backend exploded');
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('a second tick does not strand the first pass: shutdown still drains the REAL in-flight pass', async () => {
    initSessionDb(dbPath);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let firstEntered = false;
    let firstFinished = false;
    let secondEntered = false;

    await runMaintenanceTick({
      projectsDir,
      assignmentsDir,
      summarizeAfterScan: async ({ signal }) => {
        firstEntered = true;
        await new Promise<void>((res) => {
          signal?.addEventListener('abort', () => res(), { once: true });
          void gate.then(res);
        });
        firstFinished = true;
        return [];
      },
    });
    expect(firstEntered).toBe(true);

    await runMaintenanceTick({
      projectsDir,
      assignmentsDir,
      summarizeAfterScan: async () => {
        secondEntered = true;
        return [];
      },
    });
    expect(secondEntered).toBe(false);

    await stopMaintenanceLoop();
    expect(firstFinished).toBe(true);

    release();
    _resetSummarizeInFlightForTests();
  });

  it('stopMaintenanceLoop drains the detached summarize pass before returning (no closed-DB access)', async () => {
    initSessionDb(dbPath);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let passFinished = false;
    await runMaintenanceTick({
      projectsDir,
      assignmentsDir,
      summarizeAfterScan: async () => {
        await gate;
        passFinished = true;
        return [];
      },
    });

    let stopResolved = false;
    const stopping = stopMaintenanceLoop().then(() => {
      stopResolved = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(stopResolved).toBe(false);
    expect(passFinished).toBe(false);

    release();
    await stopping;
    expect(passFinished).toBe(true);
    expect(stopResolved).toBe(true);
    _resetSummarizeInFlightForTests();
  });
});

describe('runSummarizePass (WS-refresh decision)', () => {
  it('fires the WS callback when at least one summary was written', async () => {
    let notified = 0;
    await runSummarizePass(
      async () => [{ kind: 'ok' }, { kind: 'skipped-exists' }],
      () => {
        notified++;
      },
    );
    expect(notified).toBe(1);
  });

  it('does NOT fire the WS callback when every session was skipped', async () => {
    let notified = 0;
    await runSummarizePass(
      async () => [{ kind: 'skipped-exists' }, { kind: 'skipped-claimed' }],
      () => {
        notified++;
      },
    );
    expect(notified).toBe(0);
  });

  it('skips an overlapping batch while one is still in flight', async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let signalEntered!: () => void;
    const entered = new Promise<void>((r) => {
      signalEntered = r;
    });

    const slow = async () => {
      started++;
      signalEntered();
      await gate;
      return [];
    };

    const first = runSummarizePass(slow, undefined);
    await entered;
    await runSummarizePass(slow, undefined);
    expect(started).toBe(1);

    release();
    await first;

    await runSummarizePass(slow, undefined);
    expect(started).toBe(2);
  });
});

describe('persistent retry pacing across processes', () => {
  async function seedSession(sessionId: string): Promise<void> {
    const transcriptPath = resolve(sandbox, `${sessionId}.jsonl`);
    await writeFile(transcriptPath, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n');
    await appendSession('', {
      projectSlug: null,
      assignmentSlug: null,
      agent: 'claude',
      sessionId,
      started: '2026-07-01T10:00:00.000Z',
      status: 'stopped',
      path: '/w/a',
      transcriptPath,
    } as AgentSession);
  }

  it('keeps a failed session out of the queue even for a brand-new process', async () => {
    initSessionDb(dbPath);
    await seedSession('p1');
    claimSummarize('p1', 'worker');
    recordSummarizeFailure('p1', 'worker', 'boom', 60 * 60 * 1000);

    closeSessionDb();
    resetSessionDb();
    initSessionDb(dbPath);

    expect(listSessionsNeedingSummary(10).map((s) => s.sessionId)).not.toContain('p1');

    const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
    expect(listSessionsNeedingSummary(10, later).map((s) => s.sessionId)).toContain('p1');
  });
});
