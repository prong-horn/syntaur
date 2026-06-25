import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, utimes, symlink } from 'node:fs/promises';
import { statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
  getSessionDb,
} from '../dashboard/session-db.js';
import {
  appendSession,
  getSessionById,
  updateSessionStatus,
} from '../dashboard/agent-sessions.js';
import { openEngagement, type EngagementRow } from '../db/engagement-db.js';
import { scanSessions, type ScannerDeps } from '../sessions/scanner.js';
import { getAgentTarget } from '../targets/registry.js';
import type { AgentSession, AgentSessionStatus } from '../dashboard/types.js';

function latestEngagement(sessionId: string): EngagementRow | undefined {
  return getSessionDb()
    .prepare('SELECT * FROM engagement WHERE session_id = ? ORDER BY id DESC LIMIT 1')
    .get(sessionId) as EngagementRow | undefined;
}

let testDir: string;
let claudeRoot: string;
let codexRoot: string;
let piRoot: string;
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

/** Hermetic deps: fixture roots for both descriptor-bearing targets, no lsof/ps.
 *  agentView defaults to an empty map (no Agent-View evidence) so the scanner is
 *  never tempted to spawn `claude agents --json` in unit tests. */
function deps(overrides: Partial<ScannerDeps> = {}): ScannerDeps {
  return {
    roots: { claude: claudeRoot, codex: codexRoot, pi: piRoot },
    autoTrack: 'all',
    openFiles: async () => new Set<string>(),
    isPidAlive: () => false,
    pidStartedAt: () => null,
    agentView: async () => new Map(),
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

/**
 * Write a Pi transcript fixture; returns its path. Pi lays files out as
 * `<root>/<encoded-cwd>/<ts>_<uuid>.jsonl`; the sessionId is the filename suffix
 * after the last `_`. Line 1 is a `{type:'session',...,cwd}` envelope.
 */
async function writePiTranscript(
  sessionId: string,
  cwd: string,
  timestamp = '2026-06-11T08:00:00.000Z',
): Promise<string> {
  const dir = join(piRoot, '--encoded-cwd--');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `2026-06-11T08-00-00-000Z_${sessionId}.jsonl`);
  await writeFile(
    path,
    `${JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp, cwd })}\n${JSON.stringify({ type: 'message', timestamp: '2026-06-11T08:50:00.000Z' })}\n`,
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
  piRoot = join(testDir, 'pi-sessions');
  workspace = join(testDir, 'workspace');
  await mkdir(claudeRoot, { recursive: true });
  await mkdir(codexRoot, { recursive: true });
  await mkdir(piRoot, { recursive: true });
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

  it('pi parse extracts sessionId (from filename) + cwd/timestamps from a transcript', async () => {
    const path = await writePiTranscript('pi-sess-1', workspace);
    const parsed = await getAgentTarget('pi')!.sessions!.parse(path);

    expect(parsed).not.toBeNull();
    expect(parsed!.sessionId).toBe('pi-sess-1');
    expect(parsed!.cwd).toBe(workspace);
    expect(parsed!.startedAt).toBe('2026-06-11T08:00:00.000Z');
    expect(parsed!.endedAt).toBe('2026-06-11T08:50:00.000Z');
    expect(parsed!.transcriptPath).toBe(path);
  });

  it('globs point at the expected roots', () => {
    expect(getAgentTarget('claude')!.sessions!.globs(claudeRoot)[0]).toContain(claudeRoot);
    expect(getAgentTarget('codex')!.sessions!.globs(codexRoot)[0]).toContain(codexRoot);
    expect(getAgentTarget('pi')!.sessions!.globs(piRoot)[0]).toContain(piRoot);
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

  it('discovers and registers pi sessions (regression: pi had no sessions descriptor)', async () => {
    await writePiTranscript('pi-live-1', workspace);

    const summary = await scanSessions({ full: true }, deps());

    expect(summary.discovered).toBe(1);
    expect(summary.inserted).toBe(1);
    const row = getSessionById('pi-live-1');
    expect(row).not.toBeNull();
    expect(row!.agent).toBe('pi');
    expect(row!.path).toBe(workspace);
    expect(row!.started).toBe('2026-06-11T08:00:00.000Z');
  });

  it('does NOT auto-bind project/assignment from the workspace context.json (unattributed)', async () => {
    // Behavior change: the scanner no longer pulls projectSlug/assignmentSlug
    // out of context.json to attribute a discovered session. That auto-binding
    // clobbered the active assignment across co-located sessions. Discovered
    // sessions stay unattributed until an explicit grab/track opens an
    // engagement edge. The workspace marker still registers the session (the
    // file existing is enough); only the scalar attribution is dropped.
    await mkdir(join(workspace, '.syntaur'), { recursive: true });
    await writeFile(
      join(workspace, '.syntaur', 'context.json'),
      JSON.stringify({ projectSlug: 'proj-x', assignmentSlug: 'assn-y' }),
    );
    await writeClaudeTranscript('claude-linked', workspace);

    await scanSessions({ full: true }, deps());

    const row = getSessionById('claude-linked');
    expect(row).not.toBeNull();
    expect(row!.projectSlug).toBeNull();
    expect(row!.assignmentSlug).toBeNull();
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

  it('revives a stopped row when the discovered transcript carries a symlinked-root spelling', async () => {
    // Discovery-side companion to the sweep test below: the walker yields the
    // symlinked spelling (root pointed through a symlink) while lsof reports
    // the realpath. Without canonicalizing both sides at the discovery
    // comparison, held-open evidence would be missed and the stopped row would
    // never revive.
    const realPath = await writeClaudeTranscript('claude-revive-sym', workspace);
    await makeStale(realPath); // mtime says dead — lsof is the only live signal
    await appendSession('', makeSession({ sessionId: 'claude-revive-sym' }));
    await updateSessionStatus('', 'claude-revive-sym', 'stopped');

    const claudeLink = join(testDir, 'claude-projects-link');
    await symlink(claudeRoot, claudeLink);
    const linkedSpelling = join(claudeLink, 'some-encoded-cwd', 'claude-revive-sym.jsonl');
    // Sanity: the discovered spelling differs from the open-set spelling, but
    // both resolve to the same on-disk file.
    expect(linkedSpelling).not.toBe(realPath);
    expect(realpathSync(linkedSpelling)).toBe(realpathSync(realPath));

    const summary = await scanSessions(
      { full: true },
      deps({
        roots: { claude: claudeLink, codex: codexRoot, pi: piRoot },
        openFiles: async () => new Set([realPath]),
      }),
    );

    expect(summary.revived).toBe(1);
    expect(getSessionById('claude-revive-sym')!.status).toBe('active');
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

  it('does not sweep a held-open transcript when lsof reports a symlinked-root spelling', async () => {
    // Real lsof canonicalizes symlinked roots (/var → /private/var), so the
    // open-set spelling differs from the discovered transcriptPath. A real
    // on-disk symlink fixture makes this portable (not macOS /var-specific):
    // the row stores the symlinked spelling while lsof reports the realpath.
    const realDir = join(testDir, 'real-sessions');
    await mkdir(realDir, { recursive: true });
    const linkDir = join(testDir, 'link-sessions');
    await symlink(realDir, linkDir);

    const realTranscript = join(realDir, 'held-sym.jsonl');
    await writeFile(realTranscript, '{}\n');
    await makeStale(realTranscript);

    const linkedSpelling = join(linkDir, 'held-sym.jsonl');
    // Sanity: the two spellings differ but realpath-resolve to the same file.
    expect(linkedSpelling).not.toBe(realpathSync(linkedSpelling));

    await appendSession(
      '',
      makeSession({ sessionId: 'held-sym-row', pid: 99999, transcriptPath: linkedSpelling }),
    );

    await scanSessions(
      { full: true },
      // lsof reports the canonical (realDir) spelling, not the symlinked one.
      deps({
        isPidAlive: () => false,
        openFiles: async () => new Set([realpathSync(linkedSpelling)]),
      }),
    );

    // Without canonicalization on both sides the spellings mismatch and the row
    // is swept to 'stopped'; with the fix it stays 'active'.
    expect(getSessionById('held-sym-row')!.status).toBe('active');
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

describe('scanSessions — liveness engagement GC (#5)', () => {
  it('closes the swept session\'s open engagement with close_reason=liveness_gc', async () => {
    const transcript = join(testDir, 'gc-orphan.jsonl');
    await writeFile(transcript, '{}\n');
    const mtimeMs = await makeStale(transcript);
    await appendSession(
      '',
      makeSession({ sessionId: 'gc-dead', pid: 99999, transcriptPath: transcript }),
    );
    // Bind it to an assignment via an OPEN engagement (the dangling interval).
    openEngagement({
      sessionId: 'gc-dead',
      projectSlug: 'proj',
      assignmentSlug: 'assn',
      stage: 'implement',
      startedAt: '2026-06-11T08:00:00.000Z',
    });

    const summary = await scanSessions({ full: true }, deps({ isPidAlive: () => false }));

    expect(summary.swept).toBe(1);
    expect(getSessionById('gc-dead')!.status).toBe('stopped');
    const eng = latestEngagement('gc-dead')!;
    expect(eng.close_reason).toBe('liveness_gc');
    expect(eng.ended_at).toBe(new Date(mtimeMs).toISOString());
    // AC3: the GC preserves the binding (it closes the interval, never retracts
    // the attribution) — assignment_slug survives the close.
    expect(eng.assignment_slug).toBe('assn');
  });

  it('GC does not emit a second abandoned close (exactly one liveness_gc interval)', async () => {
    const transcript = join(testDir, 'gc-one.jsonl');
    await writeFile(transcript, '{}\n');
    await makeStale(transcript);
    await appendSession(
      '',
      makeSession({ sessionId: 'gc-one', pid: 99999, transcriptPath: transcript }),
    );
    openEngagement({
      sessionId: 'gc-one',
      projectSlug: 'proj',
      assignmentSlug: 'assn',
      stage: 'implement',
      startedAt: '2026-06-11T08:00:00.000Z',
    });

    await scanSessions({ full: true }, deps({ isPidAlive: () => false }));

    const rows = getSessionDb()
      .prepare('SELECT close_reason FROM engagement WHERE session_id = ?')
      .all('gc-one') as Array<{ close_reason: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].close_reason).toBe('liveness_gc');
  });

  it('sweeps a dead session with NO engagement without throwing (no-op close)', async () => {
    const transcript = join(testDir, 'gc-noeng.jsonl');
    await writeFile(transcript, '{}\n');
    await makeStale(transcript);
    await appendSession(
      '',
      makeSession({ sessionId: 'gc-noeng', pid: 99999, transcriptPath: transcript }),
    );

    const summary = await scanSessions({ full: true }, deps({ isPidAlive: () => false }));

    expect(summary.swept).toBe(1);
    expect(getSessionById('gc-noeng')!.status).toBe('stopped');
    expect(latestEngagement('gc-noeng')).toBeUndefined();
  });
});

describe('scanSessions — Agent-View liveness + activity (#5)', () => {
  it('keeps a session alive (not swept) when Agent View reports it live despite a dead pid', async () => {
    const transcript = join(testDir, 'av-live.jsonl');
    await writeFile(transcript, '{}\n');
    await makeStale(transcript); // stale transcript + dead pid → would be swept
    await appendSession(
      '',
      makeSession({ sessionId: 'av-live', pid: 99999, transcriptPath: transcript }),
    );

    const summary = await scanSessions(
      { full: true },
      deps({
        isPidAlive: () => false,
        agentView: async () => new Map([['av-live', 'working']]),
      }),
    );

    expect(summary.swept).toBe(0);
    const row = getSessionById('av-live')!;
    expect(row.status).toBe('active');
    // activity wired end-to-end: populated by the probe + surfaced by rowToSession.
    expect(row.activity).toBe('working');
  });

  it('Agent-View absence is NOT death evidence (a live-by-pid session is not swept)', async () => {
    await appendSession(
      '',
      makeSession({
        sessionId: 'av-absent',
        pid: 1234,
        pidStartedAt: 'Thu Jun 11 09:00:00 2026',
      }),
    );

    await scanSessions(
      { full: true },
      deps({
        isPidAlive: () => true,
        pidStartedAt: () => 'Thu Jun 11 09:00:00 2026',
        agentView: async () => new Map(), // absent from Agent View
      }),
    );

    // Absence alone never marks dead — the live pid keeps it active.
    expect(getSessionById('av-absent')!.status).toBe('active');
    expect(getSessionById('av-absent')!.activity ?? null).toBeNull();
  });

  it('falls back to pid/transcript when the Agent-View source throws (no regression)', async () => {
    const transcript = join(testDir, 'av-throw.jsonl');
    await writeFile(transcript, '{}\n');
    await makeStale(transcript);
    await appendSession(
      '',
      makeSession({ sessionId: 'av-throw', pid: 99999, transcriptPath: transcript }),
    );

    const summary = await scanSessions(
      { full: true },
      deps({
        isPidAlive: () => false,
        agentView: async () => {
          throw new Error('claude agents --json unavailable');
        },
      }),
    );

    // The dead session is still swept; the throwing probe degrades to empty.
    expect(summary.swept).toBe(1);
    expect(getSessionById('av-throw')!.status).toBe('stopped');
  });

  it('revives a stopped row when Agent View reports it live (reuse the revival path)', async () => {
    const path = await writeClaudeTranscript('av-revive', workspace);
    await makeStale(path); // mtime says dead; no lsof — Agent View is the live signal
    await appendSession('', makeSession({ sessionId: 'av-revive' }));
    await updateSessionStatus('', 'av-revive', 'stopped');

    const summary = await scanSessions(
      { full: true },
      deps({ agentView: async () => new Map([['av-revive', 'idle']]) }),
    );

    expect(summary.revived).toBe(1);
    expect(getSessionById('av-revive')!.status).toBe('active');
  });
});
