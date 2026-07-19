import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
  getSessionDb,
} from '../dashboard/session-db.js';
import {
  appendSession,
  getSessionById,
  claimSummarize,
  releaseSummarize,
  recordSummarizeFailure,
  finalizeSummarize,
  listSessionsNeedingSummary,
} from '../dashboard/agent-sessions.js';
import * as agentSessions from '../dashboard/agent-sessions.js';
import {
  summarizeSession,
  summarizeMissing,
  parseSummaryResponse,
  extractFirstJsonObject,
  countByKind,
  type SummarizeBackend,
} from '../sessions/summarizer.js';
import type { AgentSession } from '../dashboard/types.js';

let testDir: string;
let dbPath: string;
let prevHome: string | undefined;

/** A backend that always returns the same canned reply. */
function fakeBackend(text: string): SummarizeBackend {
  return async () => ({ ok: true, text });
}
const goodReply = JSON.stringify({ description: 'Fixed the login bug', summary: 'Traced and fixed it.' });

async function seed(
  sessionId: string,
  overrides: Partial<AgentSession> = {},
  withTranscript = true,
): Promise<string> {
  const transcriptPath = resolve(testDir, `${sessionId}.jsonl`);
  if (withTranscript) {
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({ type: 'user', message: { content: 'fix the login bug' } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'On it.' }] } }),
      ].join('\n') + '\n',
    );
  }
  await appendSession('', {
    projectSlug: null,
    assignmentSlug: null,
    agent: 'claude',
    sessionId,
    started: '2026-07-01T10:00:00.000Z',
    status: 'stopped',
    path: '/w/a',
    transcriptPath: withTranscript ? transcriptPath : null,
    ...overrides,
  } as AgentSession);
  return transcriptPath;
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-summarizer-'));
  dbPath = resolve(testDir, 'syntaur.db');
  prevHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = resolve(testDir, 'home');
  resetSessionDb();
  initSessionDb(dbPath);
});

