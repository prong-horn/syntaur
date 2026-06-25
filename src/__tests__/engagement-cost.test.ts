import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
} from '../dashboard/session-db.js';
import { openEngagement, closeEngagementById } from '../db/engagement-db.js';
import type { ModelTokens, TokenSnapshot } from '../db/engagement-tokens.js';
import {
  assignmentWindowCost,
  projectWindowCosts,
} from '../usage/engagement-cost.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-engcost-'));
  resetSessionDb();
  initSessionDb(resolve(testDir, 'test.db'));
});

afterEach(async () => {
  closeSessionDb();
  await rm(testDir, { recursive: true, force: true });
});

function model(partial: Partial<ModelTokens>): ModelTokens {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0, cost: 0, ...partial };
}

function snap(models: Record<string, ModelTokens>): TokenSnapshot {
  return { models, collectorRunAt: '2026-06-01T00:00:00.000Z', capturedAt: '2026-06-01T00:00:00.000Z' };
}

/** Insert one CLOSED engagement window. Sequential per session (open A, close A, open B...). */
function window(opts: {
  sessionId: string;
  projectSlug: string | null;
  assignmentSlug: string;
  assignmentId?: string | null;
  startedAt: string;
  endedAt: string;
  open: TokenSnapshot | null;
  close: TokenSnapshot | null;
}): void {
  const row = openEngagement({
    sessionId: opts.sessionId,
    assignmentId: opts.assignmentId ?? null,
    projectSlug: opts.projectSlug,
    assignmentSlug: opts.assignmentSlug,
    stage: 'implement',
    startedAt: opts.startedAt,
    tokensAtOpen: opts.open,
  });
  closeEngagementById({
    id: row.id,
    startedAt: opts.startedAt,
    closeReason: 'switch',
    tokensAtClose: opts.close,
    endedAt: opts.endedAt,
  });
}

