import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
  getSessionDb,
} from '../dashboard/session-db.js';
import {
  initUsageDb,
  closeUsageDb,
  resetUsageDb,
  getUsageDb,
  upsertEvent,
  TICKET_ID_CHUNK_SIZE,
} from '../db/usage-db.js';
import type { ModelTokens, TokenSnapshot } from '../db/engagement-tokens.js';
import { ticketTotals, resolveTicketCost } from '../usage/ticket-totals.js';

let testDir: string;
let dbPath: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-ticket-totals-'));
  dbPath = resolve(testDir, 'syntaur.db');
  resetSessionDb();
  resetUsageDb();
  initSessionDb(dbPath);
  initUsageDb(dbPath);
});

afterEach(async () => {
  vi.restoreAllMocks();
  closeSessionDb();
  closeUsageDb();
  await rm(testDir, { recursive: true, force: true });
});

function model(partial: Partial<ModelTokens>): ModelTokens {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0, cost: 0, ...partial };
}

function snap(models: Record<string, ModelTokens>): TokenSnapshot {
  return { models, collectorRunAt: null, capturedAt: '2026-06-01T00:00:00.000Z' };
}

let windowSeq = 0;
/**
 * Insert one engagement row directly (closed when `endedAt` is set, else open).
 * Direct SQL so a test can create duplicate/overlapping windows freely; the
 * open-per-session unique index still applies.
 */
