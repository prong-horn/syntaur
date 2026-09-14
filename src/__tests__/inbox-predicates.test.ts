import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isReview,
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
import { parseTicketFull, type ParsedTicketFull, type ParsedComment } from '../dashboard/parser.js';
import { planDigest } from '../ticket-templates/plan-facts.js';

function buildTransitionTable(
  transitions: Array<{ from: string; command: string; to: string }>,
): Map<string, string> {
  const table = new Map<string, string>();
  for (const t of transitions) {
    table.set(`${t.from}:${t.command}`, t.to);
  }
  return table;
}

function defaultStatusConfig(): InboxStatusConfig {
  const transitions = [
    { from: 'review', command: 'complete', to: 'completed' },
    { from: 'review', command: 'start', to: 'in_progress' },
  ];
  return {
    statuses: [
      { id: 'review' },
      { id: 'in_progress' },
      { id: 'completed', terminal: true },
    ],
    transitions,
    transitionTable: buildTransitionTable(transitions),
    terminalStatuses: new Set(['completed']),
    blockedParkedStatuses: new Set(['blocked', 'parked']),
  };
}

/** Build a ParsedTicketFull from frontmatter by round-tripping the real parser. */
function ticket(frontmatter: string): ParsedTicketFull {
  return parseTicketFull(`---\n${frontmatter}\n---\n# body\n`);
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

// ── isReview ───────────────────────────────────────────────────────────────────

describe('isReview', () => {
  it('positive: derived status === review', () => {
    expect(isReview(ticket('status: review'))).toBe(true);
  });
  it('negative: any other status', () => {
    for (const s of ['backlog', 'ready', 'in_progress', 'done', 'planning']) {
      expect(isReview(ticket(`status: ${s}`))).toBe(false);
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

  it('negative: planning WITHOUT a plan file', async () => {
    const a = ticket('status: planning\ntemplate: feature');
    expect(await isPlanAwaitingApproval(a, dir)).toBe(false);
  });

  it('positive: backlog WITH plan role file on disk and no plan.file set', async () => {
    await writeFile(join(dir, 'plan.md'), '# plan content\n');
    const a = ticket('status: backlog\ntemplate: feature');
    expect(await isPlanAwaitingApproval(a, dir)).toBe(true);
  });

  it('positive: planning WITH plan.file and an unapproved plan', async () => {
    await writeFile(join(dir, 'plan.md'), '# plan content\n');
    const a = ticket(
      'status: planning\ntemplate: feature\nplan:\n  file: plan.md\n  approvedDigest: null\n  approvedAt: null\n  approvedBy: null',
    );
    expect(await isPlanAwaitingApproval(a, dir)).toBe(true);
  });

  it('negative: plan exists AND is approved (digest matches latest)', async () => {
    const content = '# plan content\n';
    await writeFile(join(dir, 'plan.md'), content);
    const digest = planDigest(content);
    const a = ticket(
      `status: planning\ntemplate: feature\nplan:\n  file: plan.md\n  approvedDigest: ${digest}\n  by: human\n  at: "2026-06-16T00:00:00Z"`,
    );
    expect(await isPlanAwaitingApproval(a, dir)).toBe(false);
  });

  it('negative: terminal status even with an unapproved plan', async () => {
    await writeFile(join(dir, 'plan.md'), '# plan content\n');
    for (const s of ['done', 'dropped']) {
      expect(await isPlanAwaitingApproval(ticket(`status: ${s}\ntemplate: feature`), dir)).toBe(false);
    }
  });

  it('positive: in_progress with an unapproved plan still qualifies', async () => {
    await writeFile(join(dir, 'plan.md'), '# plan content\n');
    const a = ticket(
      'status: in_progress\ntemplate: feature\nplan:\n  file: plan.md\n  approvedDigest: null\n  approvedAt: null\n  approvedBy: null',
    );
    expect(await isPlanAwaitingApproval(a, dir)).toBe(true);
  });
});

// ── resolveSince fallback chain ────────────────────────────────────────────────

describe('resolveSince', () => {
  const now = Date.parse('2026-06-16T12:00:00Z');

  it('review: falls back to updated when no moved events exist', () => {
    const a = ticket('status: review\nupdated: "2026-06-12T00:00:00Z"');
    expect(resolveSince('review', a, now)).toBe('2026-06-12T00:00:00Z');
  });

  it('question: uses comment.timestamp', () => {
    const a = ticket('status: in_progress');
    const c = comment({ id: 'q', timestamp: '2026-06-09T08:00:00Z' });
    expect(resolveSince('question', a, now, c)).toBe('2026-06-09T08:00:00Z');
  });

  it('plan-approval: falls back to updated when no moved events exist', () => {
    const a = ticket('status: planning\nupdated: "2026-06-08T00:00:00Z"');
    expect(resolveSince('plan-approval', a, now)).toBe('2026-06-08T00:00:00Z');
  });

  it('fallback: no moved events → frontmatter updated', () => {
    const a = ticket('status: review\nupdated: "2026-06-06T00:00:00Z"\ncreated: "2026-06-01T00:00:00Z"');
    expect(resolveSince('review', a, now)).toBe('2026-06-06T00:00:00Z');
  });

  it('fallback: no moved events, no updated → created', () => {
    const a = ticket('status: review\ncreated: "2026-06-01T00:00:00Z"');
    expect(resolveSince('review', a, now)).toBe('2026-06-01T00:00:00Z');
  });

  it('fallback: nothing → now, normalized to canonical RFC 3339 (no millis)', () => {
    const a = ticket('status: review');
    const since = resolveSince('review', a, now);
    expect(Number.isNaN(Date.parse(since))).toBe(false);
    // Canonical: no millis, trailing Z.
    expect(since).toBe('2026-06-16T12:00:00Z');
    expect(since).not.toMatch(/\.\d{3}Z$/);
  });

  it('skips invalid timestamps in the chain', () => {
    const a = ticket('status: review\nupdated: not-a-date\ncreated: "2026-06-01T00:00:00Z"');
    expect(resolveSince('review', a, now)).toBe('2026-06-01T00:00:00Z');
  });

  it('normalizes a date-only timestamp to ...T00:00:00Z', () => {
    // `created: 2026-06-01` (no time) → canonical midnight RFC 3339.
    const a = ticket('status: review\ncreated: "2026-06-01"');
    expect(resolveSince('review', a, now)).toBe('2026-06-01T00:00:00Z');
  });

  it('leaves an already-canonical full timestamp unchanged', () => {
    const a = ticket('status: review\nupdated: "2026-06-17T03:54:48Z"');
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
  it('returns fixed v2 review verbs regardless of status config', () => {
    expect(deriveReviewVerbs(defaultStatusConfig())).toEqual({
      accept: 'done',
      reopen: null,
      logReviewHint: 'Log an approving review',
    });
    expect(deriveReviewVerbs()).toEqual({
      accept: 'done',
      reopen: null,
      logReviewHint: 'Log an approving review',
    });
  });
});

// ── action descriptor (exact command strings) ──────────────────────────────────

describe('buildAction', () => {
  const projItem = { project: 'proj', ticketSlug: 'my-slug', ticketId: 'uuid-1' };
  const standalone = { project: null, ticketSlug: 'uuid-2', ticketId: 'uuid-2' };

  it('review (project): Accept + done command with --project', () => {
    expect(buildAction('review', projItem, { acceptCommand: 'done', reopenCommand: 'reopen' })).toEqual({
      verb: 'Accept',
      command: 'syntaur done my-slug --project proj',
    });
  });
  it('review (standalone): omits --project, targets UUID', () => {
    expect(buildAction('review', standalone, { acceptCommand: 'done', reopenCommand: 'reopen' })).toEqual({
      verb: 'Accept',
      command: 'syntaur done uuid-2',
    });
  });
  it('review: falls back to log-review hint when accept is null', () => {
    expect(
      buildAction('review', projItem, {
        acceptCommand: null,
        reopenCommand: null,
        logReviewHint: 'Log an approving review',
      }),
    ).toEqual({
      verb: 'Log review',
      command: 'Log an approving review',
    });
  });
  it('review: inspect fallback when no review action resolves', () => {
    expect(buildAction('review', projItem, { acceptCommand: null, reopenCommand: null })).toEqual({
      verb: 'Review',
      command: 'syntaur timeline my-slug --project proj',
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
      command: 'syntaur approve my-slug --project proj',
    });
  });
});

// ── ordering ───────────────────────────────────────────────────────────────────

describe('orderByUrgency', () => {
  it('orders largest ageMs first', () => {
    const item = (id: string, ageMs: number): InboxItem => ({
      project: null,
      ticketSlug: id,
      ticketId: id,
      title: id,
      category: 'review',
      since: '2026-06-01T00:00:00Z',
      ageMs,
      summary: '',
      action: { verb: 'Accept', command: '' },
      ticketUpdated: '',
    });
    const ordered = orderByUrgency([item('a', 100), item('b', 5000), item('c', 300)]);
    expect(ordered.map((i) => i.ticketSlug)).toEqual(['b', 'c', 'a']);
  });
});
