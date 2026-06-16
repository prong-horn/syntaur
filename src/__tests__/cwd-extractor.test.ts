import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  extractClaudeSessionMeta,
  extractCodexSessionMeta,
  extractPiSessionMeta,
  walkClaudeProjects,
  walkCodexSessions,
  walkPiSessions,
  resolveCodexSessionsRoot,
  resolvePiSessionsRoot,
} from '../usage/cwd-extractor.js';
import { extractSessionId } from '../usage/ccusage-parse.js';

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

// --- Pi --------------------------------------------------------------------

const PI_FIXTURE_UUID = '019e97a7-2b1b-7afa-b080-cbb305f1412e';
const PI_FIXTURE_FILENAME = `2026-06-05T11-59-35-707Z_${PI_FIXTURE_UUID}.jsonl`;
const PI_FIXTURE_ROOT = new URL('./fixtures/pi-sessions', import.meta.url).pathname;

async function writePiTranscript(
  sessionsRoot: string,
  cwdSlug: string,
  filename: string,
  lines: object[],
) {
  const dir = resolve(sessionsRoot, cwdSlug);
  await mkdir(dir, { recursive: true });
  const filePath = resolve(dir, filename);
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  await writeFile(filePath, body);
  return filePath;
}

describe('extractPiSessionMeta', () => {
  it('extracts sessionId (uuid suffix), cwd (first-line field), startTs, endTs', async () => {
    const filePath = resolve(
      PI_FIXTURE_ROOT,
      '--Users-test-proj--',
      PI_FIXTURE_FILENAME,
    );
    const meta = await extractPiSessionMeta(filePath);
    expect(meta).not.toBeNull();
    expect(meta?.tool).toBe('pi');
    expect(meta?.sessionId).toBe(PI_FIXTURE_UUID);
    expect(meta?.cwd).toBe('/Users/test/proj');
    expect(meta?.startTs).toBe('2026-06-05T11:59:35.707Z');
    expect(meta?.endTs).toBe('2026-06-05T12:05:00.000Z');
    expect(meta?.path).toBe(filePath);
  });

  it('returns null when first line has no cwd field', async () => {
    const dir = resolve(sandbox, 'pi-nocwd', '--slug--');
    await mkdir(dir, { recursive: true });
    const filePath = resolve(dir, `2026-06-05T00-00-00-000Z_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl`);
    await writeFile(
      filePath,
      JSON.stringify({ type: 'session-start', version: 1, id: 'x', timestamp: '2026-06-05T00:00:00.000Z' }) + '\n',
    );
    const meta = await extractPiSessionMeta(filePath);
    expect(meta).toBeNull();
  });

  it('returns null when first line is invalid/truncated JSON', async () => {
    const dir = resolve(sandbox, 'pi-badjson', '--slug--');
    await mkdir(dir, { recursive: true });
    const filePath = resolve(dir, `2026-06-05T00-00-00-000Z_cccccccc-dddd-eeee-ffff-000000000000.jsonl`);
    await writeFile(filePath, '{bad json\n');
    const meta = await extractPiSessionMeta(filePath);
    expect(meta).toBeNull();
  });

  it('returns null when filename has no underscore', async () => {
    const dir = resolve(sandbox, 'pi-badname', '--slug--');
    await mkdir(dir, { recursive: true });
    const filePath = resolve(dir, 'noseparator.jsonl');
    await writeFile(
      filePath,
      JSON.stringify({ type: 'session-start', version: 1, id: 'x', timestamp: '2026-06-05T00:00:00.000Z', cwd: '/x' }) + '\n',
    );
    const meta = await extractPiSessionMeta(filePath);
    expect(meta).toBeNull();
  });
});

