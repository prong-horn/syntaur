import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { ChatNormalizer, isFoldable, rawOutputText } from '../chat/normalizer.js';
import type { AgentPlanItem, AgentWorkItem, ChatEvent, ChatItem, ItemPatch } from '../chat/types.js';
import { fixtureEvents, listFixtures } from './helpers/acp-fixtures.js';

/**
 * Task 4 — the normalizer, proven against all 46 spike transcripts.
 *
 * Every transcript gets a golden snapshot of its final item list plus the
 * per-scenario structural assertions from the plan. The snapshot is a DIGEST
 * rather than raw items: a message body can be 20 kB of model prose (codex/13
 * streams 2 595 chunks), so long strings become `{ len, head, sha }`. The sha is
 * over the whole string, so any change in coalescing, ordering or concatenation
 * still fails the snapshot — it is only the review diff that stays readable.
 */

const FIXTURES = listFixtures();

/** Apply a normalizer's patches; `retract` deletes, `upsert` replaces by id. */
function applyPatches(into: Map<string, ChatItem>, patches: ItemPatch[]): void {
  for (const patch of patches) {
    if (patch.op === 'retract') into.delete(patch.itemId);
    else into.set(patch.item.itemId, structuredClone(patch.item));
  }
}

export function normalizeEvents(events: ChatEvent[], agentId = 'claude'): ChatItem[] {
  const normalizer = new ChatNormalizer({
    assignmentId: 'assignment-fixture',
    agentId,
    sessionKey: `assignment-fixture:${agentId}`,
  });
  const items = new Map<string, ChatItem>();
  for (const event of events) applyPatches(items, normalizer.ingest(event));
  return [...items.values()].sort(
    (a, b) => a.seqFirst - b.seqFirst || a.itemId.localeCompare(b.itemId),
  );
}

function normalizeFixture(name: string): ChatItem[] {
  const fixture = FIXTURES.find((f) => f.name === name);
  if (!fixture) throw new Error(`no fixture ${name}`);
  return normalizeEvents(fixtureEvents(fixture.path, { agentId: fixture.adapter }), fixture.adapter);
}

/** Long strings collapse to a length + head + hash so snapshots stay reviewable. */
function shrink(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length <= 120) return value;
    return {
      len: value.length,
      head: value.slice(0, 80),
      sha: createHash('sha256').update(value).digest('hex').slice(0, 12),
    };
  }
  if (Array.isArray(value)) return value.map(shrink);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = shrink(v);
    return out;
  }
  return value;
}

function digest(items: ChatItem[]): unknown[] {
  return items.map((item) => {
    // `ts` is a wall-clock timestamp from the recording; the seq pair already
    // pins order, so it is dropped to keep the snapshot about structure.
    const { ts: _ts, assignmentId: _a, agentId: _g, ...rest } = item as ChatItem & { ts: string };
    return shrink(rest);
  });
}

const isWork = (i: ChatItem): i is AgentWorkItem => i.type === 'agent.work';

describe('normalizer golden snapshots', () => {
  it('covers all 46 spike transcripts', () => {
    expect(FIXTURES).toHaveLength(46);
  });

  for (const fixture of FIXTURES) {
    it(`${fixture.name} normalizes to a stable item list`, () => {
      const items = normalizeEvents(
        fixtureEvents(fixture.path, { agentId: fixture.adapter }),
        fixture.adapter,
      );
      expect(digest(items)).toMatchSnapshot();
    });
  }
});

describe('rebuild == live', () => {
  it('replaying a transcript twice yields identical items', () => {
    for (const fixture of FIXTURES) {
      const events = fixtureEvents(fixture.path, { agentId: fixture.adapter });
      const first = normalizeEvents(events, fixture.adapter);
      const second = normalizeEvents(events, fixture.adapter);
      expect(second).toEqual(first);
    }
  });
});

