import { describe, expect, it } from 'vitest';
import { runStalenessWatchdogTick, type WatchdogEvent, type StaleCandidate } from '../staleness/watchdog.js';
import type { StaleReason } from '../staleness/classify.js';

const REASON: StaleReason = { kind: 'review_aging', label: 'Awaiting review', severity: 'high' };

function cand(id: string, stale: boolean, project: string | null = 'p1'): StaleCandidate {
  return { assignmentId: id, projectSlug: project, reasons: stale ? [REASON] : [] };
}

describe('runStalenessWatchdogTick', () => {
  it('emits staleness-detected once per newly-stale assignment', () => {
    const seen = new Set<string>();
    const events: WatchdogEvent[] = [];
    const summary = runStalenessWatchdogTick([cand('a', true), cand('b', false)], seen, (e) => events.push(e));
    expect(summary).toEqual({ scanned: 2, stale: 1, newlyStale: 1, cleared: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ assignmentId: 'a', type: 'staleness-detected' });
    expect(seen.has('a')).toBe(true);
  });

  it('is idempotent — re-running with the same inputs emits nothing new', () => {
    const seen = new Set<string>();
    runStalenessWatchdogTick([cand('a', true)], seen, () => {});
    const events: WatchdogEvent[] = [];
    const summary = runStalenessWatchdogTick([cand('a', true)], seen, (e) => events.push(e));
    expect(events).toHaveLength(0);
    expect(summary.newlyStale).toBe(0);
  });

  it('emits staleness-cleared when an assignment recovers, and forgets it', () => {
    const seen = new Set<string>(['a']);
    const events: WatchdogEvent[] = [];
    const summary = runStalenessWatchdogTick([cand('a', false)], seen, (e) => events.push(e));
    expect(summary.cleared).toBe(1);
    expect(events[0]).toMatchObject({ assignmentId: 'a', type: 'staleness-cleared' });
    expect(seen.has('a')).toBe(false);
  });

  it('re-emits detection after a recover→re-stale cycle', () => {
    const seen = new Set<string>();
    const e1: WatchdogEvent[] = [];
    runStalenessWatchdogTick([cand('a', true)], seen, (e) => e1.push(e)); // detect
    runStalenessWatchdogTick([cand('a', false)], seen, () => {}); // clear
    const e2: WatchdogEvent[] = [];
    runStalenessWatchdogTick([cand('a', true)], seen, (e) => e2.push(e)); // detect again
    expect(e1).toHaveLength(1);
    expect(e2).toHaveLength(1);
    expect(e2[0].type).toBe('staleness-detected');
  });

  it('handles a mixed tick: one new, one recovered, one steady', () => {
    const seen = new Set<string>(['steady', 'gone']);
    const events: WatchdogEvent[] = [];
    const summary = runStalenessWatchdogTick(
      [cand('steady', true), cand('gone', false), cand('fresh', true)],
      seen,
      (e) => events.push(e),
    );
    expect(summary).toEqual({ scanned: 3, stale: 2, newlyStale: 1, cleared: 1 });
    expect(events.map((e) => `${e.type}:${e.assignmentId}`).sort()).toEqual([
      'staleness-cleared:gone',
      'staleness-detected:fresh',
    ]);
    expect([...seen].sort()).toEqual(['fresh', 'steady']);
  });
});