describe('walkPiSessions', () => {
  it('yields one entry per session file with correct sessionId and cwd', async () => {
    const results: { sessionId: string; cwd: string }[] = [];
    for await (const meta of walkPiSessions({ root: PI_FIXTURE_ROOT })) {
      results.push({ sessionId: meta.sessionId, cwd: meta.cwd });
    }
    expect(results).toHaveLength(1);
    expect(results[0].sessionId).toBe(PI_FIXTURE_UUID);
    expect(results[0].cwd).toBe('/Users/test/proj');
  });

  it('respects sinceMtimeMs filter — future cutoff excludes the fixture', async () => {
    const futureCutoff = Date.now() + 1_000_000_000;
    const results = [];
    for await (const meta of walkPiSessions({ root: PI_FIXTURE_ROOT, sinceMtimeMs: futureCutoff })) {
      results.push(meta);
    }
    expect(results).toHaveLength(0);
  });

  it('respects sinceMtimeMs filter — past cutoff includes the fixture', async () => {
    const pastCutoff = new Date('2020-01-01').getTime();
    const results = [];
    for await (const meta of walkPiSessions({ root: PI_FIXTURE_ROOT, sinceMtimeMs: pastCutoff })) {
      results.push(meta);
    }
    expect(results).toHaveLength(1);
  });

  it('cwd cache reuses first-file cwd for subsequent files in same dir', async () => {
    const piRoot = resolve(sandbox, 'pi-sessions');
    const slug = '--Users-cache-test--';
    await writePiTranscript(piRoot, slug, `2026-06-05T10-00-00-000Z_aaaaaaaa-1111-2222-3333-444444444444.jsonl`, [
      { type: 'session-start', version: 1, id: 'x', timestamp: '2026-06-05T10:00:00.000Z', cwd: '/Users/cache/test' },
      { type: 'assistant', timestamp: '2026-06-05T10:05:00.000Z' },
    ]);
    // Second file intentionally has no cwd — relies on dir cache.
    await writePiTranscript(piRoot, slug, `2026-06-05T11-00-00-000Z_bbbbbbbb-5555-6666-7777-888888888888.jsonl`, [
      { type: 'assistant', timestamp: '2026-06-05T11:05:00.000Z' },
    ]);

    const results = [];
    for await (const meta of walkPiSessions({ root: piRoot })) {
      results.push(meta);
    }
    expect(results).toHaveLength(2);
    expect(results.every((m) => m.cwd === '/Users/cache/test')).toBe(true);
    // Assert as a set so the assertion holds regardless of readdir order.
    const byId = new Map(results.map((m) => [m.sessionId, m]));
    expect(byId.has('aaaaaaaa-1111-2222-3333-444444444444')).toBe(true);
    expect(byId.has('bbbbbbbb-5555-6666-7777-888888888888')).toBe(true);
  });

  it('does not drop a later cwd-bearing session when a no-cwd file sorts first', async () => {
    const piRoot = resolve(sandbox, 'pi-fallback');
    const slug = '--Users-test-proj--';
    // This file sorts FIRST lexicographically and has NO cwd field on line 1.
    await writePiTranscript(
      piRoot,
      slug,
      `2026-06-05T01-00-00-000Z_aaaaaaaa-0000-0000-0000-000000000001.jsonl`,
      [{ type: 'x', timestamp: '2026-06-05T01:00:00.000Z', id: 'x' }],
    );
    // This file sorts LATER and DOES have cwd on line 1.
    await writePiTranscript(
      piRoot,
      slug,
      `2026-06-05T02-00-00-000Z_bbbbbbbb-0000-0000-0000-000000000002.jsonl`,
      [
        { type: 'session-start', version: 1, id: 'bbbbbbbb-0000-0000-0000-000000000002', timestamp: '2026-06-05T02:00:00.000Z', cwd: '/Users/test/proj' },
        { type: 'assistant', timestamp: '2026-06-05T02:05:00.000Z' },
      ],
    );

    const results = [];
    for await (const meta of walkPiSessions({ root: piRoot })) {
      results.push(meta);
    }
    // The no-cwd file is correctly skipped; the later cwd-bearing file is NOT dropped.
    expect(results).toHaveLength(1);
    expect(results[0].sessionId).toBe('bbbbbbbb-0000-0000-0000-000000000002');
    expect(results[0].cwd).toBe('/Users/test/proj');
  });
});

describe('extractSessionId pi passthrough', () => {
  it('passes pi period through unchanged (bare UUID)', () => {
    const period = PI_FIXTURE_UUID;
    expect(extractSessionId('pi', period)).toBe(PI_FIXTURE_UUID);
  });

  it('matches walker-derived sessionId for the fixture file', async () => {
    const results = [];
    for await (const meta of walkPiSessions({ root: PI_FIXTURE_ROOT })) {
      results.push(meta);
    }
    const walkerSessionId = results[0]?.sessionId;
    expect(walkerSessionId).toBe(extractSessionId('pi', PI_FIXTURE_UUID));
  });
});

describe('resolvePiSessionsRoot', () => {
  it('uses PI_AGENT_DIR env var as pi home, appends sessions/', () => {
    process.env.PI_AGENT_DIR = '/pi/home';
    expect(resolvePiSessionsRoot()).toBe('/pi/home/sessions');
    delete process.env.PI_AGENT_DIR;
  });

  it('falls back to ~/.pi/agent/sessions', () => {
    delete process.env.PI_AGENT_DIR;
    expect(resolvePiSessionsRoot()).toMatch(/\.pi\/agent\/sessions$/);
  });

  it('override parameter takes priority', () => {
    process.env.PI_AGENT_DIR = '/pi/home';
    expect(resolvePiSessionsRoot('/explicit/pi-sessions')).toBe('/explicit/pi-sessions');
    delete process.env.PI_AGENT_DIR;
  });
});
