import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isReview,
  isBlocked,
  isUnresolvedQuestion,
  unresolvedQuestions,
  isPlanAwaitingApproval,
  resolveSince,
  computeAgeMs,
  deriveReviewVerbs,
  buildAction,
  orderByUrgency,
  type InboxStatusConfig,
} from '../inbox/index.js';
import type { InboxItem } from '../inbox/types.js';
import { parseAssignmentFull, type ParsedAssignmentFull, type ParsedComment } from '../dashboard/parser.js';
import { buildDefaultStatusConfig } from '../utils/config.js';
import { buildTransitionTable } from '../lifecycle/state-machine.js';
import { planDigest } from '../lifecycle/facts.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function defaultStatusConfig(): InboxStatusConfig {
  const def = buildDefaultStatusConfig();
  return {
    statuses: def.statuses,
    transitions: def.transitions,
    transitionTable: buildTransitionTable(def.transitions),
    terminalStatuses: new Set(def.statuses.filter((s) => s.terminal).map((s) => s.id)),
    // Default headline blocked/parked ids (DEFAULT_DERIVE_CONFIG.headline). These
    // are NOT valid active reopen targets; `in_progress` is absent so default
    // `review:start -> in_progress` stays a valid reopen.
    blockedParkedStatuses: new Set(['blocked', 'parked']),
  };
}

/** Build a ParsedAssignmentFull from frontmatter by round-tripping the real parser. */
function assignment(frontmatter: string): ParsedAssignmentFull {
  return parseAssignmentFull(`---\n${frontmatter}\n---\n# body\n`);
}

function comment(partial: Partial<ParsedComment> & { id: string }): ParsedComment {
  return {
    id: partial.id,
    timestamp: partial.timestamp ?? '2026-06-16T00:00:00Z',
    author: partial.author ?? 'human',
    type: partial.type ?? 'question',
    body: partial.body ?? 'q?',
    ...(partial.replyTo ? { replyTo: partial.replyTo } : {}),
    ...(partial.resolved !== undefined ? { resolved: partial.resolved } : {}),
  };
}

// ── isReview / isBlocked ───────────────────────────────────────────────────────

describe('isReview', () => {
  it('positive: derived status === review', () => {
    expect(isReview(assignment('status: review'))).toBe(true);
  });
  it('negative: any other status', () => {
    for (const s of ['draft', 'ready_to_implement', 'in_progress', 'completed', 'blocked']) {
      expect(isReview(assignment(`status: ${s}`))).toBe(false);
    }
  });
});

describe('isBlocked', () => {
  it('positive: derived status === blocked', () => {
    expect(isBlocked(assignment('status: blocked'))).toBe(true);
  });
  it('negative: blockedReason set but status NOT blocked does not match', () => {
    // Predicate is status-based, NOT blockedReason !== null.
    expect(isBlocked(assignment('status: in_progress\nblockedReason: stuck'))).toBe(false);
  });
  it('negative: other statuses', () => {
    for (const s of ['draft', 'in_progress', 'review', 'completed', 'parked']) {
      expect(isBlocked(assignment(`status: ${s}`))).toBe(false);
    }
  });
});

// ── question predicate ─────────────────────────────────────────────────────────

describe('isUnresolvedQuestion / unresolvedQuestions', () => {
  it('positive: question with resolved !== true', () => {
    expect(isUnresolvedQuestion(comment({ id: 'c1', type: 'question', resolved: false }))).toBe(true);
    // resolved absent → unresolved
    expect(isUnresolvedQuestion(comment({ id: 'c2', type: 'question' }))).toBe(true);
  });
  it('negative: resolved question', () => {
    expect(isUnresolvedQuestion(comment({ id: 'c3', type: 'question', resolved: true }))).toBe(false);
  });
  it('negative: note and feedback types', () => {
    expect(isUnresolvedQuestion(comment({ id: 'c4', type: 'note' }))).toBe(false);
    expect(isUnresolvedQuestion(comment({ id: 'c5', type: 'feedback' }))).toBe(false);
  });
  it('filters a mixed list to only unresolved questions', () => {
    const list = [
      comment({ id: 'q-open', type: 'question', resolved: false }),
      comment({ id: 'q-resolved', type: 'question', resolved: true }),
      comment({ id: 'n', type: 'note' }),
      comment({ id: 'f', type: 'feedback' }),
      comment({ id: 'q-open2', type: 'question' }),
    ];
    expect(unresolvedQuestions(list).map((c) => c.id)).toEqual(['q-open', 'q-open2']);
  });
});

// ── plan-approval predicate (real fs via latestPlanFile/isPlanApproved) ─────────

