import { describe, it, expect } from 'vitest';
import { parseMentions, routeAgentReply, routeHuman, DEFAULT_HOP_BUDGET } from '../chat/router.js';
import { BASE_SYSTEM_PROMPT } from '../chat/agents.js';
import type { AgentDefinition, Participants, RespondsTo, TurnTrigger } from '../chat/types.js';

/**
 * Task 2 — the router, the one place that decides who a message is for (§5.6,
 * Decision 2). Pure: no I/O, no broker, no adapter. Every rule in acceptance
 * criteria 1 and 2 is a case here.
 */

function def(id: string, overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    color: 'slate',
    harness: 'claude',
    respondsTo: 'mentions' as RespondsTo,
    default: false,
    systemPrompt: BASE_SYSTEM_PROMPT,
    source: null,
    ...overrides,
  };
}

const planner = def('planner');
const implementer = def('implementer');
const reviewer = def('reviewer');

function participants(agents: string[], defaultAgent: string | null, hopBudget?: number): Participants {
  return { agents, defaultAgent, ...(hopBudget === undefined ? {} : { hopBudget }) };
}

const human: TurnTrigger = { kind: 'human', messageId: 'm1' };
const handoffAt = (hop: number, fromAgentId = 'planner'): TurnTrigger => ({
  kind: 'handoff',
  handoffId: `h${hop}`,
  fromAgentId,
  hop,
});

describe('parseMentions', () => {
  it('matches the launch-prompt token alphabet: @ at start or after whitespace', () => {
    const { mentioned, unknown } = parseMentions(
      '@planner ping brennen@example.com and (@implementer) too',
      ['planner', 'implementer'],
    );
    // `brennen@example.com` is not a token — the `@` follows a word character.
    // `(@implementer` is not one either: the `@` follows `(`.
    expect(mentioned).toEqual(['planner']);
    expect(unknown).toEqual([]);
  });

  it('matches ids case-insensitively and reports the canonical id', () => {
    expect(parseMentions('hey @PLANNER', ['planner']).mentioned).toEqual(['planner']);
  });

  it('de-duplicates and keeps first-appearance order', () => {
    const { mentioned } = parseMentions('@implementer then @planner then @implementer', [
      'planner',
      'implementer',
    ]);
    expect(mentioned).toEqual(['implementer', 'planner']);
  });

  it('reports a token that names no attached agent as unknown, once', () => {
    const { mentioned, unknown } = parseMentions('@planner and @nobody and @nobody', ['planner']);
    expect(mentioned).toEqual(['planner']);
    expect(unknown).toEqual(['nobody']);
  });

  it('ignores a mention inside an inline code span', () => {
    const { mentioned } = parseMentions(
      'the ids are `@planner` and `@implementer` — ask @reviewer instead',
      ['planner', 'implementer', 'reviewer'],
    );
    // Quoting an id is talking ABOUT an agent, not to it.
    expect(mentioned).toEqual(['reviewer']);
  });

  it('ignores mentions inside a fenced code block', () => {
    const text = ['Run this:', '```sh', 'syntaur chat --to @planner', '```', 'then tell @implementer'].join(
      '\n',
    );
    expect(parseMentions(text, ['planner', 'implementer']).mentioned).toEqual(['implementer']);
  });

  it('does not report a code-span id as unknown either', () => {
    expect(parseMentions('`@nobody` is not a thing', ['planner']).unknown).toEqual([]);
  });

  it('leaves an unterminated backtick alone rather than swallowing the rest', () => {
    expect(parseMentions('a stray ` tick then @planner', ['planner']).mentioned).toEqual(['planner']);
  });

  it('stops the token at punctuation', () => {
    expect(parseMentions('over to @implementer, please', ['implementer']).mentioned).toEqual([
      'implementer',
    ]);
  });
});