describe('assignmentWindowCost', () => {
  it('(a) attributes each window to the right assignment for A-then-B on the same model', () => {
    const m = 'claude-opus-4-7';
    // One session, same model, cumulative cost grows across both windows:
    //   A: 0.00 -> 1.50  (delta 1.50)
    //   B: 1.50 -> 4.00  (delta 2.50)
    window({
      sessionId: 's1', projectSlug: 'proj', assignmentSlug: 'A',
      startedAt: '2026-06-01T01:00:00.000Z', endedAt: '2026-06-01T02:00:00.000Z',
      open: snap({ [m]: model({ total: 100, cost: 0 }) }),
      close: snap({ [m]: model({ total: 200, cost: 1.5 }) }),
    });
    window({
      sessionId: 's1', projectSlug: 'proj', assignmentSlug: 'B',
      startedAt: '2026-06-01T02:00:00.000Z', endedAt: '2026-06-01T03:00:00.000Z',
      open: snap({ [m]: model({ total: 200, cost: 1.5 }) }),
      close: snap({ [m]: model({ total: 400, cost: 4.0 }) }),
    });

    const a = assignmentWindowCost({ projectSlug: 'proj', assignmentSlug: 'A' });
    const b = assignmentWindowCost({ projectSlug: 'proj', assignmentSlug: 'B' });
    expect(a.cost).toBeCloseTo(1.5, 6);
    expect(a.pricedWindowCount).toBe(1);
    expect(b.cost).toBeCloseTo(2.5, 6);
    expect(b.pricedWindowCount).toBe(1);
    // NOT the whole cumulative (4.0) attributed to one assignment.
    expect(a.cost + b.cost).toBeCloseTo(4.0, 6);
  });

  it('(b) flags a null-open window as uncomputable, not silently zeroed', () => {
    window({
      sessionId: 's2', projectSlug: 'proj', assignmentSlug: 'A',
      startedAt: '2026-06-01T01:00:00.000Z', endedAt: '2026-06-01T02:00:00.000Z',
      open: null,
      close: snap({ 'claude-opus-4-7': model({ total: 200, cost: 3.0 }) }),
    });
    const a = assignmentWindowCost({ projectSlug: 'proj', assignmentSlug: 'A' });
    expect(a.cost).toBe(0);
    expect(a.uncomputableWindowCount).toBe(1);
    expect(a.pricedWindowCount).toBe(0);
  });

  it('(c) falls back to priceForModel when cost delta is 0 but tokens grew; unknown model stays computable at 0', () => {
    const known = 'moonshotai/kimi-k2.6'; // in MODEL_PRICING (input 0.95 / 1e6)
    const unknown = 'claude-opus-4-7'; // priceForModel returns null
    window({
      sessionId: 's3', projectSlug: 'proj', assignmentSlug: 'A',
      startedAt: '2026-06-01T01:00:00.000Z', endedAt: '2026-06-01T02:00:00.000Z',
      // cost delta 0 for both, but input tokens grew by 1,000,000 each.
      open: snap({
        [known]: model({ input: 0, total: 0, cost: 0 }),
        [unknown]: model({ input: 0, total: 0, cost: 0 }),
      }),
      close: snap({
        [known]: model({ input: 1_000_000, total: 1_000_000, cost: 0 }),
        [unknown]: model({ input: 1_000_000, total: 1_000_000, cost: 0 }),
      }),
    });
    const a = assignmentWindowCost({ projectSlug: 'proj', assignmentSlug: 'A' });
    // known model: 1e6 * 0.95 / 1e6 = 0.95; unknown: 0 (not priced) but window still computable.
    expect(a.cost).toBeCloseTo(0.95, 6);
    expect(a.pricedWindowCount).toBe(1);
    expect(a.uncomputableWindowCount).toBe(0);
  });

  it('(d) clamps a negative cost delta to 0 and counts it as anomalous', () => {
    window({
      sessionId: 's4', projectSlug: 'proj', assignmentSlug: 'A',
      startedAt: '2026-06-01T01:00:00.000Z', endedAt: '2026-06-01T02:00:00.000Z',
      open: snap({ 'claude-opus-4-7': model({ total: 200, cost: 5.0 }) }),
      close: snap({ 'claude-opus-4-7': model({ total: 100, cost: 2.0 }) }), // went DOWN
    });
    const a = assignmentWindowCost({ projectSlug: 'proj', assignmentSlug: 'A' });
    expect(a.cost).toBe(0);
    expect(a.negativeDeltaCount).toBe(1);
    expect(a.pricedWindowCount).toBe(1);
  });

  it('(e) matches a standalone assignment via project_slug IS NULL', () => {
    window({
      sessionId: 's5', projectSlug: null, assignmentSlug: 'solo',
      startedAt: '2026-06-01T01:00:00.000Z', endedAt: '2026-06-01T02:00:00.000Z',
      open: snap({ 'claude-opus-4-7': model({ total: 0, cost: 0 }) }),
      close: snap({ 'claude-opus-4-7': model({ total: 50, cost: 0.7 }) }),
    });
    // Empty-string projectSlug (the standalone endpoint shape) maps to the NULL match.
    const viaEmpty = assignmentWindowCost({ projectSlug: '', assignmentSlug: 'solo' });
    const viaNull = assignmentWindowCost({ projectSlug: null, assignmentSlug: 'solo' });
    expect(viaEmpty.cost).toBeCloseTo(0.7, 6);
    expect(viaNull.cost).toBeCloseTo(0.7, 6);
  });

  it('matches by assignment_id when provided', () => {
    window({
      sessionId: 's6', projectSlug: 'proj', assignmentSlug: 'A', assignmentId: 'id-A',
      startedAt: '2026-06-01T01:00:00.000Z', endedAt: '2026-06-01T02:00:00.000Z',
      open: snap({ 'claude-opus-4-7': model({ cost: 0 }) }),
      close: snap({ 'claude-opus-4-7': model({ cost: 1.25 }) }),
    });
    const a = assignmentWindowCost({ assignmentId: 'id-A' });
    expect(a.cost).toBeCloseTo(1.25, 6);
  });
});

describe('projectWindowCosts', () => {
  it('(f) enumerates every assignment with a closed window in the project', () => {
    const m = 'claude-opus-4-7';
    window({
      sessionId: 's1', projectSlug: 'proj', assignmentSlug: 'A',
      startedAt: '2026-06-01T01:00:00.000Z', endedAt: '2026-06-01T02:00:00.000Z',
      open: snap({ [m]: model({ cost: 0 }) }),
      close: snap({ [m]: model({ cost: 1.5 }) }),
    });
    window({
      sessionId: 's1', projectSlug: 'proj', assignmentSlug: 'B',
      startedAt: '2026-06-01T02:00:00.000Z', endedAt: '2026-06-01T03:00:00.000Z',
      open: snap({ [m]: model({ cost: 1.5 }) }),
      close: snap({ [m]: model({ cost: 4.0 }) }),
    });

    const costs = projectWindowCosts({ projectSlug: 'proj' });
    expect([...costs.keys()].sort()).toEqual(['A', 'B']);
    expect(costs.get('A')!.cost).toBeCloseTo(1.5, 6);
    expect(costs.get('B')!.cost).toBeCloseTo(2.5, 6);
  });
});
