import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  extractClaudeSessionMeta,
  extractCodexSessionMeta,
  walkClaudeProjects,
  walkCodexSessions,
  resolveCodexSessionsRoot,
} from '../usage/cwd-extractor.js';

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-cwd-extractor-'));
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

// --- helpers ---------------------------------------------------------------

async function writeClaudeTranscript(
  projectsRoot: string,
  cwdSlug: string,
  sessionId: string,
  lines: object[],
) {
  const dir = resolve(projectsRoot, cwdSlug);
  await mkdir(dir, { recursive: true });
  const filePath = resolve(dir, `${sessionId}.jsonl`);
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  await writeFile(filePath, body);
  return filePath;
}

async function writeCodexRollout(
  sessionsRoot: string,
  relPath: string,
  payload: { id: string; cwd: string },
  topLevelTimestamp: string,
  extraLines: object[] = [],
) {
  const filePath = resolve(sessionsRoot, relPath);
  await mkdir(resolve(filePath, '..'), { recursive: true });
  const meta = {
    type: 'session_meta',
    timestamp: topLevelTimestamp,
    payload,
  };
  const body = [meta, ...extraLines].map((l) => JSON.stringify(l)).join('\n') + '\n';
  await writeFile(filePath, body);
  return filePath;
}

// --- Claude ----------------------------------------------------------------

describe('extractClaudeSessionMeta', () => {
  it('extracts sessionId, cwd, startTs, endTs', async () => {
    const projects = resolve(sandbox, 'projects');
    const filePath = await writeClaudeTranscript(
      projects,
      '-Users-dev-proj',
      'abc-123',
      [
        { type: 'permission-mode' },
        { type: 'user', cwd: '/Users/dev/proj', sessionId: 'abc-123', timestamp: '2026-05-21T12:00:00.000Z' },
        { type: 'assistant', cwd: '/Users/dev/proj', sessionId: 'abc-123', timestamp: '2026-05-21T12:05:00.000Z' },
      ],
    );

    const meta = await extractClaudeSessionMeta(filePath);
    expect(meta).not.toBeNull();
    expect(meta?.sessionId).toBe('abc-123');
    expect(meta?.cwd).toBe('/Users/dev/proj');
    expect(meta?.startTs).toBe('2026-05-21T12:00:00.000Z');
    expect(meta?.endTs).toBe('2026-05-21T12:05:00.000Z');
    expect(meta?.path).toBe(filePath);
  });

  it('returns null when transcript has no cwd', async () => {
    const projects = resolve(sandbox, 'projects');
    const filePath = await writeClaudeTranscript(projects, '-Users-dev-proj', 'no-cwd', [
      { type: 'permission-mode' },
    ]);
    const meta = await extractClaudeSessionMeta(filePath);
    expect(meta).toBeNull();
  });
});

describe('walkClaudeProjects', () => {
  it('yields one entry per session file and caches cwd per directory', async () => {
    const projects = resolve(sandbox, 'projects');
    await writeClaudeTranscript(projects, '-Users-dev-proj', 'sess-1', [
      { type: 'user', cwd: '/Users/dev/proj', sessionId: 'sess-1', timestamp: '2026-05-21T12:00:00.000Z' },
    ]);
    await writeClaudeTranscript(projects, '-Users-dev-proj', 'sess-2', [
      // Note: this transcript intentionally has NO cwd — cache from sess-1 fills in.
      { type: 'assistant', sessionId: 'sess-2', timestamp: '2026-05-21T13:00:00.000Z' },
    ]);

    const results = [];
    for await (const meta of walkClaudeProjects({ root: projects })) {
      results.push(meta);
    }
    expect(results).toHaveLength(2);
    expect(results.every((m) => m.cwd === '/Users/dev/proj')).toBe(true);
    const ids = results.map((m) => m.sessionId).sort();
    expect(ids).toEqual(['sess-1', 'sess-2']);
  });

  it('respects sinceMtimeMs filter', async () => {
    const projects = resolve(sandbox, 'projects');
    const old = await writeClaudeTranscript(projects, '-Users-dev-old', 'old', [
      { type: 'user', cwd: '/Users/dev/old', sessionId: 'old', timestamp: '2026-04-01T00:00:00.000Z' },
    ]);
    await writeClaudeTranscript(projects, '-Users-dev-new', 'new', [
      { type: 'user', cwd: '/Users/dev/new', sessionId: 'new', timestamp: '2026-05-21T00:00:00.000Z' },
    ]);
    // Backdate the old file's mtime.
    const { utimes } = await import('node:fs/promises');
    const oldEpoch = new Date('2026-04-01').getTime() / 1000;
    await utimes(old, oldEpoch, oldEpoch);

    const cutoff = new Date('2026-05-01').getTime();
    const results = [];
    for await (const meta of walkClaudeProjects({ root: projects, sinceMtimeMs: cutoff })) {
      results.push(meta);
    }
    expect(results.map((m) => m.sessionId)).toEqual(['new']);
  });
});

