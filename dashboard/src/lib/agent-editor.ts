/**
 * Pure helpers for the Agents editor — draft ↔ API input, validation, and
 * harness-backed picker logic. No React; unit-tested under the node-env
 * dashboard vitest config.
 */

import { isValidSlug } from './slug';
import type {
  AgentColor,
  AgentDefinition,
  AgentDefinitionInput,
  ChatAgentSummary,
  ChatHarnessSummary,
  ChatSessionSummary,
  Harness,
  RespondsTo,
} from './chat-types';

export type AgentPermissions = 'ask' | 'auto';

const AGENT_PERMISSIONS: readonly AgentPermissions[] = ['ask', 'auto'];

export const AGENT_COLORS: readonly AgentColor[] = [
  'violet',
  'emerald',
  'amber',
  'sky',
  'rose',
  'slate',
];

const AGENT_COLOR_SET = new Set<string>(AGENT_COLORS);

const RESPONDS_TO: readonly RespondsTo[] = ['mentions', 'all-human', 'none'];

const HARNESS_IDS: readonly Harness[] = ['claude', 'codex', 'cursor'];

const MAX_AVATAR_CODEPOINTS = 4;

/** Mirrored from `src/chat/agents.ts` — shown as the system-prompt placeholder. */
export const BASE_SYSTEM_PROMPT = [
  'You are working inside a Syntaur assignment chat. Your reply is the chat message the human reads — write it as prose, not as a status dump.',
  'Records are separate from chat: use the `syntaur` CLI (`syntaur progress log`, criteria writeback, transitions) when something belongs in the assignment files. Plain talk needs no CLI call.',
  'Never end a turn on a tool call with no summary — if you did work, say what you did and what it means.',
].join('\n');

export const BUILTIN_DELETE_TITLE =
  'is built in and has no file to delete — create one with the same id to override it';

export interface AgentDraft {
  id: string;
  name: string;
  avatar: string;
  color: AgentColor;
  harness: Harness;
  model: string;
  modelCustom: boolean;
  effort: string;
  effortCustom: boolean;
  mode: string;
  modeCustom: boolean;
  permissions: AgentPermissions;
  respondsTo: RespondsTo;
  default: boolean;
  description: string;
  mcpServersText: string;
  envText: string;
  systemPrompt: string;
  promptIsDefault: boolean;
}

export function emptyDraft(harness: Harness = 'claude'): AgentDraft {
  return {
    id: '',
    name: '',
    avatar: '',
    color: 'slate',
    harness,
    model: '',
    modelCustom: false,
    effort: '',
    effortCustom: false,
    mode: '',
    modeCustom: false,
    permissions: 'ask',
    respondsTo: 'mentions',
    default: false,
    description: '',
    mcpServersText: '',
    envText: '',
    systemPrompt: '',
    promptIsDefault: true,
  };
}

export function draftFromDefinition(def: AgentDefinition): AgentDraft {
  const model = def.model ?? '';
  const effort = def.effort ?? '';
  const mode = def.mode ?? '';
  return {
    id: def.id,
    name: def.name,
    avatar: def.avatar ?? '',
    color: def.color,
    harness: def.harness,
    model,
    modelCustom: false,
    effort,
    effortCustom: false,
    mode,
    modeCustom: false,
    permissions: def.permissions ?? 'ask',
    respondsTo: def.respondsTo,
    default: def.default,
    description: def.description ?? '',
    mcpServersText: (def.mcpServers ?? []).join('\n'),
    envText: Object.entries(def.env ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
    systemPrompt: def.promptIsDefault ? '' : def.systemPrompt,
    promptIsDefault: def.promptIsDefault ?? false,
  };
}

function parseEnvLines(text: string): Record<string, string> | undefined {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  const env: Record<string, string> = {};
  for (const line of lines) {
    const eq = line.indexOf('=');
    if (eq <= 0) throw new Error(`Invalid env line ${JSON.stringify(line)} — use KEY=value`);
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    env[key] = value;
  }
  return env;
}

function parseLineList(text: string): string[] | undefined {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines : undefined;
}

export function inputFromDraft(draft: AgentDraft): AgentDefinitionInput {
  const env = draft.envText.trim() ? parseEnvLines(draft.envText) : undefined;
  const mcpServers = parseLineList(draft.mcpServersText);
  const model = draft.model.trim() || undefined;
  const effort = draft.effort.trim() || undefined;
  const mode = draft.mode.trim() || undefined;
  const avatar = draft.avatar.trim() || undefined;
  const description = draft.description.trim() || undefined;

  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    color: draft.color,
    harness: draft.harness,
    model,
    mode,
    ...(draft.permissions === 'auto' ? { permissions: 'auto' as const } : {}),
    effort,
    mcpServers,
    env,
    respondsTo: draft.respondsTo,
    default: draft.default,
    description,
    avatar,
    systemPrompt: draft.promptIsDefault ? '' : draft.systemPrompt,
  };
}

export function validateDraft(draft: AgentDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  const id = draft.id.trim();

  if (!id) {
    errors.id = 'Id is required';
  } else if (!isValidSlug(id)) {
    errors.id =
      'Id must be a lowercase slug such as planner (letters, digits, single hyphens)';
  } else if (id.length > 64) {
    errors.id = 'Id must be at most 64 characters';
  }

  if (!draft.name.trim()) {
    errors.name = 'Name is required';
  }

  const avatar = draft.avatar.trim();
  if (avatar) {
    if (/\s/.test(avatar)) {
      errors.avatar = 'Avatar must not contain whitespace';
    } else if ([...avatar].length > MAX_AVATAR_CODEPOINTS) {
      errors.avatar = `Avatar must be at most ${MAX_AVATAR_CODEPOINTS} characters`;
    }
  }

  if (!AGENT_COLOR_SET.has(draft.color)) {
    errors.color = 'Color must be one of violet, emerald, amber, sky, rose, slate';
  }

  if (!HARNESS_IDS.includes(draft.harness)) {
    errors.harness = 'Harness must be claude, codex, or cursor';
  }

  if (!RESPONDS_TO.includes(draft.respondsTo)) {
    errors.respondsTo = 'Responds to must be mentions, all-human, or none';
  }

  if (!AGENT_PERMISSIONS.includes(draft.permissions)) {
    errors.permissions = 'Permissions must be ask or auto';
  }

  const envLines = draft.envText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of envLines) {
    const eq = line.indexOf('=');
    if (eq <= 0) {
      errors.envText = `Invalid env line ${JSON.stringify(line)} — use KEY=value`;
      break;
    }
  }

  return errors;
}