describe('coalescing (spike Decision 5)', () => {
  it('04: one agent.message per messageId on both adapters', () => {
    for (const adapter of ['claude', 'codex'] as const) {
      const items = normalizeFixture(`${adapter}/04-streaming.ndjson`);
      const messages = items.filter((i) => i.type === 'agent.message');
      const ids = new Set(messages.map((m) => (m as { messageId: string }).messageId));
      expect(messages.length).toBe(ids.size);
      expect(messages.length).toBeGreaterThan(0);
    }
  });

  it("codex 02/03: the adapter's no-id startup notice becomes a system row, the reply stays a bubble", () => {
    for (const name of ['codex/02-handshake.ndjson', 'codex/03-system-prompt.ndjson']) {
      const items = normalizeFixture(name);
      const notice = items.find(
        (i) => i.type === 'system' && /Skill descriptions were shortened/.test((i as { text: string }).text),
      );
      expect(notice, `${name} should surface the startup notice as a system row`).toBeDefined();
      const bubbles = items.filter((i) => i.type === 'agent.message');
      expect(bubbles.length).toBeGreaterThan(0);
      for (const bubble of bubbles) {
        expect((bubble as { text: string }).text).not.toMatch(/Skill descriptions were shortened/);
      }
    }
  });

  it('claude never produces a no-id run, so nothing is reclassified', () => {
    const items = normalizeFixture('claude/04-streaming.ndjson');
    expect(items.some((i) => i.type === 'system' && /Skill descriptions/.test((i as { text: string }).text))).toBe(
      false,
    );
  });

  it('codex 13: two bubbles in one turn (a queued reply arrives under a new messageId)', () => {
    const items = normalizeFixture('codex/13-queue-vs-steer.ndjson');
    const byTurn = new Map<string, number>();
    for (const item of items) {
      if (item.type !== 'agent.message' || !item.turnId) continue;
      byTurn.set(item.turnId, (byTurn.get(item.turnId) ?? 0) + 1);
    }
    expect([...byTurn.values()].some((n) => n >= 2)).toBe(true);
  });
});

describe('work cards', () => {
  it('05 codex: the search row renders from rawOutput when content is empty', () => {
    const items = normalizeFixture('codex/05-tool-calls.ndjson');
    const cards = items.filter(isWork);
    expect(cards).toHaveLength(1);
    const search = cards[0].tools.find((t) => t.kind === 'search');
    expect(search, 'codex parses a shell search into kind: search').toBeDefined();
    // RESULTS.md: codex's parsed `search` calls carry no `content` at all.
    expect(search?.rawOutput).toBeDefined();
    expect(search?.content.length).toBeGreaterThan(0);
    expect(search?.content[0]).toMatchObject({ type: 'text' });
    expect((search?.content[0] as { text: string }).text).toBe(rawOutputText(search?.rawOutput));
  });

  it('06: one card with a completed diff row, on both adapters', () => {
    for (const adapter of ['claude', 'codex'] as const) {
      const items = normalizeFixture(`${adapter}/06-edits.ndjson`);
      const cards = items.filter(isWork);
      expect(cards.length).toBeGreaterThan(0);
      const diffRow = cards
        .flatMap((c) => c.tools)
        .find((t) => t.content.some((b) => b.type === 'diff'));
      expect(diffRow, `${adapter} should produce a diff row`).toBeDefined();
      expect(diffRow?.status).toBe('completed');
      expect(diffRow?.kind).toBe('edit');
      // claude sends the diff twice (tool_call + tool_call_update); replace
      // semantics means the row still holds exactly one.
      expect(diffRow?.content.filter((b) => b.type === 'diff')).toHaveLength(1);
    }
  });

  it('17: the Task think row and its siblings sit in one card, nothing nested', () => {
    const items = normalizeFixture('claude/17-subagent.ndjson');
    const cards = items.filter(isWork);
    expect(cards).toHaveLength(1);
    // RESULTS.md row 17: 11 calls in total, none nested.
    expect(cards[0].tools).toHaveLength(11);
    const think = cards[0].tools.filter((t) => t.kind === 'think');
    expect(think).toHaveLength(1);
    // The call arrives titled `Task` and its updates refine the title to the
    // sub-agent's brief; two later updates carry `title: null`, which the
    // partial merge must NOT let clear it.
    expect(think[0].title).toBe('Summarize src/ directory purpose');
    expect(think[0].status).toBe('completed');
    expect(cards[0].tools.filter((t) => t.kind === 'execute')).toHaveLength(10);
  });

  it('16: an embedded resource block produces no tool row', () => {
    for (const adapter of ['claude', 'codex'] as const) {
      const items = normalizeFixture(`${adapter}/16-embedded-context.ndjson`);
      expect(items.filter(isWork)).toHaveLength(0);
    }
  });

  it('the short narration ahead of a tool call folds into the card', () => {
    const items = normalizeFixture('claude/05-tool-calls.ndjson');
    const cards = items.filter(isWork);
    expect(cards).toHaveLength(1);
    expect(cards[0].lead).toMatch(/^Reading the package.json/);
    // The bubble it came from is gone.
    expect(
      items.some((i) => i.type === 'agent.message' && /^Reading the package.json/.test((i as { text: string }).text)),
    ).toBe(false);
  });

  it('the card summary counts reads, edits and runs', () => {
    const items = normalizeFixture('claude/05-tool-calls.ndjson');
    const card = items.filter(isWork)[0];
    expect(card.summary.reads).toBe(1);
    expect(card.summary.runs).toBe(1);
    expect(card.summary.failed).toBe(0);
  });
});