describe('routeHuman', () => {
  const definitions = [planner, implementer, reviewer];

  it('routes to every mentioned attached agent, one turn each', () => {
    const result = routeHuman({
      mentions: ['planner', 'implementer'],
      unknown: [],
      participants: participants(['planner', 'implementer'], 'planner'),
      definitions,
    });
    expect(result.targets).toEqual(['planner', 'implementer']);
    expect(result.notices).toEqual([]);
  });

  it('routes an unmentioned message to the default agent only', () => {
    const result = routeHuman({
      mentions: [],
      unknown: [],
      participants: participants(['planner', 'implementer'], 'planner'),
      definitions,
    });
    expect(result.targets).toEqual(['planner']);
  });

  it('adds every attached `all-human` agent to an unmentioned message', () => {
    const chime = def('chime', { respondsTo: 'all-human' });
    const result = routeHuman({
      mentions: [],
      unknown: [],
      participants: participants(['planner', 'implementer', 'chime'], 'planner'),
      definitions: [planner, implementer, chime],
    });
    // The default plus the opt-in fan-out agent — and nobody else.
    expect(result.targets).toEqual(['planner', 'chime']);
  });

  it('never routes to a `respondsTo: none` agent, even when mentioned', () => {
    const muted = def('muted', { respondsTo: 'none' });
    const result = routeHuman({
      mentions: ['muted'],
      unknown: [],
      participants: participants(['planner', 'muted'], 'planner'),
      definitions: [planner, muted],
    });
    // Nothing resolved, so the message falls back to the default agent.
    expect(result.targets).toEqual(['planner']);
  });

  it('notices an unknown id and still routes to the default', () => {
    const result = routeHuman({
      mentions: [],
      unknown: ['nobody'],
      participants: participants(['planner'], 'planner'),
      definitions,
    });
    expect(result.targets).toEqual(['planner']);
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toContain('@nobody');
  });

  it('treats a defined-but-unattached id as unknown', () => {
    // `reviewer` exists as a definition but is not in the participant set.
    const { mentioned, unknown } = parseMentions('@reviewer look', ['planner', 'implementer']);
    expect(mentioned).toEqual([]);
    expect(unknown).toEqual(['reviewer']);
    const result = routeHuman({
      mentions: mentioned,
      unknown,
      participants: participants(['planner', 'implementer'], 'planner'),
      definitions,
    });
    expect(result.targets).toEqual(['planner']);
    expect(result.notices[0]).toContain('@reviewer');
  });

  it('de-duplicates a target mentioned twice', () => {
    const result = routeHuman({
      mentions: ['planner', 'planner'],
      unknown: [],
      participants: participants(['planner'], 'planner'),
      definitions,
    });
    expect(result.targets).toEqual(['planner']);
  });

  it('routes nowhere when the participant set is empty', () => {
    const result = routeHuman({
      mentions: [],
      unknown: [],
      participants: participants([], null),
      definitions,
    });
    expect(result.targets).toEqual([]);
  });
});