export interface PickerChoiceResult {
  choices: Array<{ value: string; label: string }>;
  custom: boolean;
  hidden: boolean;
  reason: string | null;
}

function optionChoices(
  harness: ChatHarnessSummary | null,
  configId: string | null,
): Array<{ value: string; label: string }> {
  if (!harness?.options) return [];
  const option = harness.options.options.find((o) => o.id === configId);
  if (!option) return [];
  return option.choices.map((c) => ({
    value: c.value,
    label: c.name || c.value,
  }));
}

export function pickerChoices(
  kind: 'model' | 'effort',
  harness: ChatHarnessSummary | null,
  current: string | null,
): PickerChoiceResult {
  if (kind === 'effort' && harness && harness.effortConfigId === null) {
    return {
      choices: [],
      custom: false,
      hidden: true,
      reason: 'cursor folds effort into the model value',
    };
  }

  const configId =
    kind === 'model' ? harness?.modelConfigId ?? null : harness?.effortConfigId ?? null;
  const choices = optionChoices(harness, configId);
  const trimmed = current?.trim() ?? '';

  if (!harness) {
    return { choices, custom: Boolean(trimmed), hidden: false, reason: 'not fetched yet' };
  }

  if (!harness.installed) {
    return {
      choices,
      custom: Boolean(trimmed),
      hidden: false,
      reason: 'adapter not installed',
    };
  }

  if (!harness.options) {
    if (harness.auth.state === 'failed' && harness.auth.detail) {
      return {
        choices,
        custom: Boolean(trimmed),
        hidden: false,
        reason: harness.auth.detail,
      };
    }
    return { choices, custom: Boolean(trimmed), hidden: false, reason: 'not fetched yet' };
  }

  const custom = Boolean(trimmed) && !choices.some((c) => c.value === trimmed);
  return { choices, custom, hidden: false, reason: null };
}

export interface ModeChoice {
  value: string;
  label: string;
}

export function modeChoices(harness: ChatHarnessSummary | null): ModeChoice[] {
  const roles = harness?.roleModes;
  const base: ModeChoice[] = [
    { value: '', label: 'inherit' },
    {
      value: 'edits',
      label: roles ? `edits (${roles.edits})` : 'edits',
    },
    {
      value: 'ask',
      label: roles ? `ask (${roles.ask})` : 'ask',
    },
    {
      value: 'plan',
      label: roles ? `plan (${roles.plan})` : 'plan',
    },
    {
      value: 'bypass',
      label: roles ? `bypass (${roles.bypass})` : 'bypass',
    },
    { value: '__custom__', label: 'custom' },
  ];
  return base;
}

export function resolveModeValue(draft: AgentDraft): string {
  if (draft.modeCustom) return draft.mode.trim();
  return draft.mode.trim();
}

export function agentBadges(summary: ChatAgentSummary): string[] {
  const badges: string[] = [];
  if (summary.overridesBuiltin) badges.push('overrides built-in');
  else if (summary.builtin) badges.push('built in');
  else badges.push('file');
  if (summary.default) badges.push('default');
  badges.push(summary.harness);
  return badges;
}

export function staleNote(session: ChatSessionSummary): string | null {
  if (!session.staleDefinition) return null;
  const model = session.model ?? 'inherited model';
  const mode = session.mode ?? 'inherited mode';
  return `@${session.agentId}'s definition changed — this session keeps model ${model} and mode ${mode} until it is re-attached.`;
}

export function formatTestResult(result: {
  ok: boolean;
  reply: string | null;
  model: string | null;
  mode: string | null;
  effort: string | null;
  durationMs: number;
  error: string | null;
  profileErrors: string[];
}): string {
  if (result.error) return result.error;
  if (result.profileErrors.length > 0) return result.profileErrors.join('; ');
  if (result.ok) {
    const secs = (result.durationMs / 1000).toFixed(1);
    const parts = [`OK in ${secs} s`];
    if (result.model) parts.push(`model ${result.model}`);
    if (result.mode) parts.push(`mode ${result.mode}`);
    if (result.effort) parts.push(`effort ${result.effort}`);
    return parts.join(' · ');
  }
  return result.reply ?? 'Test failed';
}

export function applyHarnessToDraft(
  draft: AgentDraft,
  harness: ChatHarnessSummary | null,
): AgentDraft {
  if (!harness) return draft;
  let next = { ...draft };
  const modelPicker = pickerChoices('model', harness, next.model);
  if (!next.modelCustom && next.model && modelPicker.custom) {
    next = { ...next, modelCustom: true };
  }
  const effortPicker = pickerChoices('effort', harness, next.effort);
  if (!next.effortCustom && next.effort && effortPicker.custom) {
    next = { ...next, effortCustom: true };
  }
  const modes = modeChoices(harness).map((m) => m.value).filter((v) => v && v !== '__custom__');
  if (next.mode && !modes.includes(next.mode)) {
    next = { ...next, modeCustom: true };
  }
  return next;
}
