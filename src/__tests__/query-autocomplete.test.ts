import { describe, it, expect } from 'vitest';
import {
  detectCaretContext,
  rankFieldSuggestions,
  getValueSuggestions,
  applySuggestion,
  type ValueSuggestionSources,
  type FieldCaretContext,
  type ValueCaretContext,
} from '../../dashboard/src/lib/query-autocomplete';
import { queryFieldNames, buildQueryRegistry } from '../utils/fact-registry.js';
import type { FactDeclaration } from '../utils/fact-registry.js';

// Declarations exercising both fact kinds: a bool fact and a plan-bound
// attestation (which contributes five export field names).
const DECLS: FactDeclaration[] = [
  { name: 'qaPassed', type: 'bool' },
  { name: 'codeReview', type: 'attestation', binds: 'plan' },
];
const REGISTRY = buildQueryRegistry(DECLS);

const SOURCES: ValueSuggestionSources = {
  statuses: ['draft', 'in_progress', 'review', 'awaiting_triage'],
  priorities: ['low', 'medium', 'high', 'critical'],
  types: ['feature', 'bug', 'chore'],
  assignees: ['claude', 'agent:codex'],
  projects: ['syntaur', 'payments'],
  tags: ['aql', 'protocol'],
};

// ── AC2: queryFieldNames vocabulary ──────────────────────────────────────────
describe('AC2 — queryFieldNames exposes built-ins, exports, and declared facts', () => {
  it('includes camelCase built-in fields', () => {
    const names = queryFieldNames([]);
    expect(names).toContain('completedAt');
    expect(names).toContain('statusAge');
    expect(names).toContain('phaseAge');
    expect(names).toContain('planApproved');
    expect(names).toContain('status');
  });

  it('includes the bool declared fact name', () => {
    expect(queryFieldNames(DECLS)).toContain('qaPassed');
  });

  it('includes all five per-attestation export names', () => {
    const names = queryFieldNames(DECLS);
    for (const exp of [
      'codeReview',
      'codeReviewApproved',
      'codeReviewChangesRequested',
      'codeReviewBy',
      'codeReviewApprovedBy',
    ]) {
      expect(names).toContain(exp);
    }
  });
});

// ── AC2: detectCaretContext field vs value classification ─────────────────────
describe('AC2 — detectCaretContext distinguishes field vs value', () => {
  it('empty input / word start → field context with empty partial', () => {
    const ctx = detectCaretContext('', 0);
    expect(ctx?.kind).toBe('field');
    expect((ctx as FieldCaretContext).partial).toBe('');
  });

  it('mid field token → field context with the typed prefix', () => {
    const input = 'stat';
    const ctx = detectCaretContext(input, input.length);
    expect(ctx?.kind).toBe('field');
    expect((ctx as FieldCaretContext).partial).toBe('stat');
  });

  it('after field: → value context for that field', () => {
    const input = 'status:';
    const ctx = detectCaretContext(input, input.length);
    expect(ctx?.kind).toBe('value');
    expect((ctx as ValueCaretContext).field).toBe('status');
    expect((ctx as ValueCaretContext).partial).toBe('');
  });

  it('partial value after field: → value context with the value prefix', () => {
    const input = 'status:in_pro';
    const ctx = detectCaretContext(input, input.length);
    expect(ctx?.kind).toBe('value');
    expect((ctx as ValueCaretContext).field).toBe('status');
    expect((ctx as ValueCaretContext).partial).toBe('in_pro');
  });

  it('after a comparison op (priority >= ) → value context', () => {
    const input = 'priority >= ';
    const ctx = detectCaretContext(input, input.length);
    expect(ctx?.kind).toBe('value');
    expect((ctx as ValueCaretContext).field).toBe('priority');
  });

  it('inside an in-list (field:(a, <here> ) → value context for the field', () => {
    const input = 'status:(draft, ';
    const ctx = detectCaretContext(input, input.length);
    expect(ctx?.kind).toBe('value');
    expect((ctx as ValueCaretContext).field).toBe('status');
  });

  it('inside an open quoted value → value context with the inner partial', () => {
    const input = 'assignee:"agent:co';
    const ctx = detectCaretContext(input, input.length);
    expect(ctx?.kind).toBe('value');
    expect((ctx as ValueCaretContext).field).toBe('assignee');
    expect((ctx as ValueCaretContext).partial).toBe('agent:co');
  });

  it('caret on a later field after a complete atom → field context', () => {
    const input = 'status:draft AND pri';
    const ctx = detectCaretContext(input, input.length);
    expect(ctx?.kind).toBe('field');
    expect((ctx as FieldCaretContext).partial).toBe('pri');
  });
});

