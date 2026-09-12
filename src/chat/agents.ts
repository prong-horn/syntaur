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

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { syntaurRoot } from '../utils/paths.js';
import { isValidSlug } from '../utils/slug.js';
import { extractFrontmatter } from '../dashboard/parser.js';
import { HARNESSES, isHarnessId, resolveCommand } from './harnesses.js';
import type { CommandResolution } from './harnesses.js';
import type {
  AgentColor,
  AgentDefinition,
  AgentDefinitionInput,
  AgentPermissions,
  ChatAgentSummary,
  Harness,
  HarnessSpec,
  RespondsTo,
} from './types.js';
import { AGENT_PERMISSIONS } from './types.js';

const RESPONDS_TO: readonly RespondsTo[] = ['mentions', 'all-human', 'none'];

/** A ZWJ emoji sequence is three code points; a word is not an avatar. */
const MAX_AVATAR_CODEPOINTS = 4;

const BUILTIN_IDS = new Set(['claude', 'codex', 'cursor']);

export const AGENT_COLORS = ['violet', 'emerald', 'amber', 'sky', 'rose', 'slate'] as const;

const AGENT_COLOR_SET = new Set<string>(AGENT_COLORS);

const SLUG_ERROR =
  '`id` must be a lowercase slug such as `planner` (letters, digits, single hyphens)';

/** Reject ids that would escape `agentsDir` when interpolated into a filename. */
export function assertWritableAgentId(id: string): void {
  if (!isValidSlug(id) || id.length > 64) {
    throw new AgentWriteError(400, SLUG_ERROR);
  }
}

const COLOR_ERROR = '`color` must be one of violet, emerald, amber, sky, rose, slate';

/**
 * The shared base prompt. Short on purpose — the spike measured a fresh claude
 * session at ~37 k tokens of inherited environment before the first user word
 * (RESULTS.md), so Syntaur's own contribution stays lean (§5.10 "system-prompt
 * cost"). The three rules are the ones Buzz paid for: talk in chat, write records
 * through the CLI, never end a turn on a bare tool card.
 */
export const BASE_SYSTEM_PROMPT = [
  'You are working inside a Syntaur ticket chat. Your reply is the chat message the human reads — write it as prose, not as a status dump.',
  'Records are separate from chat: use the `syntaur` CLI (`syntaur progress log`, criteria writeback, transitions) when something belongs in the ticket files. Plain talk needs no CLI call.',
  'Never end a turn on a tool call with no summary — if you did work, say what you did and what it means.',
].join('\n');

export const BUILTIN_AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    id: 'claude',
    name: 'Claude',
    color: 'violet',
    harness: 'claude',
    respondsTo: 'mentions',
    permissions: 'ask',
    default: true,
    description: 'The general-purpose Claude Code agent.',
    systemPrompt: BASE_SYSTEM_PROMPT,
    promptIsDefault: true,
    source: null,
  },
  {
    id: 'codex',
    name: 'Codex',
    color: 'emerald',
    harness: 'codex',
    respondsTo: 'mentions',
    permissions: 'ask',
    default: false,
    description: 'The general-purpose codex agent.',
    systemPrompt: BASE_SYSTEM_PROMPT,
    promptIsDefault: true,
    source: null,
  },
  {
    id: 'cursor',
    name: 'Cursor',
    color: 'sky',
    harness: 'cursor',
    respondsTo: 'mentions',
    permissions: 'ask',
    default: false,
    description: 'The Cursor CLI agent.',
    systemPrompt: BASE_SYSTEM_PROMPT,
    promptIsDefault: true,
    source: null,
  },
];

export class AgentDefinitionError extends Error {
  readonly reason: string;

  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = 'AgentDefinitionError';
    this.reason = message;
  }
}