// --- Codex -----------------------------------------------------------------

describe('extractCodexSessionMeta', () => {
  it('reads top-level timestamp + payload.{id,cwd}', async () => {
    const sessions = resolve(sandbox, 'codex-sessions');
    const filePath = await writeCodexRollout(
      sessions,
      '2026/05/21/rollout-2026-05-21T12-00-00-abc.jsonl',
      { id: '019d8738-1168-7040-9a75-f6b5573959af', cwd: '/Users/dev/proj' },
      '2026-05-21T12:00:00.000Z',
      [{ type: 'user_message', timestamp: '2026-05-21T12:30:00.000Z' }],
    );

    const meta = await extractCodexSessionMeta(filePath);
    expect(meta).not.toBeNull();
    expect(meta?.sessionId).toBe('019d8738-1168-7040-9a75-f6b5573959af');
    expect(meta?.cwd).toBe('/Users/dev/proj');
    expect(meta?.startTs).toBe('2026-05-21T12:00:00.000Z');
    expect(meta?.endTs).toBe('2026-05-21T12:30:00.000Z');
  });

  it('returns null when line 1 is not session_meta', async () => {
    const sessions = resolve(sandbox, 'codex-sessions');
    const filePath = resolve(sessions, '2026/05/21/rollout-bad.jsonl');
    await mkdir(resolve(filePath, '..'), { recursive: true });
    await writeFile(filePath, JSON.stringify({ type: 'something_else' }) + '\n');
    const meta = await extractCodexSessionMeta(filePath);
    expect(meta).toBeNull();
  });

  it('returns null when timestamp is in the wrong place (payload-level)', async () => {
    const sessions = resolve(sandbox, 'codex-sessions');
    const filePath = resolve(sessions, '2026/05/21/rollout-payload-ts.jsonl');
    await mkdir(resolve(filePath, '..'), { recursive: true });
    // Intentionally put timestamp inside payload — should NOT be accepted.
    await writeFile(
      filePath,
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'x', cwd: '/x', timestamp: '2026-05-21T12:00:00.000Z' },
      }) + '\n',
    );
    const meta = await extractCodexSessionMeta(filePath);
    expect(meta).toBeNull();
  });
});

describe('walkCodexSessions', () => {
  it('walks the YYYY/MM/DD layout', async () => {
    const sessions = resolve(sandbox, 'codex-sessions');
    await writeCodexRollout(
      sessions,
      '2026/05/20/rollout-a.jsonl',
      { id: 'a', cwd: '/A' },
      '2026-05-20T00:00:00.000Z',
    );
    await writeCodexRollout(
      sessions,
      '2026/05/21/rollout-b.jsonl',
      { id: 'b', cwd: '/B' },
      '2026-05-21T00:00:00.000Z',
    );

    const results = [];
    for await (const meta of walkCodexSessions({ root: sessions })) {
      results.push(meta);
    }
    expect(results).toHaveLength(2);
    expect(results.map((m) => m.sessionId).sort()).toEqual(['a', 'b']);
  });

  it('honors CODEX_SESSIONS_DIR via resolveCodexSessionsRoot', () => {
    process.env.CODEX_SESSIONS_DIR = '/explicit/path';
    expect(resolveCodexSessionsRoot()).toBe('/explicit/path');
    delete process.env.CODEX_SESSIONS_DIR;

    process.env.CODEX_HOME = '/codex/home';
    expect(resolveCodexSessionsRoot()).toBe('/codex/home/sessions');
    delete process.env.CODEX_HOME;

    expect(resolveCodexSessionsRoot()).toMatch(/\.codex\/sessions$/);
  });
});
