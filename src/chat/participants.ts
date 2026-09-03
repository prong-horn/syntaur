/**
 * The per-assignment participant set — `<assignmentDir>/chat/participants.json`
 * (Decision 1).
 *
 * It lives beside `events.jsonl` rather than in `assignment.md` frontmatter (the
 * nested-block writer handles flat scalar maps only) or in SQLite (not
 * human-editable, and the chat's other state is file-first). Syntaur owns the
 * file the same way it owns the log: hand-editable, but written atomically by
 * the route so a half-written file can never be read.
 *
 * Reads are forgiving — a missing or corrupt file derives the default (every
 * loaded definition attached, the definition-level default), and ids whose
 * definition has since been deleted from `~/.syntaur/agents` silently drop out.
 * Writes are strict, because a write is a deliberate act by the picker.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentDefinition, Participants } from './types.js';

/** Inclusive bounds on `hopBudget`; 4 is the router's default. */
export const MIN_HOP_BUDGET = 1;
export const MAX_HOP_BUDGET = 10;

/**
 * How many agents may be attached at once. Cost, not correctness: one
 * unmentioned message can fan out to every `all-human` agent, and each turn
 * re-sends that agent's whole standing context — ~37 k tokens on claude, ~23 k
 * on codex — before the first word (§5.9b). Eight is already a lot of money per
 * message; two or three is the useful shape.
 */
export const MAX_ATTACHED_AGENTS = 8;

/** A rejected write — the routes turn this into an HTTP 400. */
export class ParticipantsError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'ParticipantsError';
  }
}

export function participantsPath(assignmentDir: string): string {
  return resolve(assignmentDir, 'chat', 'participants.json');
}

/**
 * The assignment's participants, always filtered to definitions that exist. A
 * missing, unreadable or corrupt file derives the default rather than failing:
 * the chat must open even when the file is nonsense.
 */
export async function readParticipants(
  assignmentDir: string,
  definitions: readonly AgentDefinition[],
): Promise<Participants> {
  const stored = await readStored(assignmentDir);
  if (!stored) return derive(definitions);

  const known = new Set(definitions.map((d) => d.id));
  const agents = unique(stored.agents.filter((id) => known.has(id)));
  return {
    agents,
    defaultAgent: pickDefault(stored.defaultAgent, agents, definitions),
    ...(inBudgetRange(stored.hopBudget) ? { hopBudget: stored.hopBudget } : {}),
  };
}

/**
 * Validate and persist. The temp-file-plus-rename keeps a concurrent
 * `readParticipants` from seeing a half-written file — a truncated read would
 * silently detach every agent.
 */
export async function writeParticipants(
  assignmentDir: string,
  next: Participants,
  definitions: readonly AgentDefinition[],
): Promise<Participants> {
  const known = new Set(definitions.map((d) => d.id));
  if (!Array.isArray(next.agents)) throw new ParticipantsError('`agents` must be a list of agent ids');
  const agents = unique(next.agents);
  for (const id of agents) {
    if (typeof id !== 'string' || !known.has(id)) {
      throw new ParticipantsError(`No agent definition ${JSON.stringify(id)}`);
    }
  }

  if (agents.length > MAX_ATTACHED_AGENTS) {
    throw new ParticipantsError(
      `At most ${MAX_ATTACHED_AGENTS} agents can be attached to one assignment (got ${agents.length}); ` +
        'every attached agent costs a full standing context per turn it is given.',
    );
  }

  const defaultAgent = next.defaultAgent ?? null;
  if (defaultAgent !== null && !agents.includes(defaultAgent)) {
    throw new ParticipantsError(
      `The default agent ${JSON.stringify(defaultAgent)} is not attached to this assignment`,
    );
  }

  if (next.hopBudget !== undefined && !inBudgetRange(next.hopBudget)) {
    throw new ParticipantsError(
      `hopBudget must be a whole number between ${MIN_HOP_BUDGET} and ${MAX_HOP_BUDGET}`,
    );
  }

  const participants: Participants = {
    agents,
    defaultAgent,
    ...(next.hopBudget === undefined ? {} : { hopBudget: next.hopBudget }),
  };

  const path = participantsPath(assignmentDir);
  await mkdir(resolve(assignmentDir, 'chat'), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(participants, null, 2)}\n`, 'utf-8');
  await rename(temp, path);
  return participants;
}

// --- helpers ---------------------------------------------------------------

async function readStored(assignmentDir: string): Promise<Participants | null> {
  let raw: string;
  try {
    raw = await readFile(participantsPath(assignmentDir), 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Participants>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.agents)) return null;
    return {
      agents: parsed.agents.filter((id): id is string => typeof id === 'string'),
      defaultAgent: typeof parsed.defaultAgent === 'string' ? parsed.defaultAgent : null,
      ...(typeof parsed.hopBudget === 'number' ? { hopBudget: parsed.hopBudget } : {}),
    };
  } catch {
    return null;
  }
}

/** Every definition attached, with the definition-level default in the chair. */
function derive(definitions: readonly AgentDefinition[]): Participants {
  const agents = definitions.map((d) => d.id);
  return {
    agents,
    defaultAgent: definitions.find((d) => d.default)?.id ?? agents[0] ?? null,
  };
}

/**
 * The persisted default when it is still attached; otherwise the definition-level
 * default if that one is, otherwise the first attached agent. A chat with agents
 * but no default would route an unmentioned message nowhere.
 */
function pickDefault(
  stored: string | null,
  agents: string[],
  definitions: readonly AgentDefinition[],
): string | null {
  if (stored && agents.includes(stored)) return stored;
  const declared = definitions.find((d) => d.default)?.id;
  if (declared && agents.includes(declared)) return declared;
  return agents[0] ?? null;
}

function inBudgetRange(value: number | undefined): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_HOP_BUDGET &&
    value <= MAX_HOP_BUDGET
  );
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}
