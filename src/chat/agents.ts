/**
 * Agent definitions — `~/.syntaur/agents/<id>.md` (design §5.4).
 *
 * Frontmatter is the definition, the body is the system prompt. Two builtins
 * (`claude`, `codex`) exist so a fresh install has a working chat with no files;
 * a user file with the same id overrides the builtin wholesale (its own
 * frontmatter + body, not a merge of prompts).
 *
 * Validation is strict and per-file: a bad definition is reported and skipped, it
 * never takes the whole directory down.
 */

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as yamlParse } from 'yaml';
import { syntaurRoot } from '../utils/paths.js';
import { extractFrontmatter } from '../dashboard/parser.js';
import { isHarnessId } from './harnesses.js';
import type { AgentDefinition, RespondsTo } from './types.js';

const RESPONDS_TO: readonly RespondsTo[] = ['mentions', 'all-human', 'none'];
const ROLE_MODES = ['edits', 'ask', 'plan'];

/**
 * The shared base prompt. Short on purpose — the spike measured a fresh claude
 * session at ~37 k tokens of inherited environment before the first user word
 * (RESULTS.md), so Syntaur's own contribution stays lean (§5.10 "system-prompt
 * cost"). The three rules are the ones Buzz paid for: talk in chat, write records
 * through the CLI, never end a turn on a bare tool card.
 */
export const BASE_SYSTEM_PROMPT = [
  'You are working inside a Syntaur assignment chat. Your reply is the chat message the human reads — write it as prose, not as a status dump.',
  'Records are separate from chat: use the `syntaur` CLI (`syntaur progress log`, criteria writeback, transitions) when something belongs in the assignment files. Plain talk needs no CLI call.',
  'Never end a turn on a tool call with no summary — if you did work, say what you did and what it means.',
].join('\n');

export const BUILTIN_AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    id: 'claude',
    name: 'Claude',
    color: 'violet',
    harness: 'claude',
    respondsTo: 'all-human',
    default: true,
    systemPrompt: BASE_SYSTEM_PROMPT,
    source: null,
  },
  {
    id: 'codex',
    name: 'Codex',
    color: 'emerald',
    harness: 'codex',
    respondsTo: 'all-human',
    default: false,
    systemPrompt: BASE_SYSTEM_PROMPT,
    source: null,
  },
];

export class AgentDefinitionError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = 'AgentDefinitionError';
  }
}

export interface LoadAgentDefinitionsResult {
  definitions: AgentDefinition[];
  /** One message per file that failed validation; the file is skipped. */
  errors: string[];
}

/** `<root>/agents` — where definitions live. */
export function agentsDir(root = syntaurRoot()): string {
  return resolve(root, 'agents');
}

/**
 * Parse one `<id>.md` definition. `expectedId` is the filename stem: the
 * frontmatter `id` must match it so the file is the addressable identity.
 */