export class AgentWriteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AgentWriteError';
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
  if (!isValidSlug(id) || id.length > 64) {
    throw new AgentDefinitionError(file, SLUG_ERROR);
  }

  const harness = fm.harness;
  if (!isHarnessId(harness)) {
    throw new AgentDefinitionError(
      file,
      `\`harness\` must be one of claude, codex, cursor (got ${JSON.stringify(harness ?? null)})`,
    );
  }

  const colorRaw = str(fm.color) ?? 'slate';
  if (!AGENT_COLOR_SET.has(colorRaw)) {
    throw new AgentDefinitionError(file, COLOR_ERROR);
  }
  const color = colorRaw as AgentColor;

  // `mentions` is the default so `all-human` stays a deliberate opt-in
  // (Decision 2) — two agents that both answer every unmentioned message is
  // exactly the ping-pong the router exists to prevent.
  const respondsToRaw = fm.respondsTo === undefined || fm.respondsTo === null ? 'mentions' : fm.respondsTo;
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

  const permissionsRaw =
    fm.permissions === undefined || fm.permissions === null ? 'ask' : fm.permissions;
  if (
    typeof permissionsRaw !== 'string' ||
    !AGENT_PERMISSIONS.includes(permissionsRaw as AgentPermissions)
  ) {
    throw new AgentDefinitionError(
      file,
      `\`permissions\` must be one of ${AGENT_PERMISSIONS.join(', ')} (got ${JSON.stringify(permissionsRaw)})`,
    );
  }

  const mcpServers = fm.mcpServers === undefined || fm.mcpServers === null ? undefined : fm.mcpServers;
  if (mcpServers !== undefined && !isStringArray(mcpServers)) {
    throw new AgentDefinitionError(file, '`mcpServers` must be a list of strings');
  }

  const env = fm.env === undefined || fm.env === null ? undefined : fm.env;
  if (env !== undefined && !isStringMap(env)) {
    throw new AgentDefinitionError(file, '`env` must be a map of string values');
  }

  const description = str(fm.description);
  if (fm.description !== undefined && fm.description !== null && !description) {
    throw new AgentDefinitionError(file, '`description` must be a string');
  }

  const avatar = str(fm.avatar);
  if (fm.avatar !== undefined && fm.avatar !== null && !avatar) {
    throw new AgentDefinitionError(file, '`avatar` must be a string');
  }
  // Code points, not UTF-16 units, so a single emoji (up to a ZWJ sequence)
  // counts as one glyph and a word does not sneak through as an "avatar".
  if (avatar && [...avatar].length > MAX_AVATAR_CODEPOINTS) {
    throw new AgentDefinitionError(file, '`avatar` must be an emoji or one to two characters');
  }

  const trimmedBody = body.trim();
  const promptIsDefault = trimmedBody.length === 0;

  return {
    id,
    name: str(fm.name) ?? id,
    color,
    harness,
    model: str(fm.model),
    mode,
    permissions: permissionsRaw as AgentPermissions,
    effort: str(fm.effort),
    mcpServers: mcpServers as string[] | undefined,
    env: env as Record<string, string> | undefined,
    respondsTo: respondsToRaw as RespondsTo,
    default: fm.default === true,
    description,
    avatar,
    // A definition with no body still works — it just contributes no prompt of
    // its own, and the base prompt carries the chat rules.
    systemPrompt: promptIsDefault ? BASE_SYSTEM_PROMPT : trimmedBody,
    promptIsDefault: promptIsDefault || undefined,
    source: file,
  };
}

/** Serialize a writable definition to the on-disk `---` / body format. */
export function serializeAgentDefinition(input: AgentDefinitionInput): string {
  const fm: Record<string, unknown> = {
    id: input.id,
    name: input.name,
    color: input.color,
    harness: input.harness,
  };
  if (input.model) fm.model = input.model;
  if (input.mode) fm.mode = input.mode;
  if (input.permissions === 'auto') fm.permissions = 'auto';
  if (input.effort) fm.effort = input.effort;
  if (input.mcpServers && input.mcpServers.length > 0) fm.mcpServers = input.mcpServers;
  if (input.env && Object.keys(input.env).length > 0) fm.env = input.env;
  fm.respondsTo = input.respondsTo;
  fm.default = input.default;
  if (input.description) fm.description = input.description;
  if (input.avatar) fm.avatar = input.avatar;

  const yaml = yamlStringify(fm, { lineWidth: 0 }).trimEnd();
  const body = input.systemPrompt.trim();
  if (body.length === 0) {
    return `---\n${yaml}\n---\n`;
  }
  return `---\n${yaml}\n---\n${body}\n`;
}