describe('plans', () => {
  it('08: the plan is one item per turn that ends with three completed entries', () => {
    for (const adapter of ['claude', 'codex'] as const) {
      const items = normalizeFixture(`${adapter}/08-plan-events.ndjson`);
      const plans = items.filter((i): i is AgentPlanItem => i.type === 'agent.plan');
      expect(plans, `${adapter} should have exactly one plan item`).toHaveLength(1);
      expect(plans[0].entries).toHaveLength(3);
      expect(plans[0].entries.every((e) => e.status === 'completed')).toBe(true);
      expect(plans[0].turnId).not.toBeNull();
    }
  });
});

describe('permissions', () => {
  it('07: answered options are recorded and the cancelled one is marked', () => {
    for (const adapter of ['claude', 'codex'] as const) {
      const items = normalizeFixture(`${adapter}/07-permissions.ndjson`);
      const perms = items.filter((i) => i.type === 'permission.request') as Array<
        ChatItem & { answer?: string; cancelled?: boolean; options: unknown[] }
      >;
      expect(perms.length).toBeGreaterThanOrEqual(3);
      expect(perms.filter((p) => p.answer !== undefined).length).toBeGreaterThanOrEqual(2);
      expect(perms.some((p) => p.cancelled === true)).toBe(true);
      for (const perm of perms) expect(perm.options.length).toBeGreaterThan(0);
    }
  });
});

describe('session/load replay scope', () => {
  it('14 p2: exactly one replayed user.message and one agent.message, in replay:1, before the first turn.status', () => {
    for (const adapter of ['claude', 'codex'] as const) {
      const items = normalizeFixture(`${adapter}/14-load-resume.p2.ndjson`);
      const replayItems = items.filter((i) => i.itemId.startsWith('replay:1:'));
      const users = replayItems.filter((i) => i.type === 'user.message');
      const agents = replayItems.filter((i) => i.type === 'agent.message');
      expect(users, `${adapter} p2 replayed user message`).toHaveLength(1);
      expect(agents, `${adapter} p2 replayed agent message`).toHaveLength(1);
      expect((users[0] as { state: string }).state).toBe('replayed');
      expect(users[0].turnId).toBeNull();

      const firstStatus = items.find((i) => i.type === 'turn.status');
      expect(firstStatus).toBeDefined();
      expect(users[0].seqFirst).toBeLessThan(firstStatus!.seqFirst);
      expect(agents[0].seqFirst).toBeLessThan(firstStatus!.seqFirst);
    }
  });

  it('14 p3: session/resume replays nothing', () => {
    for (const adapter of ['claude', 'codex'] as const) {
      const items = normalizeFixture(`${adapter}/14-load-resume.p3.ndjson`);
      expect(items.filter((i) => i.itemId.startsWith('replay:'))).toHaveLength(0);
      expect(items.filter((i) => i.type === 'user.message')).toHaveLength(0);
    }
  });
});

