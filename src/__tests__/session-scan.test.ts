import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, utimes } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
} from '../dashboard/session-db.js';
import {
  appendSession,
  getSessionById,
  updateSessionStatus,
} from '../dashboard/agent-sessions.js';
import { scanSessions, type ScannerDeps } from '../sessions/scanner.js';
import { getAgentTarget } from '../targets/registry.js';
import type { AgentSession, AgentSessionStatus } from '../dashboard/types.js';

let testDir: string;
let claudeRoot: string;
let codexRoot: string;
let workspace: string;

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    projectSlug: null,
    assignmentSlug: null,
    agent: 'claude',
    sessionId: `session-${Math.random().toString(36).slice(2, 10)}`,
    started: '2026-06-11T08:00:00Z',
    status: 'active' as AgentSessionStatus,
    path: '/tmp/test',
    ...overrides,
  };
}

/** Hermetic deps: fixture roots for both descriptor-bearing targets, no lsof/ps. */
function deps(overrides: Partial<ScannerDeps> = {}): ScannerDeps {
  return {
    roots: { claude: claudeRoot, codex: codexRoot },
    autoTrack: 'all',
    openFiles: async () => new Set<string>(),
    isPidAlive: () => false,
    pidStartedAt: () => null,
    ...overrides,
  };
}

/** Write a Claude transcript fixture; returns its path. */
async function writeClaudeTranscript(
  sessionId: string,
  cwd: string,
  timestamp = '2026-06-11T08:00:00.000Z',
): Promise<string> {
  const dir = join(claudeRoot, 'some-encoded-cwd');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  await writeFile(
    path,
    `${JSON.stringify({ cwd, timestamp, type: 'user' })}\n${JSON.stringify({ timestamp: '2026-06-11T08:30:00.000Z', type: 'assistant' })}\n`,
  );
  return path;
}

/** Write a Codex rollout fixture; returns its path. */
async function writeCodexRollout(
  sessionId: string,
  cwd: string,
  timestamp = '2026-06-11T08:00:00.000Z',
): Promise<string> {
  const dir = join(codexRoot, '2026', '06', '11');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `rollout-${sessionId}.jsonl`);
  await writeFile(
    path,
    `${JSON.stringify({ type: 'session_meta', timestamp, payload: { id: sessionId, cwd } })}\n${JSON.stringify({ timestamp: '2026-06-11T08:45:00.000Z' })}\n`,
  );
  return path;
}

async function makeStale(path: string): Promise<number> {
  const past = new Date(Date.now() - 60 * 60 * 1000);
  await utimes(path, past, past);
  return statSync(path).mtimeMs;
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-scan-test-'));
  claudeRoot = join(testDir, 'claude-projects');
  codexRoot = join(testDir, 'codex-sessions');
  workspace = join(testDir, 'workspace');
  await mkdir(claudeRoot, { recursive: true });
  await mkdir(codexRoot, { recursive: true });
  await mkdir(workspace, { recursive: true });
  resetSessionDb();
  initSessionDb(resolve(testDir, 'test.db'));
});

afterEach(async () => {
  closeSessionDb();
  await rm(testDir, { recursive: true, force: true });
});

describe('sessions descriptors (claude + codex)', () => {
  it('claude parse extracts sessionId/cwd/timestamps from a transcript', async () => {
    const path = await writeClaudeTranscript('claude-sess-1', workspace);
    const parsed = await getAgentTarget('claude')!.sessions!.parse(path);

    expect(parsed).not.toBeNull();
    expect(parsed!.sessionId).toBe('claude-sess-1');
    expect(parsed!.cwd).toBe(workspace);
    expect(parsed!.startedAt).toBe('2026-06-11T08:00:00.000Z');
    expect(parsed!.endedAt).toBe('2026-06-11T08:30:00.000Z');
    expect(parsed!.transcriptPath).toBe(path);
  });

  it('codex parse extracts the session_meta envelope', async () => {
    const path = await writeCodexRollout('codex-sess-1', workspace);
    const parsed = await getAgentTarget('codex')!.sessions!.parse(path);

    expect(parsed).not.toBeNull();
    expect(parsed!.sessionId).toBe('codex-sess-1');
    expect(parsed!.cwd).toBe(workspace);
    expect(parsed!.startedAt).toBe('2026-06-11T08:00:00.000Z');
    expect(parsed!.endedAt).toBe('2026-06-11T08:45:00.000Z');
  });

  it('codex parse returns null for a non-session_meta file', async () => {
    const dir = join(codexRoot, 'flat');
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'rollout-bad.jsonl');
    await writeFile(path, '{"type":"other"}\n');
    expect(await getAgentTarget('codex')!.sessions!.parse(path)).toBeNull();
  });

  it('globs point at the expected roots', () => {
    expect(getAgentTarget('claude')!.sessions!.globs(claudeRoot)[0]).toContain(claudeRoot);
    expect(getAgentTarget('codex')!.sessions!.globs(codexRoot)[0]).toContain(codexRoot);
  });
});