describe('isPlanAwaitingApproval', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'syntaur-inbox-plan-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('negative: ready_for_planning WITHOUT a plan file', async () => {
    const a = assignment('status: ready_for_planning');
    expect(await isPlanAwaitingApproval(a, dir)).toBe(false);
  });

  it('positive: ready_for_planning WITH an unapproved latest plan', async () => {
    await writeFile(join(dir, 'plan.md'), '# plan content\n');
    const a = assignment('status: ready_for_planning');
    expect(await isPlanAwaitingApproval(a, dir)).toBe(true);
  });

  it('negative: plan exists AND is approved (digest matches latest)', async () => {
    const content = '# plan content\n';
    await writeFile(join(dir, 'plan.md'), content);
    const digest = planDigest(content);
    const a = assignment(
      `status: ready_for_planning\nplanApproval:\n  file: plan.md\n  digest: ${digest}\n  by: human\n  at: "2026-06-16T00:00:00Z"`,
    );
    expect(await isPlanAwaitingApproval(a, dir)).toBe(false);
  });

  it('negative: wrong status even with an unapproved plan', async () => {
    await writeFile(join(dir, 'plan.md'), '# plan content\n');
    for (const s of ['ready_to_implement', 'in_progress', 'draft']) {
      expect(await isPlanAwaitingApproval(assignment(`status: ${s}`), dir)).toBe(false);
    }
  });
});

// ── resolveSince fallback chain ────────────────────────────────────────────────

describe('resolveSince', () => {
  const now = Date.parse('2026-06-16T12:00:00Z');

  it('review: picks latest statusHistory entry with to===review', () => {
    const a = assignment(
      [
        'status: review',
        'statusHistory:',
        '  - at: "2026-06-10T00:00:00Z"',
        '    to: in_progress',
        '    command: start',
        '  - at: "2026-06-11T00:00:00Z"',
        '    to: review',
        '    command: review',
        '  - at: "2026-06-12T00:00:00Z"',
        '    to: review',
        '    command: review',
      ].join('\n'),
    );
    expect(resolveSince('review', a, now)).toBe('2026-06-12T00:00:00Z');
  });

  it('blocked: picks latest statusHistory entry with dispositionTo===blocked', () => {
    const a = assignment(
      [
        'status: blocked',
        'statusHistory:',
        '  - at: "2026-06-10T00:00:00Z"',
        '    to: in_progress',
        '    command: start',
        '  - at: "2026-06-11T00:00:00Z"',
        '    to: blocked',
        '    command: block',
        '    dispositionTo: blocked',
      ].join('\n'),
    );
    expect(resolveSince('blocked', a, now)).toBe('2026-06-11T00:00:00Z');
  });

  it('question: uses comment.timestamp', () => {
    const a = assignment('status: in_progress');
    const c = comment({ id: 'q', timestamp: '2026-06-09T08:00:00Z' });
    expect(resolveSince('question', a, now, c)).toBe('2026-06-09T08:00:00Z');
  });

  it('plan-approval: uses latest statusHistory .at', () => {
    const a = assignment(
      [
        'status: ready_for_planning',
        'statusHistory:',
        '  - at: "2026-06-05T00:00:00Z"',
        '    to: draft',
        '    command: ""',
        '  - at: "2026-06-08T00:00:00Z"',
        '    to: ready_for_planning',
        '    command: shape',
      ].join('\n'),
    );
    expect(resolveSince('plan-approval', a, now)).toBe('2026-06-08T00:00:00Z');
  });

  it('fallback: category entry missing → latest statusHistory .at', () => {
    const a = assignment(
      [
        'status: review',
        'statusHistory:',
        '  - at: "2026-06-07T00:00:00Z"',
        '    to: in_progress',
        '    command: start',
      ].join('\n'),
    );
    // no to===review entry → falls back to latest statusHistory .at
    expect(resolveSince('review', a, now)).toBe('2026-06-07T00:00:00Z');
  });

  it('fallback: no statusHistory → frontmatter updated', () => {
    const a = assignment('status: review\nupdated: "2026-06-06T00:00:00Z"\ncreated: "2026-06-01T00:00:00Z"');
    expect(resolveSince('review', a, now)).toBe('2026-06-06T00:00:00Z');
  });

  it('fallback: no statusHistory, no updated → created', () => {
    const a = assignment('status: review\ncreated: "2026-06-01T00:00:00Z"');
    expect(resolveSince('review', a, now)).toBe('2026-06-01T00:00:00Z');
  });

  it('fallback: nothing → now, normalized to canonical RFC 3339 (no millis)', () => {
    const a = assignment('status: review');
    const since = resolveSince('review', a, now);
    expect(Number.isNaN(Date.parse(since))).toBe(false);
    // Canonical: no millis, trailing Z.
    expect(since).toBe('2026-06-16T12:00:00Z');
    expect(since).not.toMatch(/\.\d{3}Z$/);
  });

  it('skips invalid timestamps in the chain', () => {
    const a = assignment('status: review\nupdated: not-a-date\ncreated: "2026-06-01T00:00:00Z"');
    expect(resolveSince('review', a, now)).toBe('2026-06-01T00:00:00Z');
  });

  it('normalizes a date-only timestamp to ...T00:00:00Z', () => {
    // `created: 2026-06-01` (no time) → canonical midnight RFC 3339.
    const a = assignment('status: review\ncreated: "2026-06-01"');
    expect(resolveSince('review', a, now)).toBe('2026-06-01T00:00:00Z');
  });

  it('leaves an already-canonical full timestamp unchanged', () => {
    const a = assignment('status: review\nupdated: "2026-06-17T03:54:48Z"');
    expect(resolveSince('review', a, now)).toBe('2026-06-17T03:54:48Z');
  });
});