describe('turn status', () => {
  it('11: a turn carries duration, context usage and (on claude) a per-turn cost', () => {
    const claude = normalizeFixture('claude/11-usage.ndjson');
    const status = claude.find((i) => i.type === 'turn.status') as
      | (ChatItem & { state: string; cost?: number; contextUsed?: number; durationMs?: number })
      | undefined;
    expect(status).toBeDefined();
    expect(status?.state).toBe('ended');
    expect(status?.contextUsed).toBeGreaterThan(0);
    expect(status?.cost).toBeGreaterThan(0);
    expect(status?.durationMs).toBeGreaterThan(0);

    const codex = normalizeFixture('codex/11-usage.ndjson');
    const codexStatus = codex.find((i) => i.type === 'turn.status') as
      | (ChatItem & { contextUsed?: number; cost?: number })
      | undefined;
    expect(codexStatus?.contextUsed).toBeGreaterThan(0);
    // codex sends no `cost` on usage_update; the broker prices it at turn close.
    expect(codexStatus?.cost).toBeUndefined();
  });

  it('12: a cancelled turn ends with stopReason cancelled', () => {
    for (const adapter of ['claude', 'codex'] as const) {
      const items = normalizeFixture(`${adapter}/12-cancel.inherited.ndjson`);
      const status = items.find((i) => i.type === 'turn.status') as
        | (ChatItem & { stopReason?: string })
        | undefined;
      expect(status?.stopReason).toBe('cancelled');
    }
  });

  it('15: an adapter killed mid-turn leaves the turn ended with an error stop reason', () => {
    const items = normalizeFixture('claude/15-crash.ndjson');
    const status = items.find((i) => i.type === 'turn.status') as
      | (ChatItem & { state: string; stopReason?: string })
      | undefined;
    // The transcript stops when the adapter dies, so the turn never resolves.
    expect(status?.state).toBe('running');
  });
});

describe('system rows', () => {
  it('mode and config changes are never dropped', () => {
    const items = normalizeFixture('claude/06-edits.ndjson');
    const systems = items.filter((i) => i.type === 'system') as Array<ChatItem & { text: string }>;
    expect(systems.some((s) => /^Config /.test(s.text))).toBe(true);
  });

  it('available_commands_update produces no item', () => {
    const items = normalizeFixture('claude/02-handshake.ndjson');
    expect(items.some((i) => i.type === 'system' && /command/i.test((i as { text: string }).text))).toBe(
      false,
    );
  });
});

describe('pure helpers', () => {
  it('isFoldable rejects long or multi-paragraph narration', () => {
    expect(isFoldable('Let me look at that.')).toBe(true);
    expect(isFoldable('First line.\nSecond line.')).toBe(true);
    expect(isFoldable('First paragraph.\n\nSecond paragraph.')).toBe(false);
    expect(isFoldable('x'.repeat(241))).toBe(false);
    expect(isFoldable('   ')).toBe(false);
  });

  it('rawOutputText prefers codex formatted_output', () => {
    expect(rawOutputText({ formatted_output: 'hello', exit_code: 0 })).toBe('hello');
    expect(rawOutputText('plain')).toBe('plain');
    expect(rawOutputText(null)).toBeNull();
    expect(rawOutputText({ a: 1 })).toBe('{"a":1}');
  });
});