function engagement(opts: {
  sessionId: string;
  ticketId: string | null;
  open?: TokenSnapshot | null;
  close?: TokenSnapshot | null;
  endedAt?: string | null;
  stage?: string;
}): void {
  windowSeq += 1;
  const startedAt = `2026-06-01T${String(windowSeq % 24).padStart(2, '0')}:00:00.000Z`;
  getSessionDb()
    .prepare(
      `INSERT INTO engagement
         (session_id, ticket_id, stage, started_at, ended_at, tokens_at_open, tokens_at_close, close_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.sessionId,
      opts.ticketId,
      opts.stage ?? 'implement',
      startedAt,
      opts.endedAt === undefined ? '2026-06-01T23:00:00.000Z' : opts.endedAt,
      opts.open ? JSON.stringify(opts.open) : null,
      opts.close ? JSON.stringify(opts.close) : null,
      opts.endedAt === null ? null : 'switch',
    );
}

/** A closed, priced window costing `cost` on `m`. */
function pricedWindow(sessionId: string, ticketId: string, cost: number, m = 'claude-opus-4-7'): void {
  engagement({
    sessionId,
    ticketId,
    open: snap({ [m]: model({ total: 10, cost: 0 }) }),
    close: snap({ [m]: model({ total: 20, cost }) }),
  });
}

function usage(opts: {
  sessionId: string;
  ticketId: string;
  cost: number;
  projectSlug?: string;
  model?: string;
}): void {
  upsertEvent({
    sessionId: opts.sessionId,
    model: opts.model ?? 'claude-opus-4-7',
    tool: 'claude',
    eventTs: '2026-06-01T12:00:00.000Z',
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 100,
    totalCost: opts.cost,
    cwd: null,
    projectSlug: opts.projectSlug ?? '',
    ticketSlug: opts.ticketId,
    rawJson: null,
  });
}

describe('ticketTotals — cost source precedence', () => {
  it('no usage and no engagement → unknown cost (null/none), known-zero sessions', () => {
    const m = ticketTotals(['NONE-1']).get('NONE-1');
    expect(m).toEqual({ costUsd: null, sessionCount: 0, costSource: 'none', partial: false });
  });

  it('a recorded $0 usage row is a KNOWN zero (usage source, not none)', () => {
    usage({ sessionId: 's-zero', ticketId: 'ZERO-1', cost: 0 });
    expect(ticketTotals(['ZERO-1']).get('ZERO-1')).toEqual({
      costUsd: 0,
      sessionCount: 0,
      costSource: 'usage',
      partial: false,
    });
  });

  it('sums attributed rows regardless of project_slug (empty slug is not excluded)', () => {
    usage({ sessionId: 's1', ticketId: 'SLG-1', cost: 1.25, projectSlug: '' });
    usage({ sessionId: 's2', ticketId: 'SLG-1', cost: 0.75, projectSlug: 'proj' });
    const m = ticketTotals(['SLG-1']).get('SLG-1')!;
    expect(m.costSource).toBe('usage');
    expect(m.costUsd).toBeCloseTo(2.0, 9);
  });

  it('repeated models: one row per (session, model); an upsert of the same pair is not double counted', () => {
    usage({ sessionId: 's1', ticketId: 'MOD-1', cost: 1.0, model: 'claude-opus-4-7' });
    usage({ sessionId: 's1', ticketId: 'MOD-1', cost: 0.5, model: 'claude-sonnet-4-6' });
    // Same (session, model) re-collected with a larger cumulative → replaces, not adds.
    usage({ sessionId: 's1', ticketId: 'MOD-1', cost: 1.5, model: 'claude-opus-4-7' });
    const m = ticketTotals(['MOD-1']).get('MOD-1')!;
    expect(m.costUsd).toBeCloseTo(2.0, 9);
    expect(getUsageDb().prepare("SELECT COUNT(*) AS n FROM usage_events WHERE ticket_id = 'MOD-1'").get()).toEqual({ n: 2 });
  });

  it('excludes unattributed rows and other tickets\' rows', () => {
    usage({ sessionId: 's-un', ticketId: '', cost: 9, projectSlug: 'proj' });
    usage({ sessionId: 's-other', ticketId: 'OTH-1', cost: 5 });
    usage({ sessionId: 's-mine', ticketId: 'MINE-1', cost: 1 });
    const totals = ticketTotals(['MINE-1', 'NOPE-1']);
    expect(totals.get('MINE-1')!.costUsd).toBe(1);
    expect(totals.get('NOPE-1')!.costSource).toBe('none');
  });

  it('priced closed window wins and is NEVER added to usage_events cost', () => {
    usage({ sessionId: 's1', ticketId: 'ENG-1', cost: 10 });
    pricedWindow('s1', 'ENG-1', 1.5);
    pricedWindow('s2', 'ENG-1', 0.5);
    expect(ticketTotals(['ENG-1']).get('ENG-1')).toEqual({
      costUsd: 2.0,
      sessionCount: 2,
      costSource: 'engagement',
      partial: false,
    });
  });

  it('priced closed window + an OPEN window → engagement cost, partial', () => {
    pricedWindow('s1', 'OPN-1', 1.0);
    engagement({ sessionId: 's2', ticketId: 'OPN-1', open: snap({}), endedAt: null });
    const m = ticketTotals(['OPN-1']).get('OPN-1')!;
    expect(m.costSource).toBe('engagement');
    expect(m.costUsd).toBeCloseTo(1.0, 9);
    expect(m.partial).toBe(true);
    expect(m.sessionCount).toBe(2);
  });

  it('priced + uncomputable window → partial; uncomputable-only falls back to usage', () => {
    pricedWindow('s1', 'UNC-1', 0.25);
    engagement({ sessionId: 's2', ticketId: 'UNC-1', open: null, close: null });
    const mixed = ticketTotals(['UNC-1']).get('UNC-1')!;
    expect(mixed).toMatchObject({ costSource: 'engagement', costUsd: 0.25, partial: true });

    engagement({ sessionId: 's3', ticketId: 'UNC-2', open: null, close: null });
    usage({ sessionId: 's3', ticketId: 'UNC-2', cost: 3 });
    expect(ticketTotals(['UNC-2']).get('UNC-2')).toEqual({
      costUsd: 3,
      sessionCount: 1,
      costSource: 'usage',
      partial: false,
    });

    // Uncomputable-only with no usage rows: unknown, not $0.
    engagement({ sessionId: 's4', ticketId: 'UNC-3', open: null, close: null });
    expect(ticketTotals(['UNC-3']).get('UNC-3')).toMatchObject({ costUsd: null, costSource: 'none', sessionCount: 1 });
  });

  it('negative per-model delta uses the existing clamp policy and marks partial', () => {
    const m = 'claude-opus-4-7';
    engagement({
      sessionId: 's1',
      ticketId: 'NEG-1',
      open: snap({ [m]: model({ total: 10, cost: 2 }), other: model({ total: 1, cost: 0 }) }),
      close: snap({ [m]: model({ total: 20, cost: 1 }), other: model({ total: 2, cost: 0.4 }) }),
    });
    const t = ticketTotals(['NEG-1']).get('NEG-1')!;
    expect(t.costSource).toBe('engagement');
    expect(t.costUsd).toBeCloseTo(0.4, 9); // negative model clamped to 0, other +0.4
    expect(t.partial).toBe(true);
  });

  it('partial pricing: a $0 cost delta with token growth is list-priced; an unknown model stays $0', () => {
    engagement({
      sessionId: 's1',
      ticketId: 'PRC-1',
      open: snap({ 'gpt-5': model({ input: 0, cost: 0 }), 'mystery-model': model({ input: 0 }) }),
      close: snap({
        'gpt-5': model({ input: 1_000_000, total: 1_000_000, cost: 0 }),
        'mystery-model': model({ input: 1_000_000, total: 1_000_000, cost: 0 }),
      }),
    });
    const t = ticketTotals(['PRC-1']).get('PRC-1')!;
    expect(t.costSource).toBe('engagement');
    expect(t.costUsd).toBeCloseTo(1.25, 9);
    expect(t.partial).toBe(false);
  });
});

describe('ticketTotals — distinct session count', () => {
  it('repeat windows/stage transitions for one session count once', () => {
    pricedWindow('s1', 'DUP-1', 0.1);
    engagement({ sessionId: 's1', ticketId: 'DUP-1', stage: 'review', open: null, close: null });
    engagement({ sessionId: 's1', ticketId: 'DUP-1', stage: 'implement', open: snap({}), endedAt: null });
    expect(ticketTotals(['DUP-1']).get('DUP-1')!.sessionCount).toBe(1);
  });

  it('a session engaged with two tickets counts once on EACH', () => {
    engagement({ sessionId: 'shared', ticketId: 'TWO-A', open: null, close: null });
    engagement({ sessionId: 'shared', ticketId: 'TWO-B', open: null, close: null });
    engagement({ sessionId: 'solo', ticketId: 'TWO-B', open: null, close: null });
    const t = ticketTotals(['TWO-A', 'TWO-B']);
    expect(t.get('TWO-A')!.sessionCount).toBe(1);
    expect(t.get('TWO-B')!.sessionCount).toBe(2);
  });

  it('null / empty ticket bindings never count', () => {
    engagement({ sessionId: 'unbound', ticketId: null, open: null, close: null });
    engagement({ sessionId: 'blank', ticketId: '', open: null, close: null });
    const t = ticketTotals(['', 'REAL-1']);
    expect(t.get('')).toEqual({ costUsd: null, sessionCount: 0, costSource: 'none', partial: false });
    expect(t.get('REAL-1')!.sessionCount).toBe(0);
  });

  it('sessionCount is null (unknown) when the session db is not initialized; usage still resolves', () => {
    usage({ sessionId: 's1', ticketId: 'NODB-1', cost: 0.5 });
    closeSessionDb();
    resetSessionDb();
    expect(ticketTotals(['NODB-1']).get('NODB-1')).toEqual({
      costUsd: 0.5,
      sessionCount: null,
      costSource: 'usage',
      partial: false,
    });
  });

  it('an uninitialized usage db is treated as no usage rows (no throw)', () => {
    usage({ sessionId: 's1', ticketId: 'NOU-1', cost: 0.5 });
    engagement({ sessionId: 's1', ticketId: 'NOU-1', open: null, close: null });
    closeUsageDb();
    resetUsageDb();
    expect(ticketTotals(['NOU-1']).get('NOU-1')).toEqual({
      costUsd: null,
      sessionCount: 1,
      costSource: 'none',
      partial: false,
    });
  });
});

describe('ticketTotals — batching', () => {
  it('duplicate ids collapse and every id gets an entry', () => {
    usage({ sessionId: 's1', ticketId: 'B-1', cost: 1 });
    const t = ticketTotals(['B-1', 'B-1', 'B-2']);
    expect([...t.keys()].sort()).toEqual(['B-1', 'B-2']);
    expect(t.get('B-1')!.costUsd).toBe(1);
  });

  it('issues a bounded number of statements for 1500 ids (no N+1), with correct per-id values', () => {
    const ids = Array.from({ length: 1500 }, (_, i) => `BIG-${i}`);
    // Seed a handful spread across both chunks.
    pricedWindow('w0', 'BIG-0', 0.5);
    engagement({ sessionId: 'w0-open', ticketId: 'BIG-0', open: snap({}), endedAt: null });
    usage({ sessionId: 'u950', ticketId: 'BIG-950', cost: 0 });
    usage({ sessionId: 'u1499', ticketId: 'BIG-1499', cost: 2, projectSlug: '' });
    engagement({ sessionId: 'e1499', ticketId: 'BIG-1499', open: null, close: null });

    const sessionPrepare = vi.spyOn(getSessionDb(), 'prepare');
    const usagePrepare = vi.spyOn(getUsageDb(), 'prepare');

    const t = ticketTotals(ids);

    const chunks = Math.ceil(ids.length / TICKET_ID_CHUNK_SIZE);
    expect(chunks).toBe(2);
    // usage: one GROUP BY per chunk.
    expect(usagePrepare).toHaveBeenCalledTimes(chunks);
    // session db: (table probe + window SELECT per chunk) + (table probe + GROUP BY per chunk).
    expect(sessionPrepare).toHaveBeenCalledTimes(2 + 2 * chunks);
    expect(sessionPrepare.mock.calls.length + usagePrepare.mock.calls.length).toBeLessThan(10);

    expect(t.size).toBe(1500);
    expect(t.get('BIG-0')).toEqual({ costUsd: 0.5, sessionCount: 2, costSource: 'engagement', partial: true });
    expect(t.get('BIG-950')).toEqual({ costUsd: 0, sessionCount: 0, costSource: 'usage', partial: false });
    expect(t.get('BIG-1499')).toEqual({ costUsd: 2, sessionCount: 1, costSource: 'usage', partial: false });
    expect(t.get('BIG-7')).toEqual({ costUsd: null, sessionCount: 0, costSource: 'none', partial: false });
  });
});

describe('resolveTicketCost', () => {
  const W = { cost: 1, pricedWindowCount: 1, uncomputableWindowCount: 0, negativeDeltaCount: 0 };
  it('flags partial only for engagement-sourced cost', () => {
    expect(resolveTicketCost(W, undefined, 1).partial).toBe(true);
    expect(resolveTicketCost(W, undefined, 0).partial).toBe(false);
    expect(resolveTicketCost({ ...W, pricedWindowCount: 0, uncomputableWindowCount: 2 }, { cost: 1, rowCount: 1 }, 3)).toEqual({
      costUsd: 1,
      costSource: 'usage',
      partial: false,
    });
  });
});
