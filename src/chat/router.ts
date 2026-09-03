/**
 * The router — the one place that decides who a chat message is for (§5.6,
 * Decision 2).
 *
 * Pure and I/O-free, so every rule in acceptance criteria 1 and 2 is a unit
 * test rather than a broker integration. The broker supplies the parsed
 * mentions, the participant set and the definitions; the router answers with
 * targets, hops and the notices that become `system` rows.
 *
 * The rules, in one place:
 *
 *  - **Human message.** Every mentioned attached agent gets one turn. With no
 *    resolvable mention the message goes to the assignment's default agent plus
 *    every attached `respondsTo: 'all-human'` agent — `all-human` is opt-in
 *    fan-out, not the builtin behaviour (Decision 2). A `respondsTo: 'none'`
 *    agent is never a target, mentioned or not.
 *  - **Agent reply.** A sealed reply that mentions another attached agent hops
 *    to it, one hop past the trigger's (a human trigger is hop 0). Self-mentions
 *    are dropped, `none` agents are never targeted, and a chain is capped by the
 *    hop budget — exhaustion posts a notice instead of a turn.
 *  - **The bare-acknowledgement filter** applies only to a reply that was itself
 *    triggered by a handoff: no tool activity and no mention beyond the
 *    delegator ends the chain. A human-triggered reply can never be a bare ack,
 *    because nobody delegated to it — "ok @planner" there is a real hand-off.
 *
 * The prompt-level rules Buzz relies on ("never publish a bare acknowledgement")
 * stay in `BASE_SYSTEM_PROMPT` as belt and braces; these are the braces.
 */

import type { AgentDefinition, Participants, TurnTrigger } from './types.js';

/** Agent-to-agent hops allowed per chain when `participants.json` pins none. */
export const DEFAULT_HOP_BUDGET = 4;

/**
 * The launch-prompt token grammar, verbatim from
 * `dashboard/src/lib/launch-prompt-autocomplete.ts` and
 * `src/launch/launch-prompt.ts`: `@` at start-of-string or after whitespace,
 * then a maximal `[A-Za-z0-9_-]` run. The composer's autocomplete offers agent
 * ids under the same grammar, so what the user sees is what the router reads.
 */
const TOKEN_RE = /(^|\s)@([A-Za-z0-9_-]+)/g;

export interface ParsedMentions {
  /** Attached ids named by a token, canonical casing, first-appearance order. */
  mentioned: string[];
  /** Tokens that named no attached agent, as typed, de-duplicated. */
  unknown: string[];
}

/**
 * Split a message's `@tokens` into the attached agents they name and the ones
 * they do not. Matching is case-insensitive but the canonical id is reported, so
 * everything downstream compares ids exactly.
 */
export function parseMentions(text: string, attachedIds: readonly string[]): ParsedMentions {
  const byLower = new Map(attachedIds.map((id) => [id.toLowerCase(), id]));
  const mentioned: string[] = [];
  const unknown: string[] = [];
  const seenKnown = new Set<string>();
  const seenUnknown = new Set<string>();

  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(text)) !== null) {
    const token = match[2];
    const id = byLower.get(token.toLowerCase());
    if (id) {
      if (!seenKnown.has(id)) {
        seenKnown.add(id);
        mentioned.push(id);
      }
    } else if (!seenUnknown.has(token.toLowerCase())) {
      seenUnknown.add(token.toLowerCase());
      unknown.push(token);
    }
  }
  return { mentioned, unknown };
}

export interface RouteHumanInput {
  /** Attached ids the message mentioned (the composer's explicit pick counts). */
  mentions: readonly string[];
  /** Tokens that named nobody — one notice each. */
  unknown: readonly string[];
  participants: Participants;
  definitions: readonly AgentDefinition[];
}

export interface RouteHumanResult {
  /** One turn per id, in order. */
  targets: string[];
  /** Lines that become `system` rows in the assignment scope. */
  notices: string[];
}