describe('routeAgentReply', () => {
  const definitions = [planner, implementer, reviewer];
  const set = participants(['planner', 'implementer', 'reviewer'], 'planner');

  it('hops to an agent the reply mentions, at hop 1 from a human trigger', () => {
    const result = routeAgentReply({
      fromAgentId: 'planner',
      mentions: ['implementer'],
      unknown: [],
      hadToolActivity: true,
      trigger: human,
      participants: set,
      definitions,
    });
    expect(result.hops).toEqual([{ toAgentId: 'implementer', hop: 1 }]);
    expect(result.ended).toBeNull();
  });

  it('numbers a hop one past its handoff trigger', () => {
    const result = routeAgentReply({
      fromAgentId: 'implementer',
      mentions: ['reviewer'],
      unknown: [],
      hadToolActivity: true,
      trigger: handoffAt(2),
      participants: set,
      definitions,
    });
    expect(result.hops).toEqual([{ toAgentId: 'reviewer', hop: 3 }]);
  });

  it('drops a self-mention', () => {
    const result = routeAgentReply({
      fromAgentId: 'planner',
      mentions: ['planner'],
      unknown: [],
      hadToolActivity: true,
      trigger: human,
      participants: set,
      definitions,
    });
    expect(result.hops).toEqual([]);
    expect(result.ended).toBe('no-mention');
  });

  it('never hops to a `respondsTo: none` agent', () => {
    const muted = def('muted', { respondsTo: 'none' });
    const result = routeAgentReply({
      fromAgentId: 'planner',
      mentions: ['muted'],
      unknown: [],
      hadToolActivity: true,
      trigger: human,
      participants: participants(['planner', 'muted'], 'planner'),
      definitions: [planner, muted],
    });
    expect(result.hops).toEqual([]);
    expect(result.ended).toBe('no-mention');
  });

  it('ends a handoff chain on a bare acknowledgement of the delegator', () => {
    const result = routeAgentReply({
      fromAgentId: 'implementer',
      mentions: ['planner'],
      unknown: [],
      hadToolActivity: false,
      trigger: handoffAt(1, 'planner'),
      participants: set,
      definitions,
    });
    expect(result.hops).toEqual([]);
    expect(result.ended).toBe('bare-ack');
  });

  it('does not treat a human-triggered reply as a bare acknowledgement', () => {
    // Same text, same absence of tool activity — but nobody delegated to this
    // agent, so "ok @planner" is a genuine hand-off to the planner.
    const result = routeAgentReply({
      fromAgentId: 'implementer',
      mentions: ['planner'],
      unknown: [],
      hadToolActivity: false,
      trigger: human,
      participants: set,
      definitions,
    });
    expect(result.hops).toEqual([{ toAgentId: 'planner', hop: 1 }]);
    expect(result.ended).toBeNull();
  });

  it('keeps the chain alive when a tool-less reply mentions a third agent', () => {
    const result = routeAgentReply({
      fromAgentId: 'implementer',
      mentions: ['planner', 'reviewer'],
      unknown: [],
      hadToolActivity: false,
      trigger: handoffAt(1, 'planner'),
      participants: set,
      definitions,
    });
    // A tool-less reply has nothing new for its delegator, so the planner is
    // dropped; the third agent is new information and gets its hop.
    expect(result.hops).toEqual([{ toAgentId: 'reviewer', hop: 2 }]);
    expect(result.ended).toBeNull();
  });

  it('does not end a chain when the reply did work, even mentioning only the delegator', () => {
    const result = routeAgentReply({
      fromAgentId: 'implementer',
      mentions: ['planner'],
      unknown: [],
      hadToolActivity: true,
      trigger: handoffAt(1, 'planner'),
      participants: set,
      definitions,
    });
    expect(result.hops).toEqual([{ toAgentId: 'planner', hop: 2 }]);
  });

  it('exhausts a budget of 4 on the fifth hop and names the chain', () => {
    const alternate = (hop: number) =>
      routeAgentReply({
        fromAgentId: hop % 2 === 1 ? 'implementer' : 'planner',
        mentions: [hop % 2 === 1 ? 'planner' : 'implementer'],
        unknown: [],
        hadToolActivity: true,
        trigger: handoffAt(hop),
        participants: participants(['planner', 'implementer'], 'planner', 4),
        definitions,
      });
    // Hops 1..3 answered from a chain already at 1..3 produce 2..4.
    expect(alternate(1).hops).toEqual([{ toAgentId: 'planner', hop: 2 }]);
    expect(alternate(2).hops).toEqual([{ toAgentId: 'implementer', hop: 3 }]);
    expect(alternate(3).hops).toEqual([{ toAgentId: 'planner', hop: 4 }]);
    const exhausted = alternate(4);
    expect(exhausted.hops).toEqual([]);
    expect(exhausted.ended).toBe('budget');
    expect(exhausted.notices).toHaveLength(1);
    expect(exhausted.notices[0]).toContain('4');
    expect(exhausted.notices[0]).toContain('@planner');
  });

  it('defaults the budget to 4 when the participant set does not pin one', () => {
    expect(DEFAULT_HOP_BUDGET).toBe(4);
    const result = routeAgentReply({
      fromAgentId: 'implementer',
      mentions: ['planner'],
      unknown: [],
      hadToolActivity: true,
      trigger: handoffAt(DEFAULT_HOP_BUDGET),
      participants: set,
      definitions,
    });
    expect(result.ended).toBe('budget');
  });

  it('notices an unknown id in an agent reply', () => {
    const result = routeAgentReply({
      fromAgentId: 'planner',
      mentions: ['implementer'],
      unknown: ['nobody'],
      hadToolActivity: true,
      trigger: human,
      participants: set,
      definitions,
    });
    expect(result.hops).toEqual([{ toAgentId: 'implementer', hop: 1 }]);
    expect(result.notices[0]).toContain('@nobody');
  });
});
