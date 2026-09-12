import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_ATTACHED_AGENTS,
  ParticipantsError,
  participantsPath,
  readParticipants,
  writeParticipants,
} from '../chat/participants.js';
import { BASE_SYSTEM_PROMPT } from '../chat/agents.js';
import type { AgentDefinition } from '../chat/types.js';

/**
 * Task 1 — `<ticketDir>/chat/participants.json` (Decision 1): the persisted
 * set of attached agents, the default, and the hop budget. Read with a derived
 * default and always filtered to definitions that still exist.
 */

let ticketDir: string;

function def(id: string, overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    color: 'slate',
    harness: 'claude',
    respondsTo: 'mentions',
    default: false,
    systemPrompt: BASE_SYSTEM_PROMPT,
    source: null,
    ...overrides,
  };
}

const definitions = [def('claude', { default: true }), def('codex'), def('planner')];

beforeEach(async () => {
  ticketDir = await mkdtemp(join(tmpdir(), 'syntaur-participants-'));
});

afterEach(async () => {
  await rm(ticketDir, { recursive: true, force: true });
});

describe('readParticipants', () => {
  it('derives every definition attached with the definition-level default', async () => {
    const participants = await readParticipants(ticketDir, definitions);
    expect(participants.agents).toEqual(['claude', 'codex', 'planner']);
    expect(participants.defaultAgent).toBe('claude');
    expect(participants.hopBudget).toBeUndefined();
  });

  it('reads a persisted set back verbatim', async () => {
    await writeParticipants(ticketDir, { agents: ['planner'], defaultAgent: 'planner', hopBudget: 2 }, definitions);
    const participants = await readParticipants(ticketDir, definitions);
    expect(participants).toEqual({ agents: ['planner'], defaultAgent: 'planner', hopBudget: 2 });
  });

  it('drops an id whose definition has since been deleted', async () => {
    await mkdir(join(ticketDir, 'chat'), { recursive: true });
    await writeFile(
      participantsPath(ticketDir),
      JSON.stringify({ agents: ['planner', 'ghost'], defaultAgent: 'planner' }),
      'utf-8',
    );
    const participants = await readParticipants(ticketDir, definitions);
    expect(participants.agents).toEqual(['planner']);
  });

  it('re-points a default whose definition has since been deleted', async () => {
    await mkdir(join(ticketDir, 'chat'), { recursive: true });
    await writeFile(
      participantsPath(ticketDir),
      JSON.stringify({ agents: ['planner'], defaultAgent: 'ghost' }),
      'utf-8',
    );
    const participants = await readParticipants(ticketDir, definitions);
    // `claude` is the definition-level default but is not attached, so the sole
    // attached agent takes the job rather than the chat having no default.
    expect(participants.defaultAgent).toBe('planner');
  });

  it('falls back to the derived default when the file is corrupt', async () => {
    await mkdir(join(ticketDir, 'chat'), { recursive: true });
    await writeFile(participantsPath(ticketDir), '{ not json', 'utf-8');
    const participants = await readParticipants(ticketDir, definitions);
    expect(participants.agents).toEqual(['claude', 'codex', 'planner']);
  });

  it('ignores a persisted hop budget outside 1–10', async () => {
    await mkdir(join(ticketDir, 'chat'), { recursive: true });
    await writeFile(
      participantsPath(ticketDir),
      JSON.stringify({ agents: ['planner'], defaultAgent: 'planner', hopBudget: 99 }),
      'utf-8',
    );
    expect((await readParticipants(ticketDir, definitions)).hopBudget).toBeUndefined();
  });
});

describe('writeParticipants', () => {
  it('writes atomically and leaves no temp file behind', async () => {
    await writeParticipants(ticketDir, { agents: ['claude'], defaultAgent: 'claude' }, definitions);
    const entries = await readdir(join(ticketDir, 'chat'));
    expect(entries).toEqual(['participants.json']);
    const raw = JSON.parse(await readFile(participantsPath(ticketDir), 'utf-8'));
    expect(raw).toEqual({ agents: ['claude'], defaultAgent: 'claude' });
  });

  it('refuses an id that has no definition', async () => {
    await expect(
      writeParticipants(ticketDir, { agents: ['ghost'], defaultAgent: null }, definitions),
    ).rejects.toBeInstanceOf(ParticipantsError);
  });

  it('refuses a default that is not attached', async () => {
    await expect(
      writeParticipants(ticketDir, { agents: ['claude'], defaultAgent: 'codex' }, definitions),
    ).rejects.toThrow(/default/i);
  });

  it('refuses a hop budget outside 1–10', async () => {
    await expect(
      writeParticipants(ticketDir, { agents: ['claude'], defaultAgent: 'claude', hopBudget: 0 }, definitions),
    ).rejects.toThrow(/hopBudget/);
    await expect(
      writeParticipants(ticketDir, { agents: ['claude'], defaultAgent: 'claude', hopBudget: 11 }, definitions),
    ).rejects.toThrow(/hopBudget/);
  });

  it('de-duplicates the attached ids', async () => {
    const written = await writeParticipants(
      ticketDir,
      { agents: ['claude', 'claude', 'codex'], defaultAgent: 'claude' },
      definitions,
    );
    expect(written.agents).toEqual(['claude', 'codex']);
  });

  it('refuses more than the attached-agent cap', async () => {
    const many = Array.from({ length: MAX_ATTACHED_AGENTS + 1 }, (_, i) => def(`a${i}`));
    await expect(
      writeParticipants(
        ticketDir,
        { agents: many.map((d) => d.id), defaultAgent: 'a0' },
        many,
      ),
    ).rejects.toThrow(new RegExp(String(MAX_ATTACHED_AGENTS)));
  });

  it('accepts exactly the cap', async () => {
    const many = Array.from({ length: MAX_ATTACHED_AGENTS }, (_, i) => def(`a${i}`));
    const written = await writeParticipants(
      ticketDir,
      { agents: many.map((d) => d.id), defaultAgent: 'a0' },
      many,
    );
    expect(written.agents).toHaveLength(MAX_ATTACHED_AGENTS);
  });

  it('accepts an empty set with no default', async () => {
    const written = await writeParticipants(ticketDir, { agents: [], defaultAgent: null }, definitions);
    expect(written).toEqual({ agents: [], defaultAgent: null });
    expect((await readParticipants(ticketDir, definitions)).agents).toEqual([]);
  });
});
