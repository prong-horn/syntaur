import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initSessionDb, closeSessionDb, resetSessionDb } from '../dashboard/session-db.js';
import { appendSession } from '../dashboard/agent-sessions.js';
import { summarizeAllWithTranscripts } from '../commands/session.js';
import type { SummarizeBackend } from '../sessions/summarizer.js';
import type { AgentSession } from '../dashboard/types.js';

let testDir: string;
let prevHome: string | undefined;

const goodReply = JSON.stringify({ description: 'd', summary: 's' });
const backend: SummarizeBackend = async () => ({ ok: true, text: goodReply });

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-all-'));
  prevHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = resolve(testDir, 'home');
  resetSessionDb();
  initSessionDb(resolve(testDir, 'syntaur.db'));
});

afterEach(async () => {
  closeSessionDb();
  if (prevHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = prevHome;
  await rm(testDir, { recursive: true, force: true });
});

async function seedN(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const tp = resolve(testDir, `s${i}.jsonl`);
    await writeFile(tp, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n');
    await appendSession('', {
      projectSlug: null,
      assignmentSlug: null,
      agent: 'claude',
      sessionId: `s${String(i).padStart(3, '0')}`,
      started: `2026-07-${String((i % 27) + 1).padStart(2, '0')}T10:00:00.000Z`,
      status: 'stopped',
      path: '/w',
      transcriptPath: tp,
    } as AgentSession);
  }
}

describe('summarizeAllWithTranscripts (--all)', () => {
  it('processes EVERY session with a transcript when unlimited (regression: was capped at 20)', async () => {
    await seedN(25);
    const results = await summarizeAllWithTranscripts({ backend, limit: Infinity });
    // All 25, not the newest 20.
    expect(results).toHaveLength(25);
    expect(results.every((r) => r.kind === 'ok')).toBe(true);
  });

  it('respects an explicit numeric cap', async () => {
    await seedN(25);
    const results = await summarizeAllWithTranscripts({ backend, limit: 5 });
    expect(results).toHaveLength(5);
  });

  it('help text reflects the unlimited --all / 20-default --missing behavior', async () => {
    const { sessionCommand } = await import('../commands/session.js');
    const summarize = sessionCommand.commands.find((c) => c.name() === 'summarize');
    expect(summarize).toBeDefined();
    const help = summarize!.helpInformation();
    // Regression: help must not promise a 20-cap for --all.
    expect(help).toMatch(/--all[^\n]*unlimited/i);
    expect(help).toMatch(/--missing[^\n]*20/i);
  });

  it('skips sessions with no transcript', async () => {
    await appendSession('', {
      projectSlug: null,
      assignmentSlug: null,
      agent: 'claude',
      sessionId: 'no-transcript',
      started: '2026-07-01T10:00:00.000Z',
      status: 'stopped',
      path: '/w',
      transcriptPath: null,
    } as AgentSession);
    const results = await summarizeAllWithTranscripts({ backend, limit: Infinity });
    expect(results).toHaveLength(0);
  });
});