// ── computeAgeMs clamp ─────────────────────────────────────────────────────────

describe('computeAgeMs', () => {
  const now = Date.parse('2026-06-16T12:00:00Z');
  it('computes positive age', () => {
    expect(computeAgeMs('2026-06-16T11:00:00Z', now)).toBe(60 * 60 * 1000);
  });
  it('clamps a future since to 0', () => {
    expect(computeAgeMs('2026-06-16T13:00:00Z', now)).toBe(0);
  });
  it('non-parseable since → 0', () => {
    expect(computeAgeMs('garbage', now)).toBe(0);
  });
});

// ── accept-verb derivation ─────────────────────────────────────────────────────

describe('deriveReviewVerbs', () => {
  it('default config → accept=complete, reopen=start (active target from review)', () => {
    const v = deriveReviewVerbs(defaultStatusConfig());
    expect(v.accept).toBe('complete');
    // review:start -> in_progress (active, non-terminal) → reopen
    expect(v.reopen).toBe('start');
  });

  it('accept is null when the only review→terminal command is a non-CLI verb', () => {
    // `ship` reaches a terminal status but is NOT a registered CLI verb, so it is
    // not runnable (no `syntaur transition` fallback) → accept must be null.
    const transitions = [
      { from: 'review', command: 'ship', to: 'shipped' },
      { from: 'review', command: 'start', to: 'in_progress' },
    ];
    const cfg: InboxStatusConfig = {
      statuses: [
        { id: 'review' },
        { id: 'shipped', terminal: true },
        { id: 'in_progress' },
      ],
      transitions,
      transitionTable: buildTransitionTable(transitions),
      terminalStatuses: new Set(['shipped']),
    };
    const v = deriveReviewVerbs(cfg);
    expect(v.accept).toBeNull();
    // `start` → in_progress (active) is a known reopen verb.
    expect(v.reopen).toBe('start');
  });

  it('prefers a non-fail terminal command for accept; fail alone → accept null', () => {
    const both = [
      { from: 'review', command: 'fail', to: 'failed' },
      { from: 'review', command: 'complete', to: 'completed' },
    ];
    const cfgBoth: InboxStatusConfig = {
      statuses: [{ id: 'completed', terminal: true }, { id: 'failed', terminal: true }],
      transitions: both,
      transitionTable: buildTransitionTable(both),
      terminalStatuses: new Set(['completed', 'failed']),
    };
    expect(deriveReviewVerbs(cfgBoth).accept).toBe('complete');

    // Only `fail` reaches terminal → `fail` is explicitly excluded from accept.
    const failOnly = [{ from: 'review', command: 'fail', to: 'failed' }];
    const cfgFail: InboxStatusConfig = {
      statuses: [{ id: 'failed', terminal: true }],
      transitions: failOnly,
      transitionTable: buildTransitionTable(failOnly),
      terminalStatuses: new Set(['failed']),
    };
    expect(deriveReviewVerbs(cfgFail).accept).toBeNull();
  });

  it('accept is null when no review→terminal command resolves', () => {
    const transitions = [{ from: 'review', command: 'start', to: 'in_progress' }];
    const cfg: InboxStatusConfig = {
      statuses: [{ id: 'in_progress' }],
      transitions,
      transitionTable: buildTransitionTable(transitions),
      terminalStatuses: new Set(['completed', 'failed']),
    };
    const v = deriveReviewVerbs(cfg);
    expect(v.accept).toBeNull();
    expect(v.reopen).toBe('start');
  });

  it('reopen prefers start over reopen when both target an active status', () => {
    const transitions = [
      { from: 'review', command: 'reopen', to: 'in_progress' },
      { from: 'review', command: 'start', to: 'in_progress' },
      { from: 'review', command: 'complete', to: 'completed' },
    ];
    const cfg: InboxStatusConfig = {
      statuses: [{ id: 'in_progress' }, { id: 'completed', terminal: true }],
      transitions,
      transitionTable: buildTransitionTable(transitions),
      terminalStatuses: new Set(['completed']),
    };
    const v = deriveReviewVerbs(cfg);
    expect(v.accept).toBe('complete');
    expect(v.reopen).toBe('start');
  });

  it('reopen is null when start targets a blocked/parked headline status (target disposition, not command name)', () => {
    // Malformed/custom `review:start -> blocked`: `start` is a reopen-eligible
    // command name, but its TARGET is a blocked headline status, so it must NOT
    // be labeled "Reopen".
    const transitions = [
      { from: 'review', command: 'start', to: 'blocked' },
      { from: 'review', command: 'complete', to: 'completed' },
    ];
    const cfg: InboxStatusConfig = {
      statuses: [
        { id: 'blocked' },
        { id: 'completed', terminal: true },
      ],
      transitions,
      transitionTable: buildTransitionTable(transitions),
      terminalStatuses: new Set(['completed']),
      blockedParkedStatuses: new Set(['blocked', 'parked']),
    };
    const v = deriveReviewVerbs(cfg);
    expect(v.accept).toBe('complete');
    expect(v.reopen).toBeNull();
  });

  it('reopen=reopen when reopen targets an active (non-headline) status', () => {
    const transitions = [
      { from: 'review', command: 'reopen', to: 'in_progress' },
      { from: 'review', command: 'complete', to: 'completed' },
    ];
    const cfg: InboxStatusConfig = {
      statuses: [{ id: 'in_progress' }, { id: 'completed', terminal: true }],
      transitions,
      transitionTable: buildTransitionTable(transitions),
      terminalStatuses: new Set(['completed']),
      blockedParkedStatuses: new Set(['blocked', 'parked']),
    };
    const v = deriveReviewVerbs(cfg);
    expect(v.accept).toBe('complete');
    expect(v.reopen).toBe('reopen');
  });
});

