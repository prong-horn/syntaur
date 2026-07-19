import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  reconcile,
  runSummarizePass,
  _resetSummarizeInFlightForTests,
} from '../dashboard/autodiscovery.js';
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
let serversDir: string;
let projectsDir: string;
let dbPath: string;
let prevHome: string | undefined;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-sum-trigger-'));
  serversDir = resolve(sandbox, 'servers');
  projectsDir = resolve(sandbox, 'projects');
  dbPath = resolve(sandbox, 'syntaur.db');
  await mkdir(serversDir, { recursive: true });
  await mkdir(projectsDir, { recursive: true });
  prevHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = resolve(sandbox, 'home');
  resetSessionDb();
  _resetSummarizeInFlightForTests();
});

afterEach(async () => {
  closeSessionDb();
  if (prevHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = prevHome;
  await rm(sandbox, { recursive: true, force: true });
});

describe('reconcile wiring', () => {
  it('invokes the injected summarize pass with a small batch cap', async () => {
    // reconcile runs the real scanner (guarded on DB init), so this only checks
    // the wiring; the fire/skip logic is unit-tested via runSummarizePass below.
    initSessionDb(dbPath);
    const calls: Array<{ limit: number }> = [];
    await reconcile(serversDir, projectsDir, undefined, undefined, undefined, async (opts) => {
      calls.push(opts);
      return [];
    });

    expect(calls).toHaveLength(1);
    // Each item is a paid LLM call, so the per-tick batch stays small.
    expect(calls[0].limit).toBeGreaterThan(0);
    expect(calls[0].limit).toBeLessThanOrEqual(5);
  });

  it('does not fail reconcile when the summarize pass rejects', async () => {
    initSessionDb(dbPath);
    await expect(
      reconcile(serversDir, projectsDir, undefined, undefined, undefined, async () => {
        throw new Error('backend exploded');
      }),
    ).resolves.toBeUndefined();
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
    // Summary-only writes don't change any row the scan watches, so without this
    // the dashboard would show stale rows until the next row-changing scan.
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
    await entered; // first batch is genuinely in flight
    await runSummarizePass(slow, undefined); // second tick — should be skipped
    expect(started).toBe(1);

    release();
    await first;

    await runSummarizePass(slow, undefined); // latch cleared — runs again
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

    // Simulate the LaunchAgent: a fresh process, same DB file. Any in-memory
    // cooldown would be lost here — only persisted state survives.
    closeSessionDb();
    resetSessionDb();
    initSessionDb(dbPath);

    expect(listSessionsNeedingSummary(10).map((s) => s.sessionId)).not.toContain('p1');

    const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
    expect(listSessionsNeedingSummary(10, later).map((s) => s.sessionId)).toContain('p1');
  });
});

describe('runScanSummarize (CLI master switch)', () => {
  async function writeConfig(autoSummarize: 'on' | 'off'): Promise<void> {
    const home = process.env.SYNTAUR_HOME!;
    await mkdir(home, { recursive: true });
    await writeFile(
      resolve(home, 'config.md'),
      `---\nsession.autoSummarize: ${autoSummarize}\n---\n`,
    );
  }

  it('does nothing when the per-run flag is off (LaunchAgent passes plain scan, but --no-summarize wins)', async () => {
    await writeConfig('on');
    const { runScanSummarize } = await import('../commands/session.js');
    // flagEnabled=false models `--no-summarize`.
    expect(await runScanSummarize(false)).toEqual({ ran: false });
  });

  it('does nothing when the config master switch is off, even with the flag on', async () => {
    await writeConfig('off');
    const { runScanSummarize } = await import('../commands/session.js');
    // This is the LaunchAgent path — config off must mean zero paid calls.
    expect(await runScanSummarize(true)).toEqual({ ran: false });
  });

  it('runs and returns counts when the config is on (no eligible sessions ⇒ no backend call)', async () => {
    await writeConfig('on');
    initSessionDb(dbPath); // empty DB → summarizeMissing finds nothing, never spawns a backend
    const { runScanSummarize } = await import('../commands/session.js');
    const result = await runScanSummarize(true);
    expect(result.ran).toBe(true);
    expect(result.counts).toEqual({});
  });

  it('produces a single JSON document when embedded in scan --json output', async () => {
    await writeConfig('off');
    const { runScanSummarize } = await import('../commands/session.js');
    const summarization = await runScanSummarize(true);
    // The scan action does exactly this: one stringify of scan summary + field.
    const fakeScanSummary = { discovered: 1, inserted: 0, revived: 0, swept: 0, skipped: 1, changed: false };
    const line = JSON.stringify({ ...fakeScanSummary, summarization });
    const parsed = JSON.parse(line);
    expect(parsed.summarization).toEqual({ ran: false });
    expect(parsed.discovered).toBe(1);
  });
});