export function parseAgentDefinition(
  file: string,
  expectedId: string,
  content: string,
): AgentDefinition {
  const [frontmatter, body] = extractFrontmatter(content.replace(/\r\n/g, '\n'));
  if (!frontmatter.trim()) {
    throw new AgentDefinitionError(file, 'no frontmatter block');
  }

  let fm: Record<string, unknown>;
  try {
    const parsed = yamlParse(frontmatter) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('frontmatter is not a mapping');
    }
    fm = parsed as Record<string, unknown>;
  } catch (err) {
    throw new AgentDefinitionError(file, `invalid YAML frontmatter (${(err as Error).message})`);
  }

  const id = str(fm.id);
  if (!id) throw new AgentDefinitionError(file, 'missing `id`');
  if (id !== expectedId) {
    throw new AgentDefinitionError(file, `\`id\` is ${JSON.stringify(id)} but the file is ${expectedId}.md`);
  }

  const harness = fm.harness;
  if (!isHarnessId(harness)) {
    throw new AgentDefinitionError(
      file,
      `\`harness\` must be one of claude, codex (got ${JSON.stringify(harness ?? null)})`,
    );
  }

  const respondsToRaw = fm.respondsTo === undefined || fm.respondsTo === null ? 'all-human' : fm.respondsTo;
  if (typeof respondsToRaw !== 'string' || !RESPONDS_TO.includes(respondsToRaw as RespondsTo)) {
    throw new AgentDefinitionError(
      file,
      `\`respondsTo\` must be one of ${RESPONDS_TO.join(', ')} (got ${JSON.stringify(respondsToRaw)})`,
    );
  }

  const mode = str(fm.mode);
  if (fm.mode !== undefined && fm.mode !== null && !mode) {
    throw new AgentDefinitionError(file, '`mode` must be a string');
  }

  const mcpServers = fm.mcpServers === undefined || fm.mcpServers === null ? undefined : fm.mcpServers;
  if (mcpServers !== undefined && !isStringArray(mcpServers)) {
    throw new AgentDefinitionError(file, '`mcpServers` must be a list of strings');
  }

  const env = fm.env === undefined || fm.env === null ? undefined : fm.env;
  if (env !== undefined && !isStringMap(env)) {
    throw new AgentDefinitionError(file, '`env` must be a map of string values');
  }

  return {
    id,
    name: str(fm.name) ?? id,
    color: str(fm.color) ?? 'slate',
    harness,
    model: str(fm.model),
    mode,
    effort: str(fm.effort),
    mcpServers: mcpServers as string[] | undefined,
    env: env as Record<string, string> | undefined,
    respondsTo: respondsToRaw as RespondsTo,
    default: fm.default === true,
    // A definition with no body still works — it just contributes no prompt of
    // its own, and the base prompt carries the chat rules.
    systemPrompt: body.trim().length > 0 ? body.trim() : BASE_SYSTEM_PROMPT,
    source: file,
  };
}

/**
 * Load `<root>/agents/*.md`, validate each, and merge over the builtins by id.
 * A missing directory is not an error — the builtins are the answer.
 */
export async function loadAgentDefinitions(
  root = syntaurRoot(),
): Promise<LoadAgentDefinitionsResult> {
  const dir = agentsDir(root);
  const errors: string[] = [];
  const byId = new Map<string, AgentDefinition>();
  for (const builtin of BUILTIN_AGENT_DEFINITIONS) byId.set(builtin.id, { ...builtin });

  let entries: string[];
  try {
    entries = (await readdir(dir)).filter((f) => f.endsWith('.md') && !f.startsWith('.') && !f.startsWith('_'));
  } catch {
    return { definitions: order(byId), errors };
  }

  for (const entry of entries.sort()) {
    const file = resolve(dir, entry);
    const expectedId = entry.slice(0, -'.md'.length);
    try {
      const content = await readFile(file, 'utf-8');
      const def = parseAgentDefinition(file, expectedId, content);
      byId.set(def.id, def);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  // Exactly one default: an explicit `default: true` wins over the builtin's,
  // and the first one declared wins if a user marks several.
  const list = order(byId);
  const explicit = list.filter((d) => d.default && d.source !== null);
  if (explicit.length > 0) {
    for (const d of list) d.default = d === explicit[0];
  } else if (!list.some((d) => d.default)) {
    if (list[0]) list[0].default = true;
  }

  return { definitions: list, errors };
}

/** The requested id, else the default, else the first definition. */
export function resolveAgent(
  definitions: AgentDefinition[],
  requestedId?: string | null,
): AgentDefinition | null {
  if (requestedId) return definitions.find((d) => d.id === requestedId) ?? null;
  return definitions.find((d) => d.default) ?? definitions[0] ?? null;
}

// --- helpers ---------------------------------------------------------------

function order(byId: Map<string, AgentDefinition>): AgentDefinition[] {
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string');
}