afterEach(async () => {
  closeSessionDb();
  if (prevHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = prevHome;
  await rm(testDir, { recursive: true, force: true });
});

describe('extractFirstJsonObject', () => {
  it('finds a bare object', () => {
    expect(extractFirstJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it('ignores braces inside string literals', () => {
    const text = '{"a":"a } brace","b":2}';
    expect(extractFirstJsonObject(text)).toBe(text);
  });

  it('handles escaped quotes inside strings', () => {
    const text = '{"a":"she said \\"} \\" ok","b":2}';
    expect(extractFirstJsonObject(text)).toBe(text);
  });

  it('returns the FIRST balanced object when several are present', () => {
    expect(extractFirstJsonObject('{"a":1} trailing {"b":2}')).toBe('{"a":1}');
  });

  it('handles nested objects', () => {
    expect(extractFirstJsonObject('noise {"a":{"b":1}} more')).toBe('{"a":{"b":1}}');
  });

  it('returns null for truncated output', () => {
    expect(extractFirstJsonObject('{"a":1')).toBeNull();
  });

  it('returns null when there is no object at all', () => {
    expect(extractFirstJsonObject('plain text')).toBeNull();
  });
});

describe('parseSummaryResponse', () => {
  it('parses a clean JSON reply', () => {
    const out = parseSummaryResponse('{"description":"d","summary":"s"}');
    expect(out).toEqual({ description: 'd', summary: 's' });
  });

  it('parses a fenced reply', () => {
    const out = parseSummaryResponse('```json\n{"description":"d","summary":"s"}\n```');
    expect(out).toEqual({ description: 'd', summary: 's' });
  });

  it('parses a reply with prose before and after', () => {
    const out = parseSummaryResponse('Sure! {"description":"d","summary":"s"} Hope that helps.');
    expect(out).toEqual({ description: 'd', summary: 's' });
  });

  it('rejects garbage', () => {
    expect(parseSummaryResponse('no json here')).toBeNull();
  });

  it('salvages truncation that occurs AFTER both fields are complete', () => {
    // Missing only the closing brace — both string values are intact, so the
    // lenient field extractor recovers them rather than wasting the call.
    expect(parseSummaryResponse('{"description":"d","summary":"s"')).toEqual({
      description: 'd',
      summary: 's',
    });
  });

  it('rejects truncation in the middle of a field value', () => {
    // The summary string is cut mid-value with no closing quote — unrecoverable.
    expect(parseSummaryResponse('{"description":"d","summary":"the summary was cut off here')).toBeNull();
  });

  it('rejects wrong field types', () => {
    expect(parseSummaryResponse('{"description":123,"summary":"s"}')).toBeNull();
    expect(parseSummaryResponse('{"description":"d","summary":null}')).toBeNull();
  });

  it('rejects empty strings', () => {
    expect(parseSummaryResponse('{"description":"","summary":"s"}')).toBeNull();
    expect(parseSummaryResponse('{"description":"d","summary":"   "}')).toBeNull();
  });

  it('salvages the object from an array-wrapped reply', () => {
    // A bare array is not the contract, but a model that wrapped the right
    // object in one still communicated the answer — the balanced scanner digs
    // it out rather than burning a paid call over punctuation.
    expect(parseSummaryResponse('[{"description":"d","summary":"s"}]')).toEqual({
      description: 'd',
      summary: 's',
    });
  });

  it('rejects an array whose contents do not match the contract', () => {
    expect(parseSummaryResponse('[{"nope":1}]')).toBeNull();
  });

  it('collapses a multi-line description to one line and truncates to 80 chars', () => {
    const long = 'x'.repeat(200);
    const out = parseSummaryResponse(
      JSON.stringify({ description: `line one\nline two ${long}`, summary: 's' }),
    );
    expect(out!.description.length).toBeLessThanOrEqual(80);
    expect(out!.description).not.toContain('\n');
  });

  it('keeps at most four sentences of summary', () => {
    const out = parseSummaryResponse(
      JSON.stringify({ description: 'd', summary: 'One. Two. Three. Four. Five. Six.' }),
    );
    expect(out!.summary).toContain('Four.');
    expect(out!.summary).not.toContain('Five.');
  });

  it('salvages a reply with a literal newline inside a string value (real Sonnet failure mode)', () => {
    // JSON.parse rejects raw control chars in strings; the lenient fallback
    // pulls the fields out and whitespace-collapse handles the newline.
    const out = parseSummaryResponse('{"description":"line one\nstill one","summary":"a\nb summary."}');
    expect(out).not.toBeNull();
    expect(out!.description).not.toContain('\n');
    expect(out!.summary).not.toContain('\n');
    expect(out!.description).toContain('line one');
  });

  it('unescapes standard JSON escapes in the lenient fallback path', () => {
    const out = parseSummaryResponse('{"description":"a \\"quoted\\" word\nx","summary":"tab\\tsep\ndone."}');
    expect(out).not.toBeNull();
    expect(out!.description).toContain('"quoted"');
  });

  it('hard-caps an oversized single-sentence summary', () => {
    const out = parseSummaryResponse(
      JSON.stringify({ description: 'd', summary: 'y'.repeat(5000) }),
    );
    expect(out!.summary.length).toBeLessThanOrEqual(600);
  });
});

describe('summarizeSession', () => {
  it('writes description and summary for a fresh session', async () => {
    await seed('s1');
    const res = await summarizeSession('s1', { backend: fakeBackend(goodReply) });

    expect(res).toMatchObject({ sessionId: 's1', kind: 'ok', descriptionUpdated: true });
    const session = getSessionById('s1')!;
    expect(session.description).toBe('Fixed the login bug');
    expect(session.summary).toBe('Traced and fixed it.');
    expect(session.descriptionSource).toBe('auto');
    expect(session.summarizedAt).toBeTruthy();
  });

  it('never overwrites a human description, but still writes the summary', async () => {
    await seed('s2', { description: 'MY OWN LABEL' });
    const res = await summarizeSession('s2', { backend: fakeBackend(goodReply) });

    expect(res).toMatchObject({ kind: 'ok', descriptionUpdated: false });
    const session = getSessionById('s2')!;
    expect(session.description).toBe('MY OWN LABEL');
    expect(session.descriptionSource).toBe('human');
    // The summary is independent of description provenance.
    expect(session.summary).toBe('Traced and fixed it.');
  });

  it('refreshes a description it wrote itself', async () => {
    await seed('s3');
    await summarizeSession('s3', { backend: fakeBackend(goodReply) });
    const second = JSON.stringify({ description: 'Second pass', summary: 'Redone.' });
    const res = await summarizeSession('s3', { backend: fakeBackend(second), force: true });

    expect(res).toMatchObject({ kind: 'ok', descriptionUpdated: true });
    expect(getSessionById('s3')!.description).toBe('Second pass');
  });

  it('skips a session that already has a summary unless forced', async () => {
    await seed('s4');
    await summarizeSession('s4', { backend: fakeBackend(goodReply) });

    const skipped = await summarizeSession('s4', { backend: fakeBackend(goodReply) });
    expect(skipped.kind).toBe('skipped-exists');

    const forced = await summarizeSession('s4', { backend: fakeBackend(goodReply), force: true });
    expect(forced.kind).toBe('ok');
  });

  it('reports a missing session', async () => {
    const res = await summarizeSession('nope', { backend: fakeBackend(goodReply) });
    expect(res).toEqual({ sessionId: 'nope', kind: 'skipped-not-found' });
  });

  it('reports a session with no transcript', async () => {
    await seed('s5', {}, false);
    const res = await summarizeSession('s5', { backend: fakeBackend(goodReply) });
    expect(res.kind).toBe('skipped-no-transcript');
  });

  it('reports an empty excerpt', async () => {
    const transcriptPath = resolve(testDir, 'empty.jsonl');
    await writeFile(transcriptPath, '');
    await seed('s6', { transcriptPath }, false);
    const res = await summarizeSession('s6', { backend: fakeBackend(goodReply) });
    expect(res.kind).toBe('empty-excerpt');
  });

  it('records a backend error and releases the lease', async () => {
    await seed('s7');
    const backend: SummarizeBackend = async () => ({ ok: false, error: 'binary not found' });
    const res = await summarizeSession('s7', { backend });

    expect(res).toMatchObject({ kind: 'backend-error', error: 'binary not found' });
    const state = getSessionDb()
      .prepare('SELECT claim_token, attempts, last_error, next_attempt_at FROM summarize_state WHERE session_id = ?')
      .get('s7') as { claim_token: string | null; attempts: number; last_error: string; next_attempt_at: string };
    // Lease released so a later run can retry...
    expect(state.claim_token).toBeNull();
    // ...but not immediately: backoff is persisted.
    expect(state.attempts).toBe(1);
    expect(state.last_error).toBe('binary not found');
    expect(new Date(state.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('records a parse error when the backend reply is unusable', async () => {
    await seed('s8');
    const res = await summarizeSession('s8', { backend: fakeBackend('I refuse to answer') });
    expect(res.kind).toBe('parse-error');
    expect(getSessionById('s8')!.summary).toBeNull();
  });

  it('returns skipped-claimed when another worker holds the lease', async () => {
    await seed('s9');
    expect(claimSummarize('s9', 'other-worker')).toBe(true);

    const res = await summarizeSession('s9', { backend: fakeBackend(goodReply) });
    expect(res.kind).toBe('skipped-claimed');
    expect(getSessionById('s9')!.summary).toBeNull();
  });

  it('re-checks under the lease and skips (without paying) if a summary landed during excerpt-building', async () => {
    await seed('s-toctou');
    // Two workers can both pass the up-front summary==NULL check, both build
    // excerpts, then one finalizes+releases before the other claims. The second
    // then legitimately owns the lease, so the token match cannot stop it — only
    // a re-read under the lease can. Model that by returning NULL on the first
    // read (up-front check) and a written summary on the second (post-claim).
    const spy = vi.spyOn(agentSessions, 'getSessionById');
    const real = agentSessions.getSessionById('s-toctou')!;
    spy.mockReturnValueOnce({ ...real, summary: null }); // up-front check: looks unsummarized
    spy.mockReturnValueOnce({ ...real, summary: 'written by the other worker' }); // post-claim re-read

    let backendCalled = false;
    const backend: SummarizeBackend = async () => {
      backendCalled = true;
      return { ok: true, text: goodReply };
    };
    const res = await summarizeSession('s-toctou', { backend });

    expect(res.kind).toBe('skipped-exists');
    // The whole point: no redundant paid call.
    expect(backendCalled).toBe(false);
    spy.mockRestore();
  });

  it('re-check is bypassed by force (explicit re-summarize)', async () => {
    await seed('s-force-toctou');
    getSessionDb().prepare("UPDATE sessions SET summary='old', description_source='auto' WHERE session_id='s-force-toctou'").run();
    const res = await summarizeSession('s-force-toctou', { backend: fakeBackend(goodReply), force: true });
    expect(res.kind).toBe('ok');
    expect(getSessionById('s-force-toctou')!.summary).toBe('Traced and fixed it.');
  });

  it('does not record retry state for an explicit-id skip', async () => {
    await seed('s10', {}, false);
    await summarizeSession('s10', { backend: fakeBackend(goodReply) }); // sweep defaults false

    const state = getSessionDb()
      .prepare('SELECT * FROM summarize_state WHERE session_id = ?')
      .get('s10');
    expect(state).toBeUndefined();
  });

  it('records a long backoff for a sweep-path skip', async () => {
    await seed('s11', {}, false);
    await summarizeSession('s11', { backend: fakeBackend(goodReply), sweep: true });

    const state = getSessionDb()
      .prepare('SELECT claim_token, next_attempt_at FROM summarize_state WHERE session_id = ?')
      .get('s11') as { claim_token: string | null; next_attempt_at: string };
    expect(state.claim_token).toBeNull();
    // ~24h out, so a capped newest-first sweep stops re-selecting it.
    const hoursOut = (new Date(state.next_attempt_at).getTime() - Date.now()) / 3_600_000;
    expect(hoursOut).toBeGreaterThan(20);
  });
});

describe('claim / lease ownership', () => {
  it('lets exactly one of two concurrent claimants win', async () => {
    await seed('c1');
    expect(claimSummarize('c1', 'worker-a')).toBe(true);
    expect(claimSummarize('c1', 'worker-b')).toBe(false);
  });

  it('allows re-claiming after release', async () => {
    await seed('c2');
    claimSummarize('c2', 'worker-a');
    releaseSummarize('c2', 'worker-a');
    expect(claimSummarize('c2', 'worker-b')).toBe(true);
  });

  it('ignores a release from a worker that no longer owns the lease', async () => {
    await seed('c3');
    claimSummarize('c3', 'worker-a');
    releaseSummarize('c3', 'stale-worker');

    // worker-a still holds it, so a new claimant is still refused.
    expect(claimSummarize('c3', 'worker-b')).toBe(false);
  });

  it('reclaims a stale lease after the timeout', async () => {
    await seed('c4');
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    claimSummarize('c4', 'crashed-worker', longAgo);
    // A crashed worker must not block the session forever.
    expect(claimSummarize('c4', 'fresh-worker')).toBe(true);
  });

  it('ignores a failure record from a stale worker', async () => {
    await seed('c5');
    claimSummarize('c5', 'worker-a');
    recordSummarizeFailure('c5', 'stale-worker', 'bogus', 60_000);

    const state = getSessionDb()
      .prepare('SELECT claim_token, attempts FROM summarize_state WHERE session_id = ?')
      .get('c5') as { claim_token: string | null; attempts: number };
    expect(state.claim_token).toBe('worker-a');
    expect(state.attempts).toBe(0);
  });

  it('refuses to finalize under an expired lease and writes nothing', async () => {
    await seed('c6');
    claimSummarize('c6', 'worker-a');
    // worker-b never owned the lease.
    const outcome = finalizeSummarize('c6', 'worker-b', { description: 'd', summary: 's' });

    expect(outcome).toBe('lost-lease');
    const session = getSessionById('c6')!;
    expect(session.summary).toBeNull();
    expect(session.description).toBeNull();
  });

  it('clears retry state on a successful finalize', async () => {
    await seed('c7');
    claimSummarize('c7', 'w1');
    recordSummarizeFailure('c7', 'w1', 'transient', 60_000);
    claimSummarize('c7', 'w2');
    expect(finalizeSummarize('c7', 'w2', { description: 'd', summary: 's' })).toBe('ok-desc-updated');

    const state = getSessionDb()
      .prepare('SELECT claim_token, attempts, next_attempt_at, last_error FROM summarize_state WHERE session_id = ?')
      .get('c7') as { claim_token: string | null; attempts: number; next_attempt_at: string | null; last_error: string | null };
    expect(state.claim_token).toBeNull();
    expect(state.attempts).toBe(0);
    expect(state.next_attempt_at).toBeNull();
    expect(state.last_error).toBeNull();
  });
});

describe('listSessionsNeedingSummary / summarizeMissing', () => {
  it('selects only ended sessions with a transcript and no summary, newest first', async () => {
    await seed('e-new', { started: '2026-07-03T10:00:00.000Z' });
    await seed('e-old', { started: '2026-07-01T10:00:00.000Z' });
    await seed('e-live', { started: '2026-07-04T10:00:00.000Z', status: 'active' });
    await seed('e-no-transcript', { started: '2026-07-05T10:00:00.000Z' }, false);

    const ids = listSessionsNeedingSummary(10).map((s) => s.sessionId);
    expect(ids).toEqual(['e-new', 'e-old']);
  });

  it('honours the limit', async () => {
    await seed('l1', { started: '2026-07-03T10:00:00.000Z' });
    await seed('l2', { started: '2026-07-02T10:00:00.000Z' });
    await seed('l3', { started: '2026-07-01T10:00:00.000Z' });
    expect(listSessionsNeedingSummary(2)).toHaveLength(2);
  });

  it('excludes sessions whose backoff has not elapsed, and re-includes them after it has', async () => {
    await seed('b1');
    claimSummarize('b1', 'w');
    recordSummarizeFailure('b1', 'w', 'boom', 60 * 60 * 1000);

    expect(listSessionsNeedingSummary(10).map((s) => s.sessionId)).not.toContain('b1');

    // Same DB file, later clock — i.e. what a fresh LaunchAgent process sees.
    const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
    expect(listSessionsNeedingSummary(10, later).map((s) => s.sessionId)).toContain('b1');
  });

  it('excludes sessions that already have a summary', async () => {
    await seed('d1');
    await summarizeSession('d1', { backend: fakeBackend(goodReply) });
    expect(listSessionsNeedingSummary(10).map((s) => s.sessionId)).not.toContain('d1');
  });

  it('summarizes a batch and returns one result per session, each carrying its id', async () => {
    await seed('m1', { started: '2026-07-02T10:00:00.000Z' });
    await seed('m2', { started: '2026-07-01T10:00:00.000Z' });

    const results = await summarizeMissing({ backend: fakeBackend(goodReply), limit: 10 });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.sessionId).sort()).toEqual(['m1', 'm2']);
    expect(results.every((r) => r.kind === 'ok')).toBe(true);
    expect(getSessionById('m1')!.summary).toBe('Traced and fixed it.');
  });

  it('keeps going when one session throws', async () => {
    await seed('t1', { started: '2026-07-02T10:00:00.000Z' });
    await seed('t2', { started: '2026-07-01T10:00:00.000Z' });

    let calls = 0;
    const flaky: SummarizeBackend = async () => {
      calls++;
      if (calls === 1) throw new Error('exploded');
      return { ok: true, text: goodReply };
    };

    const results = await summarizeMissing({ backend: flaky, limit: 10 });
    expect(results).toHaveLength(2);
    // One failed, one succeeded — the batch was never aborted.
    expect(results.filter((r) => r.kind === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'persist-error')).toHaveLength(1);
  });

  it('rejects a non-positive or non-integer limit', async () => {
    const backend = fakeBackend(goodReply);
    await expect(summarizeMissing({ backend, limit: 0 })).rejects.toThrow(/positive integer/);
    await expect(summarizeMissing({ backend, limit: -1 })).rejects.toThrow(/positive integer/);
    await expect(summarizeMissing({ backend, limit: 1.5 })).rejects.toThrow(/positive integer/);
  });
});

describe('countByKind', () => {
  it('tallies results by kind', () => {
    expect(
      countByKind([
        { sessionId: 'a', kind: 'ok' },
        { sessionId: 'b', kind: 'ok' },
        { sessionId: 'c', kind: 'skipped-exists' },
      ]),
    ).toEqual({ ok: 2, 'skipped-exists': 1 });
  });
});