describe('scanSessions', () => {
  it('upserts a fresh transcript as an active row with its real start timestamp', async () => {
    await writeClaudeTranscript('claude-live-1', workspace);

    const summary = await scanSessions({ full: true }, deps());

    expect(summary.discovered).toBe(1);
    expect(summary.inserted).toBe(1);
    const row = getSessionById('claude-live-1');
    expect(row!.status).toBe('active');
    expect(row!.agent).toBe('claude');
    expect(row!.path).toBe(workspace);
    expect(row!.started).toBe('2026-06-11T08:00:00.000Z');
  });

  it('upserts a stale transcript as stopped with ended backdated to the transcript endTs', async () => {
    const path = await writeClaudeTranscript('claude-old-1', workspace);
    await makeStale(path);

    await scanSessions({ full: true }, deps());

    const row = getSessionById('claude-old-1');
    expect(row!.status).toBe('stopped');
    expect(row!.ended).toBe('2026-06-11T08:30:00.000Z');
  });

  it('discovers codex sessions alongside claude', async () => {
    await writeClaudeTranscript('claude-both', workspace);
    await writeCodexRollout('codex-both', workspace);

    const summary = await scanSessions({ full: true }, deps());

    expect(summary.discovered).toBe(2);
    expect(getSessionById('codex-both')!.agent).toBe('codex');
  });

  it('links project/assignment from the workspace context.json (additive upsert)', async () => {
    await mkdir(join(workspace, '.syntaur'), { recursive: true });
    await writeFile(
      join(workspace, '.syntaur', 'context.json'),
      JSON.stringify({ projectSlug: 'proj-x', assignmentSlug: 'assn-y' }),
    );
    await writeClaudeTranscript('claude-linked', workspace);

    await scanSessions({ full: true }, deps());

    const row = getSessionById('claude-linked');
    expect(row!.projectSlug).toBe('proj-x');
    expect(row!.assignmentSlug).toBe('assn-y');
  });

  it('revives a stopped row to active on lsof live-process evidence', async () => {
    const path = await writeClaudeTranscript('claude-revive', workspace);
    await makeStale(path); // mtime says dead — lsof is the only live signal
    await appendSession('', makeSession({ sessionId: 'claude-revive' }));
    await updateSessionStatus('', 'claude-revive', 'stopped');

    const summary = await scanSessions(
      { full: true },
      deps({ openFiles: async () => new Set([path]) }),
    );

    expect(summary.revived).toBe(1);
    expect(getSessionById('claude-revive')!.status).toBe('active');
  });

  it('does NOT revive a stopped row on mtime freshness alone (only lsof evidence revives)', async () => {
    // Fresh transcript (just written) but no process holds it open — the
    // session was stopped by its SessionEnd hook moments ago and must stay
    // stopped, not flap back to active for the next 5 minutes of scan ticks.
    await writeClaudeTranscript('claude-fresh-stopped', workspace);
    await appendSession('', makeSession({ sessionId: 'claude-fresh-stopped' }));
    await updateSessionStatus('', 'claude-fresh-stopped', 'stopped');

    const summary = await scanSessions({ full: true }, deps());

    expect(summary.revived).toBe(0);
    expect(getSessionById('claude-fresh-stopped')!.status).toBe('stopped');
  });

  it('does NOT downgrade an active row with a live pid whose transcript went stale (idle session)', async () => {
    const path = await writeClaudeTranscript('claude-idle', workspace);
    await makeStale(path); // idle >5min — but the owning process is alive
    await appendSession(
      '',
      makeSession({
        sessionId: 'claude-idle',
        pid: 4242,
        pidStartedAt: 'Thu Jun 11 09:00:00 2026',
        transcriptPath: path,
      }),
    );

    await scanSessions(
      { full: true },
      deps({ isPidAlive: () => true, pidStartedAt: () => 'Thu Jun 11 09:00:00 2026' }),
    );

    expect(getSessionById('claude-idle')!.status).toBe('active');
  });

  it('never revives a completed row', async () => {
    const path = await writeClaudeTranscript('claude-done', workspace);
    await appendSession('', makeSession({ sessionId: 'claude-done' }));
    await updateSessionStatus('', 'claude-done', 'completed');

    await scanSessions({ full: true }, deps({ openFiles: async () => new Set([path]) }));

    expect(getSessionById('claude-done')!.status).toBe('completed');
  });

  it('autoTrack=off is a no-op', async () => {
    await writeClaudeTranscript('claude-ignored', workspace);

    const summary = await scanSessions({ full: true }, deps({ autoTrack: 'off' }));

    expect(summary.discovered).toBe(0);
    expect(getSessionById('claude-ignored')).toBeNull();
  });

  it('autoTrack=workspaces-only skips sessions whose cwd has no context.json', async () => {
    const bare = join(testDir, 'bare-dir');
    await mkdir(bare, { recursive: true });
    await mkdir(join(workspace, '.syntaur'), { recursive: true });
    await writeFile(join(workspace, '.syntaur', 'context.json'), '{}');
    await writeClaudeTranscript('claude-ws', workspace);
    await writeCodexRollout('codex-bare', bare);

    const summary = await scanSessions({ full: true }, deps({ autoTrack: 'workspaces-only' }));

    expect(summary.skipped).toBe(1);
    expect(getSessionById('claude-ws')).not.toBeNull();
    expect(getSessionById('codex-bare')).toBeNull();
  });

  it('sweeps an active row whose pid is dead and transcript is stale, backdating ended to mtime', async () => {
    const transcript = join(testDir, 'orphan.jsonl');
    await writeFile(transcript, '{}\n');
    const mtimeMs = await makeStale(transcript);
    await appendSession(
      '',
      makeSession({ sessionId: 'orphaned', pid: 99999, transcriptPath: transcript }),
    );

    const summary = await scanSessions({ full: true }, deps({ isPidAlive: () => false }));

    expect(summary.swept).toBe(1);
    const row = getSessionById('orphaned');
    expect(row!.status).toBe('stopped');
    expect(row!.ended).toBe(new Date(mtimeMs).toISOString());
  });

  it('does not sweep an active row whose pid is alive with a matching start time', async () => {
    await appendSession(
      '',
      makeSession({ sessionId: 'alive-row', pid: 1234, pidStartedAt: 'Thu Jun 11 09:00:00 2026' }),
    );

    await scanSessions(
      { full: true },
      deps({ isPidAlive: () => true, pidStartedAt: () => 'Thu Jun 11 09:00:00 2026' }),
    );

    expect(getSessionById('alive-row')!.status).toBe('active');
  });

  it('sweeps an active row whose pid was recycled (start time mismatch)', async () => {
    const transcript = join(testDir, 'recycled.jsonl');
    await writeFile(transcript, '{}\n');
    await makeStale(transcript);
    await appendSession(
      '',
      makeSession({
        sessionId: 'recycled-row',
        pid: 1234,
        pidStartedAt: 'Thu Jun 11 09:00:00 2026',
        transcriptPath: transcript,
      }),
    );

    const summary = await scanSessions(
      { full: true },
      deps({ isPidAlive: () => true, pidStartedAt: () => 'Fri Jun 12 01:00:00 2026' }),
    );

    expect(summary.swept).toBe(1);
    expect(getSessionById('recycled-row')!.status).toBe('stopped');
  });

  it('does not sweep an active row held open per lsof even when mtime is stale', async () => {
    const transcript = join(testDir, 'held.jsonl');
    await writeFile(transcript, '{}\n');
    await makeStale(transcript);
    await appendSession(
      '',
      makeSession({ sessionId: 'held-row', pid: 99999, transcriptPath: transcript }),
    );

    await scanSessions(
      { full: true },
      deps({ isPidAlive: () => false, openFiles: async () => new Set([transcript]) }),
    );

    expect(getSessionById('held-row')!.status).toBe('active');
  });

  it('incremental scans honor the mtime watermark; --full ignores it', async () => {
    // Backdate the fixture so it sits clearly below the watermark — files
    // written in the same millisecond a scan starts are deliberately
    // rediscovered (at-least-once boundary; the upsert is idempotent).
    const path = await writeClaudeTranscript('claude-wm', workspace);
    await makeStale(path);

    const first = await scanSessions({}, deps());
    expect(first.discovered).toBe(1);

    // Unchanged files fall below the watermark on the next incremental pass.
    const second = await scanSessions({}, deps());
    expect(second.discovered).toBe(0);

    const full = await scanSessions({ full: true }, deps());
    expect(full.discovered).toBe(1);
  });
});