// ── action descriptor (exact command strings) ──────────────────────────────────

describe('buildAction', () => {
  const projItem = { project: 'proj', assignmentSlug: 'my-slug', assignmentId: 'uuid-1' };
  const standalone = { project: null, assignmentSlug: 'uuid-2', assignmentId: 'uuid-2' };

  it('review (project): Accept + complete command with --project', () => {
    expect(buildAction('review', projItem, { acceptCommand: 'complete', reopenCommand: 'start' })).toEqual({
      verb: 'Accept',
      command: 'syntaur complete my-slug --project proj',
    });
  });
  it('review (standalone): omits --project, targets UUID', () => {
    expect(buildAction('review', standalone, { acceptCommand: 'complete', reopenCommand: 'start' })).toEqual({
      verb: 'Accept',
      command: 'syntaur complete uuid-2',
    });
  });
  it('review: falls back to Reopen when accept is null', () => {
    expect(buildAction('review', projItem, { acceptCommand: null, reopenCommand: 'start' })).toEqual({
      verb: 'Reopen',
      command: 'syntaur start my-slug --project proj',
    });
  });
  it('review: inspect fallback when neither accept nor reopen resolves', () => {
    expect(buildAction('review', projItem, { acceptCommand: null, reopenCommand: null })).toEqual({
      verb: 'Review',
      command: 'syntaur timeline my-slug --project proj',
    });
  });
  it('blocked: Unblock command', () => {
    expect(buildAction('blocked', projItem, {})).toEqual({
      verb: 'Unblock',
      command: 'syntaur unblock my-slug --project proj',
    });
  });
  it('question: Answer command with --reply-to', () => {
    expect(buildAction('question', projItem, { commentId: 'cid' })).toEqual({
      verb: 'Answer',
      command: 'syntaur comment my-slug "<answer>" --reply-to cid --project proj',
    });
  });
  it('plan-approval: Approve plan command', () => {
    expect(buildAction('plan-approval', projItem, {})).toEqual({
      verb: 'Approve plan',
      command: 'syntaur plan approve my-slug --project proj',
    });
  });
});

// ── ordering ───────────────────────────────────────────────────────────────────

describe('orderByUrgency', () => {
  it('orders largest ageMs first', () => {
    const item = (id: string, ageMs: number): InboxItem => ({
      project: null,
      assignmentSlug: id,
      assignmentId: id,
      title: id,
      category: 'review',
      since: '2026-06-01T00:00:00Z',
      ageMs,
      summary: '',
      action: { verb: 'Accept', command: '' },
    });
    const ordered = orderByUrgency([item('a', 100), item('b', 5000), item('c', 300)]);
    expect(ordered.map((i) => i.assignmentSlug)).toEqual(['b', 'c', 'a']);
  });
});