/** Who a human message is for. */
export function routeHuman(input: RouteHumanInput): RouteHumanResult {
  const attached = attachedSet(input.participants, input.definitions);
  const notices = input.unknown.map(unknownNotice);

  const mentioned = dedupe(input.mentions).filter((id) => canBeTriggered(id, attached));
  if (mentioned.length > 0) return { targets: mentioned, notices };

  // Nothing resolved — the default agent answers, joined by anyone who opted
  // into every human message.
  const fallback: string[] = [];
  const defaultAgent = input.participants.defaultAgent;
  if (defaultAgent && canBeTriggered(defaultAgent, attached)) fallback.push(defaultAgent);
  for (const [id, definition] of attached) {
    if (definition.respondsTo === 'all-human' && !fallback.includes(id)) fallback.push(id);
  }
  return { targets: fallback, notices };
}

export interface RouteAgentReplyInput {
  /** The agent whose sealed reply this is. */
  fromAgentId: string;
  /** Attached ids the reply mentioned. */
  mentions: readonly string[];
  unknown: readonly string[];
  /** Did the turn produce any tool activity? Half of the bare-ack rule. */
  hadToolActivity: boolean;
  /** What the replying turn was answering. */
  trigger: TurnTrigger;
  participants: Participants;
  definitions: readonly AgentDefinition[];
}

/** Why a chain stopped here, for the record and the UI. */
export type ChainEnd = 'no-mention' | 'bare-ack' | 'budget';

export interface RouteAgentReplyResult {
  hops: Array<{ toAgentId: string; hop: number }>;
  notices: string[];
  ended: ChainEnd | null;
}

/** What an agent's sealed reply hands off to, if anything. */
export function routeAgentReply(input: RouteAgentReplyInput): RouteAgentReplyResult {
  const attached = attachedSet(input.participants, input.definitions);
  const notices = input.unknown.map(unknownNotice);
  const budget = input.participants.hopBudget ?? DEFAULT_HOP_BUDGET;

  const mentioned = dedupe(input.mentions).filter(
    (id) => id !== input.fromAgentId && canBeTriggered(id, attached),
  );

  // The bare-acknowledgement filter, gated on a handoff trigger: a reply nobody
  // delegated to cannot be acknowledging anyone (criterion 2, plan review
  // round 1 finding 10). A triggered reply that did no work has nothing new to
  // tell its delegator, so the delegator is dropped — and if that empties the
  // list, the chain ends here. A third agent named in the same breath still
  // gets its hop: that is new information, not ping-pong.
  let targets = mentioned;
  if (input.trigger.kind === 'handoff' && !input.hadToolActivity) {
    const delegator = input.trigger.fromAgentId;
    targets = mentioned.filter((id) => id !== delegator);
    if (targets.length === 0) return { hops: [], notices, ended: 'bare-ack' };
  }

  if (targets.length === 0) return { hops: [], notices, ended: 'no-mention' };

  const hop = (input.trigger.kind === 'handoff' ? input.trigger.hop : 0) + 1;
  if (hop > budget) {
    notices.push(
      `The hand-off chain reached its budget of ${budget} hops, so @${input.fromAgentId} → ` +
        `${targets.map((id) => `@${id}`).join(', ')} was not started. Send a message to continue it.`,
    );
    return { hops: [], notices, ended: 'budget' };
  }

  return { hops: targets.map((toAgentId) => ({ toAgentId, hop })), notices, ended: null };
}

// --- helpers ---------------------------------------------------------------

/** Attached ids that still have a definition, in participant order. */
function attachedSet(
  participants: Participants,
  definitions: readonly AgentDefinition[],
): Map<string, AgentDefinition> {
  const byId = new Map(definitions.map((d) => [d.id, d]));
  const attached = new Map<string, AgentDefinition>();
  for (const id of participants.agents) {
    const definition = byId.get(id);
    if (definition) attached.set(id, definition);
  }
  return attached;
}

/** `respondsTo: 'none'` is never triggered from chat, however it is named. */
function canBeTriggered(id: string, attached: Map<string, AgentDefinition>): boolean {
  const definition = attached.get(id);
  return definition !== undefined && definition.respondsTo !== 'none';
}

function unknownNotice(token: string): string {
  return `No agent @${token} is attached to this assignment, so nothing was routed to it.`;
}

function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}