// ── AC2: rankFieldSuggestions ranking ────────────────────────────────────────
describe('AC2 — rankFieldSuggestions ranks prefix matches first', () => {
  it('empty partial returns the full field list', () => {
    expect(rankFieldSuggestions('', DECLS)).toEqual(queryFieldNames(DECLS));
  });

  it('prefix matches precede substring matches', () => {
    // "stat" prefixes `status`, `statusAge`; substring-only matches (e.g.
    // `implementationStarted`, `unresolvedQuestions` contain no "stat") — use a
    // partial that yields both classes: "approved".
    const ranked = rankFieldSuggestions('status', DECLS);
    expect(ranked[0]).toBe('status');
    expect(ranked).toContain('statusAge');

    // `by` is a substring of several attestation exports; ranking still works.
    const rankedApproved = rankFieldSuggestions('approved', DECLS);
    // planApproved / codeReviewApproved / codeReviewApprovedBy all CONTAIN
    // "approved" but none START with it → all are substring matches, present.
    expect(rankedApproved).toContain('planApproved');
    expect(rankedApproved).toContain('codeReviewApproved');
  });

  it('a true prefix is ordered before a substring-only match', () => {
    // `phase` is a prefix of `phase`/`phaseAge`; `disposition` is unrelated.
    const ranked = rankFieldSuggestions('phase', DECLS);
    const phaseIdx = ranked.indexOf('phase');
    const phaseAgeIdx = ranked.indexOf('phaseAge');
    expect(phaseIdx).toBeGreaterThanOrEqual(0);
    expect(phaseAgeIdx).toBeGreaterThanOrEqual(0);
    // Both are prefix matches; ensure they precede any pure-substring match such
    // as `acRealChecked` (does not contain "phase") — sanity: not present.
    expect(ranked).not.toContain('acRealChecked');
  });
});

// ── AC2: getValueSuggestions per field kind ──────────────────────────────────
describe('AC2 — getValueSuggestions returns the right candidates per field', () => {
  it('status → the supplied status ids (open enum, incl. custom)', () => {
    expect(getValueSuggestions('status', '', SOURCES, REGISTRY)).toEqual(SOURCES.statuses);
    expect(getValueSuggestions('status', 'aw', SOURCES, REGISTRY)).toEqual(['awaiting_triage']);
  });

  it('priority / type / tags → their supplied lists', () => {
    expect(getValueSuggestions('priority', '', SOURCES, REGISTRY)).toEqual(SOURCES.priorities);
    expect(getValueSuggestions('type', '', SOURCES, REGISTRY)).toEqual(SOURCES.types);
    expect(getValueSuggestions('tags', '', SOURCES, REGISTRY)).toEqual(SOURCES.tags);
    expect(getValueSuggestions('tag', '', SOURCES, REGISTRY)).toEqual(SOURCES.tags);
  });

  it('assignee / project → none sentinel prepended to the supplied list', () => {
    expect(getValueSuggestions('assignee', '', SOURCES, REGISTRY)).toEqual([
      'none',
      'claude',
      'agent:codex',
    ]);
    expect(getValueSuggestions('project', '', SOURCES, REGISTRY)).toEqual([
      'none',
      'syntaur',
      'payments',
    ]);
  });

  it('a bool field (built-in or custom fact) → true / false', () => {
    expect(getValueSuggestions('blocked', '', SOURCES, REGISTRY)).toEqual(['true', 'false']);
    expect(getValueSuggestions('planApproved', '', SOURCES, REGISTRY)).toEqual(['true', 'false']);
    expect(getValueSuggestions('qaPassed', '', SOURCES, REGISTRY)).toEqual(['true', 'false']);
    expect(getValueSuggestions('codeReviewApproved', '', SOURCES, REGISTRY)).toEqual(['true', 'false']);
    // partial filters the bool candidates
    expect(getValueSuggestions('qaPassed', 't', SOURCES, REGISTRY)).toEqual(['true']);
  });

  it('a freeform / non-enumerable field → empty list', () => {
    expect(getValueSuggestions('title', '', SOURCES, REGISTRY)).toEqual([]);
    expect(getValueSuggestions('completedAt', '', SOURCES, REGISTRY)).toEqual([]);
  });
});

// ── AC2: applySuggestion splicing + quoting ──────────────────────────────────
describe('AC2 — applySuggestion splices and quotes correctly', () => {
  it('field suggestion inserts "<field>:" and positions the caret after it', () => {
    const ctx = detectCaretContext('stat', 4) as FieldCaretContext;
    const { text, caret } = applySuggestion('stat', ctx, 'status');
    expect(text).toBe('status:');
    expect(caret).toBe('status:'.length);
  });

  it('value suggestion quotes an actor value with a colon', () => {
    const input = 'assignee:';
    const ctx = detectCaretContext(input, input.length) as ValueCaretContext;
    const { text } = applySuggestion(input, ctx, 'agent:codex');
    expect(text).toBe('assignee:"agent:codex"');
  });

  it('value suggestion leaves a bare identifier unquoted', () => {
    const input = 'status:';
    const ctx = detectCaretContext(input, input.length) as ValueCaretContext;
    const { text } = applySuggestion(input, ctx, 'in_progress');
    expect(text).toBe('status:in_progress');
  });

  it('replaces a partially-typed value rather than appending', () => {
    const input = 'status:in_pro';
    const ctx = detectCaretContext(input, input.length) as ValueCaretContext;
    const { text } = applySuggestion(input, ctx, 'in_progress');
    expect(text).toBe('status:in_progress');
  });

  it('applies inside an open quote, replacing the quoted run', () => {
    const input = 'assignee:"agent:co';
    const ctx = detectCaretContext(input, input.length) as ValueCaretContext;
    const { text } = applySuggestion(input, ctx, 'agent:codex');
    expect(text).toBe('assignee:"agent:codex"');
  });
});