/** One validator for reads and writes: serialize then parse. */
export function validateAgentInput(root: string, input: AgentDefinitionInput): AgentDefinition {
  assertWritableAgentId(input.id);
  const file = resolve(agentsDir(root), `${input.id}.md`);
  if (
    input.permissions !== undefined &&
    !AGENT_PERMISSIONS.includes(input.permissions as AgentPermissions)
  ) {
    throw new AgentDefinitionError(
      file,
      `\`permissions\` must be one of ${AGENT_PERMISSIONS.join(', ')} (got ${JSON.stringify(input.permissions)})`,
    );
  }
  return parseAgentDefinition(file, input.id, serializeAgentDefinition(input));
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

/**
 * Write one definition file with default normalization. Other file-backed
 * definitions marked default are cleared when this one claims default.
 */
export async function writeAgentDefinition(
  root: string,
  input: AgentDefinitionInput,
): Promise<AgentDefinition> {
  assertWritableAgentId(input.id);
  const { definitions: before } = await loadAgentDefinitions(root);
  if (input.default === false) {
    const current = resolveAgent(before, null);
    if (current?.id === input.id) {
      throw new AgentWriteError(
        400,
        `\`${input.id}\` is the default agent — make another agent the default first`,
      );
    }
  }

  const def = validateAgentInput(root, input);
  const dir = agentsDir(root);
  await mkdir(dir, { recursive: true });
  const path = resolve(dir, `${input.id}.md`);
  await writeDefinitionFile(path, serializeAgentDefinition(input));

  if (input.default === true) {
    await clearOtherDefaults(root, input.id);
  }

  const file = resolve(dir, `${input.id}.md`);
  const content = await readFile(file, 'utf-8');
  return parseAgentDefinition(file, input.id, content);
}

/**
 * Delete a definition file. Builtins without a file cannot be deleted; deleting
 * an override restores the builtin.
 */
export async function deleteAgentDefinition(
  root: string,
  id: string,
): Promise<{ restoredBuiltin: boolean }> {
  assertWritableAgentId(id);
  const path = resolve(agentsDir(root), `${id}.md`);
  let existed = false;
  try {
    await unlink(path);
    existed = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      if (BUILTIN_IDS.has(id)) {
        throw new AgentWriteError(
          409,
          `\`${id}\` is built in and has no file to delete — create one with the same id to override it`,
        );
      }
      throw new AgentWriteError(404, `No agent definition ${JSON.stringify(id)}`);
    }
    throw err;
  }

  return { restoredBuiltin: existed && BUILTIN_IDS.has(id) };
}

/**
 * The definition's avatar, or its name's first character. Two characters of
 * fallback would be ambiguous against a two-letter avatar, so it is one.
 */
export function agentAvatar(definition: AgentDefinition): string {
  if (definition.avatar) return definition.avatar;
  return ([...definition.name][0] ?? [...definition.id][0] ?? '?').toUpperCase();
}

/**
 * What the API reports per definition — everything the picker shows, including
 * the fields it shows READ-ONLY because they live in `~/.syntaur/agents/<id>.md`
 * rather than in `participants.json` (plan review round 1, finding 11).
 */
export function toAgentSummary(
  definition: AgentDefinition,
  resolver: (spec: HarnessSpec) => CommandResolution = resolveCommand,
): ChatAgentSummary {
  const spec = HARNESSES[definition.harness as Harness];
  const resolved = resolver(spec);
  return {
    id: definition.id,
    name: definition.name,
    color: definition.color,
    harness: definition.harness,
    model: definition.model ?? null,
    mode: definition.mode ?? null,
    effort: definition.effort ?? null,
    respondsTo: definition.respondsTo,
    description: definition.description ?? null,
    avatar: agentAvatar(definition),
    default: definition.default,
    source: definition.source,
    builtin: definition.source === null,
    overridesBuiltin: definition.source !== null && BUILTIN_IDS.has(definition.id),
    // The install hint when the adapter is not on PATH; null when it is.
    missing: resolved.path ? null : resolved.installHint,
  };
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

async function writeDefinitionFile(path: string, content: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, content, 'utf-8');
  await rename(temp, path);
}

async function clearOtherDefaults(root: string, exceptId: string): Promise<void> {
  const dir = agentsDir(root);
  let entries: string[];
  try {
    entries = (await readdir(dir)).filter((f) => f.endsWith('.md') && !f.startsWith('.') && !f.startsWith('_'));
  } catch {
    return;
  }

  for (const entry of entries.sort()) {
    const expectedId = entry.slice(0, -'.md'.length);
    if (expectedId === exceptId) continue;
    const file = resolve(dir, entry);
    try {
      const content = await readFile(file, 'utf-8');
      const def = parseAgentDefinition(file, expectedId, content);
      if (!def.default) continue;
      const input = definitionToInput(def);
      input.default = false;
      await writeDefinitionFile(file, serializeAgentDefinition(input));
    } catch {
      // Unparsable files are left alone — the loader already skips them.
    }
  }
}

function definitionToInput(def: AgentDefinition): AgentDefinitionInput {
  return {
    id: def.id,
    name: def.name,
    color: def.color,
    harness: def.harness,
    model: def.model,
    mode: def.mode,
    permissions: def.permissions,
    effort: def.effort,
    mcpServers: def.mcpServers,
    env: def.env,
    respondsTo: def.respondsTo,
    default: def.default,
    description: def.description,
    avatar: def.avatar,
    systemPrompt: def.promptIsDefault ? '' : def.systemPrompt,
  };
}

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
