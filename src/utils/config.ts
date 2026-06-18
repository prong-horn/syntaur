import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, isAbsolute } from 'node:path';
import { syntaurRoot, defaultProjectDir, expandHome } from './paths.js';
import { fileExists, writeFileForce } from './fs.js';
import { renderConfig } from '../templates/config.js';
import { migrateLegacyConfig } from './fs-migration.js';
import { DEFAULT_STATUSES, DEFAULT_TRANSITION_TABLE } from '../lifecycle/index.js';
import {
  BINDABLE_ACTION_KINDS,
  canonicalizeCombo,
  isBindableActionKind,
  isReservedCombo,
  type BindableActionKind,
} from './hotkeysCatalog.js';
import {
  AGENT_ID_PATTERN,
  BUILTIN_AGENTS,
  PROMPT_ARG_POSITIONS,
  type AgentConfig,
  type PromptArgPosition,
  type SessionInvocation,
} from './agents-schema.js';
import { isValidSlug } from './slug.js';
import {
  type FactDeclaration,
  type RawFactDeclaration,
} from './fact-registry.js';

export {
  AGENT_ID_PATTERN,
  BUILTIN_AGENTS,
  PROMPT_ARG_POSITIONS,
  type AgentConfig,
  type PromptArgPosition,
  type SessionInvocation,
};

export interface StatusDefinition {
  id: string;
  label: string;
  description?: string;
  color?: string;
  icon?: string;
  terminal?: boolean;
}

export interface StatusTransition {
  from: string;
  command: string;
  to: string;
  label?: string;
  description?: string;
  requiresReason?: boolean;
}

/**
 * Derive-status primitives ({@link PhaseRung}, {@link DispositionRule},
 * {@link HeadlineProjection}, {@link DeriveConfig}, {@link DEFAULT_DERIVE_CONFIG},
 * {@link validateDeriveConfig}) live in the browser-safe `derive-config.ts` so
 * the dashboard client can alias and reuse them; imported for local use here and
 * re-exported so existing Node-side imports from `config.js` keep resolving.
 */
import {
  DEFAULT_DERIVE_CONFIG,
  validateDeriveConfig,
  validateDeriveShape,
  type PhaseRung,
  type DispositionRule,
  type HeadlineProjection,
  type DeriveConfig,
} from './derive-config.js';

export { DEFAULT_DERIVE_CONFIG, validateDeriveConfig, validateDeriveShape };
export type { PhaseRung, DispositionRule, HeadlineProjection, DeriveConfig };

import type { StaleThresholds } from '../staleness/classify.js';

/** Config keys for the `staleness:` block → `StaleThresholds` ms fields. Keyed
 * on the contradiction (phase/disposition), not raw status ids. */
const STALENESS_KEY_TO_FIELD: Record<string, keyof StaleThresholds> = {
  inProgressNoActivity: 'inProgressNoActivityMs',
  readyUnclaimed: 'readyUnclaimedMs',
  reviewAging: 'reviewAgingMs',
  blockedAging: 'blockedAgingMs',
  planApprovalAging: 'planApprovalAgingMs',
};

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/;
const DURATION_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parse a duration like `7d`/`12h`/`30m`/`90s`/`500ms` (or a bare number = ms)
 * to milliseconds. Returns null when malformed or non-positive. */
export function parseDurationMs(raw: string): number | null {
  const m = raw.trim().match(DURATION_RE);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n * DURATION_UNIT_MS[m[2] ?? 'ms'];
}

/**
 * A custom-fact declaration EXACTLY as parsed from `statuses.facts` — loose
 * parse (Locked Decisions): every field is a raw string so user input
 * round-trips through serialization even when invalid. The strict
 * {@link FactDeclaration} is derived from this via {@link normalizeFactDeclarations}.
 *
 * Defined in `fact-registry.ts` (browser-safe); re-exported here so existing
 * Node-side imports from `config.js` keep resolving.
 */
export type { RawFactDeclaration } from './fact-registry.js';

/**
 * A VALIDATED custom-fact declaration (strict union). bool/number facts are
 * asserted values stored in the `facts:` frontmatter map; attestation facts
 * model "agent reviewed revision with verdict" and carry a revision binding.
 *
 * Defined in `fact-registry.ts` (browser-safe); re-exported here so existing
 * Node-side imports from `config.js` keep resolving.
 */
export type { FactDeclaration } from './fact-registry.js';
export { validateFactDeclarations, normalizeFactDeclarations } from './fact-registry.js';

export interface StatusConfig {
  statuses: StatusDefinition[];
  order: string[];
  transitions: StatusTransition[];
  /** Derived-status rules (v3). Null/absent → DEFAULT_DERIVE_CONFIG at resolve
   * time. Persisted under `statuses:` so the Settings writer round-trips it. */
  derive?: DeriveConfig | null;
  /** Custom-fact declarations (raw — see {@link RawFactDeclaration}). Persisted
   * under `statuses.facts`; preserved verbatim so invalid rows round-trip and
   * doctor can diagnose them. Null/absent → no custom vocabulary. */
  facts?: RawFactDeclaration[] | null;
}

export interface TypeDefinition {
  id: string;
  label?: string;
  description?: string;
  color?: string;
  icon?: string;
}

export interface TypesConfig {
  definitions: TypeDefinition[];
  default: string;
}

export const DEFAULT_ASSIGNMENT_TYPES: TypesConfig = {
  definitions: [
    { id: 'feature', label: 'Feature' },
    { id: 'bug', label: 'Bug' },
    { id: 'refactor', label: 'Refactor' },
    { id: 'research', label: 'Research' },
    { id: 'chore', label: 'Chore' },
  ],
  default: 'feature',
};

export interface IntegrationConfig {
  claudePluginDir: string | null;
  codexPluginDir: string | null;
  codexMarketplacePath: string | null;
  // Per-agent cross-agent install records (pi, hermes, openclaw, ...). Optional
  // so existing `IntegrationConfig` literals (and the default config) need no
  // change. Serialized as flat `installedAgents.<id>: <scope>` keys inside the
  // `integrations:` block (the frontmatter parser only flattens two levels).
  installedAgents?: Record<string, { scope: 'project' | 'global' }>;
}

export interface OnboardingConfig {
  completed: boolean;
}

export interface BackupConfig {
  repo: string | null;
  categories: string;
  lastBackup: string | null;
  lastRestore: string | null;
}

export type AutoCreateWorktree = 'skip' | 'ask' | 'always';

export interface PlaybooksConfig {
  disabled: string[];
}

export interface ThemeConfig {
  preset: string;
}

export interface HotkeyBindingsConfig {
  bindings: Partial<Record<BindableActionKind, string>>;
}

import { TERMINAL_CHOICES, type TerminalChoice } from './terminal-schema.js';
import {
  DEFAULT_SEARCH_CONFIG,
  normalizeSearchConfig,
  type SearchConfig,
} from './search-schema.js';
export { TERMINAL_CHOICES, type TerminalChoice };

import {
  normalizeHiddenList,
  type WorkspaceVisibilityConfig,
} from './workspace-visibility-schema.js';
export { type WorkspaceVisibilityConfig };

/**
 * Automatic session tracking scope:
 * - `all`: every discovered/hooked session is written to the sessions DB.
 * - `workspaces-only`: only sessions whose cwd has `.syntaur/context.json`.
 * - `off`: no automatic DB writes (manual `track-session` still works).
 */
export type SessionAutoTrack = 'all' | 'workspaces-only' | 'off';

export interface SyntaurConfig {
  version: string;
  defaultProjectDir: string;
  onboarding: OnboardingConfig;
  agentDefaults: {
    trustLevel: 'low' | 'medium' | 'high';
    autoApprove: boolean;
    autoCreateWorktree: AutoCreateWorktree;
  };
  session: {
    autoTrack: SessionAutoTrack;
  };
  integrations: IntegrationConfig;
  backup: BackupConfig | null;
  statuses: StatusConfig | null;
  types: TypesConfig | null;
  agents: AgentConfig[] | null;
  playbooks: PlaybooksConfig;
  theme: ThemeConfig | null;
  hotkeys: HotkeyBindingsConfig | null;
  terminal: TerminalChoice | null;
  searchConfig: SearchConfig | null;
  workspaceVisibility: WorkspaceVisibilityConfig;
  /** Optional per-reason staleness age-gate overrides (defaults-first; null = all defaults). */
  staleness: Partial<StaleThresholds> | null;
}

const DEFAULT_CONFIG: SyntaurConfig = {
  version: '2.0',
  defaultProjectDir: defaultProjectDir(),
  onboarding: {
    completed: false,
  },
  agentDefaults: {
    trustLevel: 'medium',
    autoApprove: false,
    autoCreateWorktree: 'ask',
  },
  session: {
    autoTrack: 'all',
  },
  integrations: {
    claudePluginDir: null,
    codexPluginDir: null,
    codexMarketplacePath: null,
  },
  backup: null,
  statuses: null,
  types: null,
  agents: null,
  playbooks: {
    disabled: [],
  },
  theme: null,
  hotkeys: null,
  terminal: null,
  searchConfig: null,
  workspaceVisibility: {
    hidden: [],
  },
  staleness: null,
};

const AUTO_CREATE_WORKTREE_VALUES: readonly AutoCreateWorktree[] = ['skip', 'ask', 'always'];

const SESSION_AUTO_TRACK_VALUES: readonly SessionAutoTrack[] = ['all', 'workspaces-only', 'off'];

export class AgentConfigError extends Error {}

/**
 * Validate an agent command string.
 * - Absolute paths (after ~ expansion) are accepted verbatim.
 * - Bare names (no "/" after expansion) are accepted for PATH lookup at launch time.
 * - Relative paths (contain "/" but not absolute) are rejected.
 */
export function parseAgentCommand(value: string, agentId?: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AgentConfigError(
      `agent${agentId ? ` "${agentId}"` : ''} has empty command`,
    );
  }
  const expanded = expandHome(value.trim());
  if (isAbsolute(expanded)) {
    return resolve(expanded);
  }
  if (expanded.includes('/')) {
    throw new AgentConfigError(
      `agent${agentId ? ` "${agentId}"` : ''} command "${value}" is a relative path — use an absolute path or a bare binary name`,
    );
  }
  return expanded;
}

export function validateAgentList(agents: AgentConfig[]): void {
  const seen = new Set<string>();
  let defaults = 0;
  for (const agent of agents) {
    if (!AGENT_ID_PATTERN.test(agent.id)) {
      throw new AgentConfigError(
        `agent id "${agent.id}" is invalid — must match /^[a-z0-9][a-z0-9_-]*$/`,
      );
    }
    if (seen.has(agent.id)) {
      throw new AgentConfigError(`duplicate agent id "${agent.id}"`);
    }
    seen.add(agent.id);
    if (!agent.label || agent.label.trim() === '') {
      throw new AgentConfigError(`agent "${agent.id}" has empty label`);
    }
    parseAgentCommand(agent.command, agent.id);
    if (
      agent.promptArgPosition !== undefined &&
      !PROMPT_ARG_POSITIONS.includes(agent.promptArgPosition)
    ) {
      throw new AgentConfigError(
        `agent "${agent.id}" has invalid promptArgPosition "${agent.promptArgPosition}" — expected first|last|none`,
      );
    }
    if (agent.model !== undefined && /[\r\n]/.test(agent.model)) {
      throw new AgentConfigError(
        `agent "${agent.id}" has invalid model — must be a single line (no newlines)`,
      );
    }
    if (
      agent.playbook !== undefined &&
      agent.playbook.trim() !== '' &&
      !isValidSlug(agent.playbook)
    ) {
      throw new AgentConfigError(
        `agent "${agent.id}" has invalid playbook "${agent.playbook}" — must be a valid playbook slug`,
      );
    }
    if (agent.launchPrompt !== undefined && /[\r\n]/.test(agent.launchPrompt)) {
      throw new AgentConfigError(
        `agent "${agent.id}" has invalid launchPrompt — must be a single line (no newlines)`,
      );
    }
    validateSessionInvocation(agent, 'resume', agent.resume);
    validateSessionInvocation(agent, 'fork', agent.fork);
    if (agent.default) defaults++;
  }
  if (defaults > 1) {
    throw new AgentConfigError(
      `more than one agent is marked default: true (only one is allowed)`,
    );
  }
}

function validateSessionInvocation(
  agent: AgentConfig,
  mode: 'resume' | 'fork',
  invocation: SessionInvocation | undefined,
): void {
  if (invocation === undefined) return;
  if (!Array.isArray(invocation.args)) {
    throw new AgentConfigError(
      `agent "${agent.id}" ${mode}.args must be an array of strings`,
    );
  }
  for (const a of invocation.args) {
    if (typeof a !== 'string') {
      throw new AgentConfigError(
        `agent "${agent.id}" ${mode}.args must contain only strings`,
      );
    }
  }
  if (
    invocation.command !== undefined &&
    (typeof invocation.command !== 'string' || invocation.command.trim() === '')
  ) {
    throw new AgentConfigError(
      `agent "${agent.id}" ${mode}.command must be a non-empty string when present`,
    );
  }
}

function cloneDefaultConfig(): SyntaurConfig {
  return {
    ...DEFAULT_CONFIG,
    onboarding: { ...DEFAULT_CONFIG.onboarding },
    agentDefaults: { ...DEFAULT_CONFIG.agentDefaults },
    session: { ...DEFAULT_CONFIG.session },
    integrations: { ...DEFAULT_CONFIG.integrations },
    backup: DEFAULT_CONFIG.backup ? { ...DEFAULT_CONFIG.backup } : null,
    statuses: DEFAULT_CONFIG.statuses
      ? {
          statuses: DEFAULT_CONFIG.statuses.statuses.map((s) => ({ ...s })),
          order: [...DEFAULT_CONFIG.statuses.order],
          transitions: DEFAULT_CONFIG.statuses.transitions.map((t) => ({ ...t })),
        }
      : null,
    types: DEFAULT_CONFIG.types
      ? {
          definitions: DEFAULT_CONFIG.types.definitions.map((d) => ({ ...d })),
          default: DEFAULT_CONFIG.types.default,
        }
      : null,
    agents: DEFAULT_CONFIG.agents
      ? DEFAULT_CONFIG.agents.map((a) => ({
          ...a,
          ...(a.args ? { args: [...a.args] } : {}),
          ...(a.resume ? { resume: { ...a.resume, args: [...a.resume.args] } } : {}),
          ...(a.fork ? { fork: { ...a.fork, args: [...a.fork.args] } } : {}),
        }))
      : null,
    playbooks: {
      disabled: [...DEFAULT_CONFIG.playbooks.disabled],
    },
    theme: DEFAULT_CONFIG.theme ? { ...DEFAULT_CONFIG.theme } : null,
    hotkeys: DEFAULT_CONFIG.hotkeys
      ? { bindings: { ...DEFAULT_CONFIG.hotkeys.bindings } }
      : null,
    terminal: DEFAULT_CONFIG.terminal,
    workspaceVisibility: {
      hidden: [...DEFAULT_CONFIG.workspaceVisibility.hidden],
    },
  };
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  const lines = match[1].split('\n');
  let currentParent: string | null = null;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    const colonIndex = line.indexOf(':');
    if (colonIndex < 0) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    if (indent === 0) {
      if (value === '' || value === undefined) {
        currentParent = key;
      } else {
        currentParent = null;
        result[key] = value.replace(/^["']|["']$/g, '');
      }
    } else if (indent > 0 && currentParent) {
      result[`${currentParent}.${key}`] = value.replace(/^["']|["']$/g, '');
    }
  }
  return result;
}

/**
 * Reconstruct the optional per-agent install records from the flattened
 * frontmatter. Keys look like `integrations.installedAgents.<id>` → `<scope>`.
 * Returns `{}` (no key) when none are present so the field stays absent.
 */
function parseInstalledAgents(
  fm: Record<string, string>,
): Pick<IntegrationConfig, 'installedAgents'> {
  const prefix = 'integrations.installedAgents.';
  const installedAgents: Record<string, { scope: 'project' | 'global' }> = {};
  for (const [key, value] of Object.entries(fm)) {
    if (!key.startsWith(prefix)) continue;
    const id = key.slice(prefix.length);
    if (!id) continue;
    const scope = value === 'project' ? 'project' : 'global';
    installedAgents[id] = { scope };
  }
  return Object.keys(installedAgents).length > 0 ? { installedAgents } : {};
}

export function parseStatusConfig(content: string): StatusConfig | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fmBlock = match[1];

  // Check if there's a top-level statuses: section
  const statusesStart = fmBlock.match(/^statuses:\s*$/m);
  if (!statusesStart) return null;

  // Extract the statuses block (everything indented after "statuses:")
  const startIdx = fmBlock.indexOf(statusesStart[0]) + statusesStart[0].length;
  const remaining = fmBlock.slice(startIdx);

  const statuses: StatusDefinition[] = [];
  const order: string[] = [];
  const transitions: StatusTransition[] = [];
  const phaseLadder: PhaseRung[] = [];
  const disposition: DispositionRule[] = [];
  const headline: Record<string, string> = {};
  const facts: RawFactDeclaration[] = [];

  // Strip surrounding quotes from a YAML scalar (AQL conditions are quoted).
  const unquote = (v: string): string => {
    const t = v.trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1);
    }
    return t;
  };

  // Like `unquote`, but also reverses the `\`/`"` escaping that `escapeAql`
  // applies to the THREE escaped derive-rule fields (phaseLadder when/next,
  // disposition when). Scoped to those reads only — the plain `unquote` above
  // stays the decoder for every other (unescaped) scalar (is/phase/headline/
  // facts/aliases), so no field the serializer never escapes can be
  // over-decoded. Mirrors parseSimpleValue's escape handling.
  const unquoteAql = (v: string): string => {
    const t = v.trim();
    if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
      return t.slice(1, -1).replace(/\\(["\\])/g, '$1');
    }
    if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
      return t.slice(1, -1);
    }
    return t;
  };

  // Parse sub-sections: definitions, order, transitions + derive rules
  // (phaseLadder, disposition, headline — derived-status v3, persisted flat
  // under `statuses:`).
  let currentSection:
    | 'definitions'
    | 'order'
    | 'transitions'
    | 'phaseLadder'
    | 'disposition'
    | 'headline'
    | 'facts'
    | null = null;
  const lines = remaining.split('\n');

  function parseListEntry(lineIdx: number, baseIndent: number): { entry: Record<string, string>; consumed: number } {
    const entry: Record<string, string> = {};
    const firstLine = lines[lineIdx].trimStart().slice(2).trim();
    const colonIdx = firstLine.indexOf(':');
    if (colonIdx > 0) {
      entry[firstLine.slice(0, colonIdx).trim()] = firstLine.slice(colonIdx + 1).trim();
    }
    let consumed = 1;
    for (let i = lineIdx + 1; i < lines.length; i++) {
      const next = lines[i];
      const nextTrimmed = next.trimStart();
      const nextIndent = next.length - nextTrimmed.length;
      if (nextIndent <= baseIndent || nextTrimmed.startsWith('- ')) break;
      const ci = nextTrimmed.indexOf(':');
      if (ci > 0) {
        entry[nextTrimmed.slice(0, ci).trim()] = nextTrimmed.slice(ci + 1).trim();
      }
      consumed++;
    }
    return { entry, consumed };
  }

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    // Top-level key under statuses (indent 2)
    if (indent === 2 && trimmed.endsWith(':')) {
      const key = trimmed.slice(0, -1).trim();
      if (key === 'definitions') currentSection = 'definitions';
      else if (key === 'order') currentSection = 'order';
      else if (key === 'transitions') currentSection = 'transitions';
      else if (key === 'phaseLadder') currentSection = 'phaseLadder';
      else if (key === 'disposition') currentSection = 'disposition';
      else if (key === 'headline') currentSection = 'headline';
      else if (key === 'facts') currentSection = 'facts';
      else currentSection = null;
      continue;
    }

    // Stop if we hit a new top-level key (no indent)
    if (indent === 0 && trimmed.includes(':')) break;

    if (currentSection === 'order' && indent >= 4 && trimmed.startsWith('- ')) {
      order.push(trimmed.slice(2).trim());
      continue;
    }

    if (currentSection === 'definitions' && indent >= 4 && trimmed.startsWith('- ')) {
      const { entry, consumed } = parseListEntry(lineIdx, indent);
      if (entry['id']) {
        statuses.push({
          id: entry['id'],
          label: entry['label'] ?? entry['id'],
          description: entry['description'],
          color: entry['color'],
          icon: entry['icon'],
          terminal: entry['terminal'] === 'true',
        });
      }
      lineIdx += consumed - 1; // skip consumed continuation lines
      continue;
    }

    if (currentSection === 'transitions' && indent >= 4 && trimmed.startsWith('- ')) {
      const { entry, consumed } = parseListEntry(lineIdx, indent);
      if (entry['from'] && entry['command'] && entry['to']) {
        transitions.push({
          from: entry['from'],
          command: entry['command'],
          to: entry['to'],
          label: entry['label'],
          description: entry['description'],
          requiresReason: entry['requiresReason'] === 'true',
        });
      }
      lineIdx += consumed - 1;
      continue;
    }

    if (currentSection === 'phaseLadder' && indent >= 4 && trimmed.startsWith('- ')) {
      const { entry, consumed } = parseListEntry(lineIdx, indent);
      if (entry['phase'] && entry['when'] !== undefined) {
        phaseLadder.push({
          phase: unquote(entry['phase']),
          when: unquoteAql(entry['when']),
          next: entry['next'] !== undefined ? unquoteAql(entry['next']) : undefined,
        });
      }
      lineIdx += consumed - 1;
      continue;
    }

    if (currentSection === 'disposition' && indent >= 4 && trimmed.startsWith('- ')) {
      const { entry, consumed } = parseListEntry(lineIdx, indent);
      if (entry['else'] !== undefined) {
        disposition.push({ when: null, is: unquote(entry['else']) });
      } else if (entry['when'] !== undefined && entry['is']) {
        disposition.push({ when: unquoteAql(entry['when']), is: unquote(entry['is']) });
      }
      lineIdx += consumed - 1;
      continue;
    }

    if (currentSection === 'headline' && indent >= 4 && !trimmed.startsWith('- ')) {
      const ci = trimmed.indexOf(':');
      if (ci > 0) {
        headline[trimmed.slice(0, ci).trim()] = unquote(trimmed.slice(ci + 1));
      }
      continue;
    }

    if (currentSection === 'facts' && indent >= 4 && trimmed.startsWith('- ')) {
      // Loose parse: keep every recognizable row verbatim (RawFactDeclaration)
      // so invalid rows round-trip AND doctor can diagnose exactly what the
      // normalize/accept pipeline drops — a row missing `name` must NOT be
      // silently deleted (that is the silent-deletion bug class this feature
      // exists to prevent). A row with no recognized key at all is skipped.
      const { entry, consumed } = parseListEntry(lineIdx, indent);
      if (
        entry['name'] !== undefined ||
        entry['type'] !== undefined ||
        entry['binds'] !== undefined
      ) {
        facts.push({
          name: entry['name'] !== undefined ? unquote(entry['name']) : '',
          type: entry['type'] !== undefined ? unquote(entry['type']) : '',
          binds: entry['binds'] !== undefined ? unquote(entry['binds']) : null,
        });
      }
      lineIdx += consumed - 1;
      continue;
    }
  }

  const derive: DeriveConfig | null =
    phaseLadder.length > 0 || disposition.length > 0 || Object.keys(headline).length > 0
      ? {
          phaseLadder: phaseLadder.length > 0 ? phaseLadder : DEFAULT_DERIVE_CONFIG.phaseLadder,
          disposition: disposition.length > 0 ? disposition : DEFAULT_DERIVE_CONFIG.disposition,
          headline: {
            terminal: 'passthrough',
            parked: headline['parked'] ?? DEFAULT_DERIVE_CONFIG.headline.parked,
            blocked: headline['blocked'] ?? DEFAULT_DERIVE_CONFIG.headline.blocked,
            active: 'phase',
          },
        }
      : null;

  // Return null only when the `statuses:` block carried no usable content at
  // all. A block that declares facts and/or derive rules but no status
  // `definitions` must still surface them — dropping them here is the
  // silent-deletion bug class this loose parser exists to prevent
  // (getStatusConfig falls back to default statuses/order so the board still
  // renders, while the declared facts/derive ride along).
  if (statuses.length === 0 && facts.length === 0 && derive === null) return null;

  return {
    statuses,
    order: order.length > 0 ? order : statuses.map((s) => s.id),
    transitions,
    derive,
    facts: facts.length > 0 ? facts : null,
  };
}

/**
 * Default per-status accent colors. Statuses without an entry fall back to
 * `'gray'` in {@link buildDefaultStatusConfig}. Shared by the dashboard's
 * `getStatusConfig()` and the `syntaur status` CLI so the two never drift.
 */
export const DEFAULT_STATUS_COLORS: Record<string, string> = {
  pending: 'slate',
  in_progress: 'teal',
  blocked: 'amber',
  review: 'violet',
  completed: 'emerald',
  failed: 'rose',
};

/** Turn a snake_case status id into a human label ("in_progress" → "In Progress"). */
export function toTitleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Materialize the built-in default status set as an explicit {@link StatusConfig}.
 *
 * `DEFAULT_CONFIG.statuses` is `null` (the runtime resolves defaults lazily), so
 * `syntaur status init` / `list` cannot read defaults from there. This builder
 * reproduces exactly what the dashboard's `getStatusConfig()` no-block branch
 * builds — same ids/labels/colors/terminal flags and the same transition table —
 * so the CLI and the dashboard share one source of truth.
 */
export function buildDefaultStatusConfig(): StatusConfig {
  return {
    statuses: DEFAULT_STATUSES.map((id) => ({
      id,
      label: toTitleCase(id),
      color: DEFAULT_STATUS_COLORS[id] ?? 'gray',
      terminal: id === 'completed' || id === 'failed',
    })),
    order: [...DEFAULT_STATUSES],
    transitions: Array.from(DEFAULT_TRANSITION_TABLE.entries()).map(([key, to]) => {
      const [from, command] = key.split(':');
      return { from, command, to };
    }),
  };
}

export function serializeStatusConfig(statuses: StatusConfig): string {
  const lines: string[] = [];
  // Symmetric with `unquoteAql` in parseStatusConfig: escape backslash THEN
  // quote so the derive-rule when/next/disposition-when fields round-trip even
  // when they contain a literal `"` or `\`. (Previously only `"` was escaped and
  // nothing reversed it, so a quoted AQL condition accumulated a backslash on
  // every save→reload.)
  const escapeAql = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  lines.push('statuses:');

  // definitions
  lines.push('  definitions:');
  for (const s of statuses.statuses) {
    lines.push(`    - id: ${s.id}`);
    lines.push(`      label: ${s.label}`);
    if (s.description) lines.push(`      description: ${s.description}`);
    if (s.color) lines.push(`      color: ${s.color}`);
    if (s.icon) lines.push(`      icon: ${s.icon}`);
    if (s.terminal) lines.push(`      terminal: true`);
  }

  // order
  lines.push('  order:');
  for (const id of statuses.order) {
    lines.push(`    - ${id}`);
  }

  // transitions
  if (statuses.transitions.length > 0) {
    lines.push('  transitions:');
    for (const t of statuses.transitions) {
      lines.push(`    - from: ${t.from}`);
      lines.push(`      command: ${t.command}`);
      lines.push(`      to: ${t.to}`);
      if (t.label) lines.push(`      label: ${t.label}`);
      if (t.description) lines.push(`      description: ${t.description}`);
      if (t.requiresReason) lines.push(`      requiresReason: true`);
    }
  }

  // custom fact declarations — emitted verbatim (RawFactDeclaration) so the
  // round-trip preserves whatever the user wrote, even invalid rows that the
  // normalize/accept pipeline later drops. Same silent-deletion class as derive.
  if (statuses.facts && statuses.facts.length > 0) {
    lines.push('  facts:');
    for (const f of statuses.facts) {
      lines.push(`    - name: ${f.name}`);
      lines.push(`      type: ${f.type}`);
      if (f.binds !== null && f.binds !== undefined) {
        lines.push(`      binds: ${f.binds}`);
      }
    }
  }

  // derive rules (derived-status v3) — serialized so every writeStatusConfig
  // round-trip preserves them (the pre-v3 writer rebuilt the block from
  // definitions/order/transitions only and silently deleted custom rules).
  if (statuses.derive) {
    const d = statuses.derive;
    lines.push('  phaseLadder:');
    for (const rung of d.phaseLadder) {
      lines.push(`    - phase: ${rung.phase}`);
      lines.push(`      when: "${escapeAql(rung.when)}"`);
      // `!== undefined`, not truthy: an accepted empty-string `next: ""` must
      // be preserved (otherwise it reparses as undefined — a round-trip loss).
      if (rung.next !== undefined) lines.push(`      next: "${escapeAql(rung.next)}"`);
    }
    lines.push('  disposition:');
    for (const rule of d.disposition) {
      if (rule.when === null) {
        lines.push(`    - else: ${rule.is}`);
      } else {
        lines.push(`    - when: "${escapeAql(rule.when)}"`);
        lines.push(`      is: ${rule.is}`);
      }
    }
    lines.push('  headline:');
    lines.push(`    terminal: passthrough`);
    lines.push(`    parked: ${d.headline.parked}`);
    lines.push(`    blocked: ${d.headline.blocked}`);
    lines.push(`    active: phase`);
  }

  return lines.join('\n');
}

function serializeIntegrationConfig(integrations: IntegrationConfig): string | null {
  const lines: string[] = [];

  if (integrations.claudePluginDir) {
    lines.push(`  claudePluginDir: ${integrations.claudePluginDir}`);
  }
  if (integrations.codexPluginDir) {
    lines.push(`  codexPluginDir: ${integrations.codexPluginDir}`);
  }
  if (integrations.codexMarketplacePath) {
    lines.push(`  codexMarketplacePath: ${integrations.codexMarketplacePath}`);
  }
  if (integrations.installedAgents) {
    for (const [id, rec] of Object.entries(integrations.installedAgents)) {
      lines.push(`  installedAgents.${id}: ${rec.scope}`);
    }
  }

  if (lines.length === 0) {
    return null;
  }

  return ['integrations:', ...lines].join('\n');
}

function serializeOnboardingConfig(onboarding: OnboardingConfig): string {
  return ['onboarding:', `  completed: ${onboarding.completed ? 'true' : 'false'}`].join('\n');
}

function serializeBackupConfig(backup: BackupConfig): string {
  const lines: string[] = ['backup:'];
  lines.push(`  repo: ${backup.repo ?? 'null'}`);
  lines.push(`  categories: ${backup.categories}`);
  lines.push(`  lastBackup: ${backup.lastBackup ?? 'null'}`);
  lines.push(`  lastRestore: ${backup.lastRestore ?? 'null'}`);
  return lines.join('\n');
}

function serializePlaybooksConfig(playbooks: PlaybooksConfig): string | null {
  if (!playbooks.disabled || playbooks.disabled.length === 0) {
    return null;
  }
  const lines: string[] = ['playbooks:', '  disabled:'];
  for (const slug of playbooks.disabled) {
    lines.push(`    - ${slug}`);
  }
  return lines.join('\n');
}

function parsePlaybooksConfig(fmBlock: string): PlaybooksConfig {
  const blockStart = fmBlock.match(/^playbooks:\s*$/m);
  if (!blockStart) {
    return { disabled: [] };
  }

  const startIdx = fmBlock.indexOf(blockStart[0]) + blockStart[0].length;
  const remaining = fmBlock.slice(startIdx).split('\n');

  const disabled: string[] = [];
  let currentSection: 'disabled' | null = null;

  for (const line of remaining) {
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    // End of playbooks block — next top-level key
    if (indent === 0 && trimmed.length > 0) break;

    if (trimmed === '') continue;

    if (indent === 2 && trimmed.startsWith('disabled:')) {
      currentSection = 'disabled';
      // Support inline form `disabled: []` — treat as empty list.
      const afterColon = trimmed.slice('disabled:'.length).trim();
      if (afterColon === '[]' || afterColon === '') {
        continue;
      }
      // Any other inline value is malformed; skip.
      continue;
    }

    if (currentSection === 'disabled' && indent >= 4 && trimmed.startsWith('- ')) {
      const raw = trimmed.slice(2).trim().replace(/^["']|["']$/g, '');
      if (raw.length === 0) continue;
      // Defer slug-format validation to callers via isValidSlug where needed;
      // here we only filter obviously invalid whitespace-containing entries.
      if (/\s/.test(raw)) {
        console.warn(`Warning: config.md playbooks.disabled entry "${raw}" contains whitespace, ignoring`);
        continue;
      }
      disabled.push(raw);
      continue;
    }
  }

  return { disabled };
}

export async function updatePlaybooksConfig(
  playbooks: Partial<PlaybooksConfig>,
): Promise<void> {
  const configPath = resolve(syntaurRoot(), 'config.md');
  const current = (await readConfig()).playbooks;
  const nextPlaybooks: PlaybooksConfig = {
    disabled: Array.from(new Set(playbooks.disabled ?? current.disabled)),
  };

  const playbooksBlock = serializePlaybooksConfig(nextPlaybooks);
  const existing = await fileExists(configPath)
    ? await readFile(configPath, 'utf-8')
    : renderConfig({ defaultProjectDir: defaultProjectDir() });

  const fmMatch = existing.match(/^(---\n)([\s\S]*?)\n(---)/);
  if (!fmMatch) {
    const bodyBlock = playbooksBlock ? `${playbooksBlock}\n` : '';
    const content = `---\nversion: "2.0"\ndefaultProjectDir: ${defaultProjectDir()}\n${bodyBlock}---\n${existing}`;
    await writeFileForce(configPath, content);
    return;
  }

  const fmBlock = fmMatch[2];
  const afterFrontmatter = existing.slice(fmMatch[0].length);
  const cleanedFm = stripTopLevelBlock(fmBlock, 'playbooks');
  const newFm = playbooksBlock
    ? `${cleanedFm}\n${playbooksBlock}`.replace(/^\n+/, '')
    : cleanedFm;
  const normalizedFm = newFm.replace(/\n+$/, '');
  const newContent = `---\n${normalizedFm}\n---${afterFrontmatter}`;
  await writeFileForce(configPath, newContent);
}

function parseThemeConfig(content: string): ThemeConfig | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fmBlock = match[1];

  const blockStart = fmBlock.match(/^theme:\s*$/m);
  if (!blockStart) return null;

  const startIdx = fmBlock.indexOf(blockStart[0]) + blockStart[0].length;
  const remaining = fmBlock.slice(startIdx).split('\n');

  let preset: string | null = null;
  for (const line of remaining) {
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;
    if (indent === 0 && trimmed.length > 0) break;
    if (trimmed === '') continue;
    if (indent === 2 && trimmed.startsWith('preset:')) {
      const value = trimmed.slice('preset:'.length).trim().replace(/^["']|["']$/g, '');
      if (value.length > 0) preset = value;
    }
  }

  if (!preset) return null;
  return { preset };
}

function serializeThemeConfig(theme: ThemeConfig): string {
  return ['theme:', `  preset: ${theme.preset}`].join('\n');
}

export async function writeThemeConfig(theme: ThemeConfig): Promise<void> {
  const configPath = resolve(syntaurRoot(), 'config.md');
  const themeBlock = serializeThemeConfig(theme);

  const existing = await fileExists(configPath)
    ? await readFile(configPath, 'utf-8')
    : renderConfig({ defaultProjectDir: defaultProjectDir() });

  const fmMatch = existing.match(/^(---\n)([\s\S]*?)\n(---)/);
  if (!fmMatch) {
    const content = `---\nversion: "2.0"\ndefaultProjectDir: ${defaultProjectDir()}\n${themeBlock}\n---\n${existing}`;
    await writeFileForce(configPath, content);
    return;
  }

  const fmBlock = fmMatch[2];
  const afterFrontmatter = existing.slice(fmMatch[0].length);
  const cleanedFm = stripTopLevelBlock(fmBlock, 'theme');
  const newFm = `${cleanedFm}\n${themeBlock}`.replace(/^\n+/, '');
  const normalizedFm = newFm.replace(/\n+$/, '');
  const newContent = `---\n${normalizedFm}\n---${afterFrontmatter}`;
  await writeFileForce(configPath, newContent);
}

export async function deleteThemeConfig(): Promise<void> {
  const configPath = resolve(syntaurRoot(), 'config.md');
  if (!(await fileExists(configPath))) return;

  const existing = await readFile(configPath, 'utf-8');
  const fmMatch = existing.match(/^(---\n)([\s\S]*?)\n(---)/);
  if (!fmMatch) return;

  const fmBlock = fmMatch[2];
  const afterFrontmatter = existing.slice(fmMatch[0].length);
  const cleanedFm = stripTopLevelBlock(fmBlock, 'theme');
  const newContent = `---\n${cleanedFm}\n---${afterFrontmatter}`;
  await writeFileForce(configPath, newContent);
}

/**
 * Serialize the workspace-visibility blocklist. Mirrors the `playbooks.disabled`
 * list shape but JSON-escapes each entry so arbitrary workspace names (spaces,
 * quotes, backslashes) round-trip. Returns `null` for an empty list so the
 * writer omits the block entirely (absent = all workspaces visible).
 */
function serializeWorkspaceVisibilityConfig(
  cfg: WorkspaceVisibilityConfig,
): string | null {
  const hidden = normalizeHiddenList(cfg.hidden);
  if (hidden.length === 0) return null;
  const lines: string[] = ['workspaceVisibility:', '  hidden:'];
  for (const name of hidden) {
    lines.push(`    - ${JSON.stringify(name)}`);
  }
  return lines.join('\n');
}

/**
 * Parse the workspace-visibility blocklist from a frontmatter block. Unlike
 * `parsePlaybooksConfig` (which rejects whitespace-containing slugs), workspace
 * names are arbitrary: a JSON-quoted entry is `JSON.parse`d, an unquoted entry
 * is taken literally. Absent block → empty list (everything visible).
 */
function parseWorkspaceVisibilityConfig(
  fmBlock: string,
): WorkspaceVisibilityConfig {
  const blockStart = fmBlock.match(/^workspaceVisibility:\s*$/m);
  if (!blockStart) {
    return { hidden: [] };
  }

  const startIdx = fmBlock.indexOf(blockStart[0]) + blockStart[0].length;
  const remaining = fmBlock.slice(startIdx).split('\n');

  const hidden: string[] = [];
  let currentSection: 'hidden' | null = null;

  for (const line of remaining) {
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    // End of block — next top-level key.
    if (indent === 0 && trimmed.length > 0) break;
    if (trimmed === '') continue;

    if (indent === 2 && trimmed.startsWith('hidden:')) {
      currentSection = 'hidden';
      // Support inline form `hidden: []` — treat as empty list.
      continue;
    }

    if (currentSection === 'hidden' && indent >= 4 && trimmed.startsWith('- ')) {
      const rest = trimmed.slice(2).trim();
      if (rest.length === 0) continue;
      let name: string;
      if (rest.startsWith('"')) {
        try {
          name = JSON.parse(rest) as string;
        } catch {
          // Hand-edited / malformed — strip a single surrounding quote pair.
          name = rest.replace(/^["']|["']$/g, '');
        }
      } else {
        name = rest;
      }
      hidden.push(name);
      continue;
    }
  }

  return { hidden: normalizeHiddenList(hidden) };
}

export async function writeWorkspaceVisibilityConfig(
  cfg: WorkspaceVisibilityConfig,
): Promise<void> {
  const configPath = resolve(syntaurRoot(), 'config.md');
  const block = serializeWorkspaceVisibilityConfig(cfg);

  const existing = (await fileExists(configPath))
    ? await readFile(configPath, 'utf-8')
    : renderConfig({ defaultProjectDir: defaultProjectDir() });

  const fmMatch = existing.match(/^(---\n)([\s\S]*?)\n(---)/);
  if (!fmMatch) {
    const bodyBlock = block ? `${block}\n` : '';
    const content = `---\nversion: "2.0"\ndefaultProjectDir: ${defaultProjectDir()}\n${bodyBlock}---\n${existing}`;
    await writeFileForce(configPath, content);
    return;
  }

  const fmBlock = fmMatch[2];
  const afterFrontmatter = existing.slice(fmMatch[0].length);
  const cleanedFm = stripTopLevelBlock(fmBlock, 'workspaceVisibility');
  const newFm = block
    ? `${cleanedFm}\n${block}`.replace(/^\n+/, '')
    : cleanedFm;
  const normalizedFm = newFm.replace(/\n+$/, '');
  const newContent = `---\n${normalizedFm}\n---${afterFrontmatter}`;
  await writeFileForce(configPath, newContent);
}

export async function deleteWorkspaceVisibilityConfig(): Promise<void> {
  const configPath = resolve(syntaurRoot(), 'config.md');
  if (!(await fileExists(configPath))) return;

  const existing = await readFile(configPath, 'utf-8');
  const fmMatch = existing.match(/^(---\n)([\s\S]*?)\n(---)/);
  if (!fmMatch) return;

  const fmBlock = fmMatch[2];
  const afterFrontmatter = existing.slice(fmMatch[0].length);
  const cleanedFm = stripTopLevelBlock(fmBlock, 'workspaceVisibility');
  const newContent = `---\n${cleanedFm}\n---${afterFrontmatter}`;
  await writeFileForce(configPath, newContent);
}

/**
 * Remove any top-level `key: <value>` scalar line from a YAML frontmatter block.
 * Used for scalar keys (terminal:) that don't have child lines, so they can't
 * use the block-style `stripTopLevelBlock`. No-op when the key is absent.
 */
function stripTopLevelScalar(fmBlock: string, key: string): string {
  const lines = fmBlock.split('\n');
  const keyRegex = new RegExp(`^${key}:\\s*\\S`);
  const filtered = lines.filter((line) => !keyRegex.test(line));
  return filtered.join('\n').replace(/\n+$/, '');
}

export async function writeTerminalConfig(terminal: TerminalChoice): Promise<void> {
  const configPath = resolve(syntaurRoot(), 'config.md');
  const terminalLine = `terminal: ${terminal}`;

  const existing = (await fileExists(configPath))
    ? await readFile(configPath, 'utf-8')
    : renderConfig({ defaultProjectDir: defaultProjectDir() });

  const fmMatch = existing.match(/^(---\n)([\s\S]*?)\n(---)/);
  if (!fmMatch) {
    const content = `---\nversion: "2.0"\ndefaultProjectDir: ${defaultProjectDir()}\n${terminalLine}\n---\n${existing}`;
    await writeFileForce(configPath, content);
    return;
  }

  const fmBlock = fmMatch[2];
  const afterFrontmatter = existing.slice(fmMatch[0].length);
  const cleanedFm = stripTopLevelScalar(fmBlock, 'terminal');
  const newFm = `${cleanedFm}\n${terminalLine}`.replace(/^\n+/, '');
  const normalizedFm = newFm.replace(/\n+$/, '');
  const newContent = `---\n${normalizedFm}\n---${afterFrontmatter}`;
  await writeFileForce(configPath, newContent);
}

export async function deleteTerminalConfig(): Promise<void> {
  const configPath = resolve(syntaurRoot(), 'config.md');
  if (!(await fileExists(configPath))) return;

  const existing = await readFile(configPath, 'utf-8');
  const fmMatch = existing.match(/^(---\n)([\s\S]*?)\n(---)/);
  if (!fmMatch) return;

  const fmBlock = fmMatch[2];
  const afterFrontmatter = existing.slice(fmMatch[0].length);
  const cleanedFm = stripTopLevelScalar(fmBlock, 'terminal');
  const newContent = `---\n${cleanedFm}\n---${afterFrontmatter}`;
  await writeFileForce(configPath, newContent);
}

function parseHotkeyBindingsConfig(content: string): HotkeyBindingsConfig | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fmBlock = match[1];

  const blockStart = fmBlock.match(/^hotkeys:\s*$/m);
  if (!blockStart) return null;

  const startIdx = fmBlock.indexOf(blockStart[0]) + blockStart[0].length;
  const remaining = fmBlock.slice(startIdx).split('\n');

  const bindings: Partial<Record<BindableActionKind, string>> = {};
  let inBindings = false;
  for (const line of remaining) {
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;
    if (indent === 0 && trimmed.length > 0) break;
    if (trimmed === '') continue;
    if (indent === 2 && trimmed === 'bindings:') {
      inBindings = true;
      continue;
    }
    if (inBindings && indent === 4) {
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx <= 0) continue;
      const rawKind = trimmed.slice(0, colonIdx).trim();
      const rawValue = trimmed
        .slice(colonIdx + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
      if (!isBindableActionKind(rawKind)) continue;
      if (rawValue.length === 0) continue;
      bindings[rawKind] = canonicalizeCombo(rawValue);
    }
  }

  if (Object.keys(bindings).length === 0) return null;
  return { bindings };
}

function serializeHotkeyBindingsConfig(cfg: HotkeyBindingsConfig): string {
  const lines: string[] = ['hotkeys:', '  bindings:'];
  // Emit in the canonical kind order so on-disk diffs are stable.
  for (const kind of BINDABLE_ACTION_KINDS) {
    const value = cfg.bindings[kind];
    if (!value) continue;
    lines.push(`    ${kind}: "${canonicalizeCombo(value)}"`);
  }
  // If no bindings remain, return an empty block (caller will treat as delete).
  if (lines.length === 2) return '';
  return lines.join('\n');
}

export async function writeHotkeyBindingsConfig(
  cfg: HotkeyBindingsConfig,
): Promise<void> {
  // Validate + canonicalize + drop reserved-combo collisions before writing.
  const cleaned: Partial<Record<BindableActionKind, string>> = {};
  for (const kind of BINDABLE_ACTION_KINDS) {
    const raw = cfg.bindings[kind];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const canonical = canonicalizeCombo(raw);
    if (!canonical) continue;
    if (isReservedCombo(canonical)) continue;
    cleaned[kind] = canonical;
  }

  if (Object.keys(cleaned).length === 0) {
    await deleteHotkeyBindingsConfig();
    return;
  }

  const configPath = resolve(syntaurRoot(), 'config.md');
  const block = serializeHotkeyBindingsConfig({ bindings: cleaned });

  const existing = (await fileExists(configPath))
    ? await readFile(configPath, 'utf-8')
    : renderConfig({ defaultProjectDir: defaultProjectDir() });

  const fmMatch = existing.match(/^(---\n)([\s\S]*?)\n(---)/);
  if (!fmMatch) {
    const content = `---\nversion: "2.0"\ndefaultProjectDir: ${defaultProjectDir()}\n${block}\n---\n${existing}`;
    await writeFileForce(configPath, content);
    return;
  }

  const fmBlock = fmMatch[2];
  const afterFrontmatter = existing.slice(fmMatch[0].length);
  const cleanedFm = stripTopLevelBlock(fmBlock, 'hotkeys');
  const newFm = `${cleanedFm}\n${block}`.replace(/^\n+/, '');
  const normalizedFm = newFm.replace(/\n+$/, '');
  const newContent = `---\n${normalizedFm}\n---${afterFrontmatter}`;
  await writeFileForce(configPath, newContent);
}

export async function deleteHotkeyBindingsConfig(): Promise<void> {
  const configPath = resolve(syntaurRoot(), 'config.md');
  if (!(await fileExists(configPath))) return;

  const existing = await readFile(configPath, 'utf-8');
  const fmMatch = existing.match(/^(---\n)([\s\S]*?)\n(---)/);
  if (!fmMatch) return;

  const fmBlock = fmMatch[2];
  const afterFrontmatter = existing.slice(fmMatch[0].length);
  const cleanedFm = stripTopLevelBlock(fmBlock, 'hotkeys');
  const newContent = `---\n${cleanedFm}\n---${afterFrontmatter}`;
  await writeFileForce(configPath, newContent);
}

function stripTopLevelBlock(fmBlock: string, key: string): string {
  const blockStart = fmBlock.match(new RegExp(`^${key}:\\s*$`, 'm'));
  if (!blockStart) {
    return fmBlock.replace(/\n+$/, '');
  }

  // Regex match offset, not indexOf — the `${key}:` text can appear earlier inside
  // another block's value (e.g. `search:` in an AQL string), and indexOf would cut
  // from there, corrupting unrelated frontmatter.
  const startIdx = blockStart.index ?? 0;
  const before = fmBlock.slice(0, startIdx);
  const after = fmBlock.slice(startIdx + blockStart[0].length);
  const remaining = after.split('\n');
  let endIdx = 0;

  for (let i = 0; i < remaining.length; i++) {
    const line = remaining[i];
    if (line.trim() === '') {
      endIdx = i + 1;
      continue;
    }
    if (line.length > 0 && line[0] !== ' ') {
      break;
    }
    endIdx = i + 1;
  }

  return (before + remaining.slice(endIdx).join('\n')).replace(/\n+$/, '');
}

function parseOptionalAbsolutePath(
  value: string | undefined,
  fieldName: string,
): string | null {
  if (!value) {
    return null;
  }

  const expanded = expandHome(String(value));
  if (!isAbsolute(expanded)) {
    console.warn(
      `Warning: config.md ${fieldName} is not an absolute path ("${value}"), ignoring it`,
    );
    return null;
  }

  return resolve(expanded);
}

function parseAgentsConfig(content: string): AgentConfig[] | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fmBlock = match[1];

  const agentsStart = fmBlock.match(/^agents:\s*$/m);
  if (!agentsStart) return null;

  const startIdx = fmBlock.indexOf(agentsStart[0]) + agentsStart[0].length;
  const remaining = fmBlock.slice(startIdx);
  const lines = remaining.split('\n');

  const agents: AgentConfig[] = [];
  let current: Partial<AgentConfig> & { args?: string[] } | null = null;
  let argsCapture: string[] | null = null;
  let argsBaseIndent = 0;
  // Active nested block state (e.g. `resume:` or `fork:` sub-mapping under an
  // agent). When `nestedKey` is one of `resume` / `fork`, lines at deeper
  // indent are parsed as that invocation's `command` / `args` fields. When
  // `nestedKey === '__skip__'` we swallow the indented block without
  // recording anything — this is the forward-compat path for unknown nested
  // keys added in future syntaur versions.
  let nestedKey: string | null = null;
  let nestedInvocation: SessionInvocation | null = null;
  let nestedBaseIndent = 0;

  function flushCurrent() {
    if (!current) return;
    if (!current.id || !current.command || !current.label) {
      current = null;
      return;
    }
    agents.push({
      id: current.id,
      label: current.label,
      command: current.command,
      ...(current.args && current.args.length > 0 ? { args: current.args } : {}),
      ...(current.promptArgPosition
        ? { promptArgPosition: current.promptArgPosition }
        : {}),
      ...(current.default ? { default: true } : {}),
      ...(current.resolveFromShellAliases ? { resolveFromShellAliases: true } : {}),
      ...(current.model ? { model: current.model } : {}),
      ...(current.playbook ? { playbook: current.playbook } : {}),
      ...(current.launchPrompt ? { launchPrompt: current.launchPrompt } : {}),
      ...(current.resume ? { resume: current.resume } : {}),
      ...(current.fork ? { fork: current.fork } : {}),
    });
    current = null;
    argsCapture = null;
    nestedKey = null;
    nestedInvocation = null;
  }

  function closeNestedBlock() {
    if (!nestedKey) return;
    if (current && (nestedKey === 'resume' || nestedKey === 'fork') && nestedInvocation) {
      // Only attach when args were populated — empty invocation is a no-op.
      if (Array.isArray(nestedInvocation.args)) {
        current[nestedKey] = nestedInvocation;
      }
    }
    nestedKey = null;
    nestedInvocation = null;
    argsCapture = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    if (indent === 0 && trimmed !== '' && !trimmed.startsWith('#')) {
      closeNestedBlock();
      break; // new top-level key
    }

    // Continue capturing list items for the active argsCapture target.
    if (argsCapture) {
      if (indent > argsBaseIndent && trimmed.startsWith('- ')) {
        argsCapture.push(decodeYamlScalar(trimmed.slice(2).trim()));
        continue;
      } else {
        argsCapture = null;
      }
    }

    if (indent === 2 && trimmed.startsWith('- ')) {
      closeNestedBlock();
      flushCurrent();
      current = {};
      const rest = trimmed.slice(2).trim();
      const colonIdx = rest.indexOf(':');
      if (colonIdx > 0) {
        const k = rest.slice(0, colonIdx).trim();
        const v = rest.slice(colonIdx + 1).trim();
        assignAgentField(current, k, v);
      }
      continue;
    }

    if (!current) continue;

    // Inside a nested block (resume / fork / skip-unknown).
    if (nestedKey && indent > nestedBaseIndent) {
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx <= 0) continue;
      const k = trimmed.slice(0, colonIdx).trim();
      const v = trimmed.slice(colonIdx + 1).trim();
      if (nestedKey === 'resume' || nestedKey === 'fork') {
        if (!nestedInvocation) nestedInvocation = { args: [] };
        if (k === 'args' && v === '') {
          nestedInvocation.args = [];
          argsCapture = nestedInvocation.args;
          argsBaseIndent = indent;
          continue;
        }
        if (k === 'command' && v !== '') {
          nestedInvocation.command = decodeYamlScalar(v);
          continue;
        }
        // Unknown nested-of-nested: ignore for forward compat.
      }
      // nestedKey === '__skip__' → swallow without recording.
      continue;
    }

    // Returning out to indent 4 (or shallower) — close any open nested block.
    if (nestedKey && indent <= nestedBaseIndent) {
      closeNestedBlock();
    }

    if (indent >= 4 && current) {
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx <= 0) continue;
      const k = trimmed.slice(0, colonIdx).trim();
      const v = trimmed.slice(colonIdx + 1).trim();
      if (k === 'args' && v === '') {
        argsCapture = [];
        argsBaseIndent = indent;
        current.args = argsCapture;
        continue;
      }
      // Recognized nested mapping blocks: resume / fork. Empty value + no
      // recognized scalar field → enter nested mode.
      if ((k === 'resume' || k === 'fork') && v === '') {
        nestedKey = k;
        nestedInvocation = { args: [] };
        nestedBaseIndent = indent;
        continue;
      }
      // Unknown key with empty value at agent-field indent: forward-compat
      // skip. Older parsers would crash here once a future version emits
      // a new nested block; this branch lets us pass through gracefully.
      if (v === '' && !KNOWN_AGENT_SCALAR_FIELDS.has(k)) {
        nestedKey = '__skip__';
        nestedInvocation = null;
        nestedBaseIndent = indent;
        continue;
      }
      assignAgentField(current, k, v);
    }
  }
  closeNestedBlock();
  flushCurrent();

  if (agents.length === 0) return [];
  return agents;
}

const KNOWN_AGENT_SCALAR_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'label',
  'command',
  'promptArgPosition',
  'default',
  'resolveFromShellAliases',
  'model',
  'playbook',
  'launchPrompt',
]);

/**
 * Normalize and validate an agents list parsed from config.md. On any
 * AgentConfigError, log a warning and fall back to built-in defaults so a
 * malformed user config does not brick `syntaur browse`. Returns the
 * normalized list (with `command` resolved through `parseAgentCommand`).
 */
function normalizeAgentsFromConfig(agents: AgentConfig[] | null): AgentConfig[] | null {
  if (agents === null) return null;
  try {
    const normalized = agents.map((agent) => ({
      ...agent,
      command: parseAgentCommand(agent.command, agent.id),
    }));
    validateAgentList(normalized);
    return normalized;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `Warning: ~/.syntaur/config.md agents block is invalid (${msg}) — using built-in defaults`,
    );
    return null;
  }
}

/**
 * Decode a YAML-ish scalar:
 * - Bare values returned verbatim.
 * - Single-quoted: strip outer quotes, unescape '' → '.
 * - Double-quoted: strip outer quotes, unescape \\ \" \n \t \r.
 * Rejects unterminated quoted scalars (caller should surface as a parse error).
 */
function decodeYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const body = trimmed.slice(1, -1);
    let out = '';
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === '\\' && i + 1 < body.length) {
        const next = body[i + 1];
        switch (next) {
          case '\\': out += '\\'; break;
          case '"': out += '"'; break;
          case 'n': out += '\n'; break;
          case 't': out += '\t'; break;
          case 'r': out += '\r'; break;
          default: out += next; break;
        }
        i++;
        continue;
      }
      out += ch;
    }
    return out;
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function assignAgentField(target: Partial<AgentConfig>, key: string, rawValue: string): void {
  const value = decodeYamlScalar(rawValue);
  switch (key) {
    case 'id':
      target.id = value;
      break;
    case 'label':
      target.label = value;
      break;
    case 'command':
      target.command = value;
      break;
    case 'promptArgPosition':
      target.promptArgPosition = value as PromptArgPosition;
      break;
    case 'default':
      target.default = value === 'true';
      break;
    case 'resolveFromShellAliases':
      target.resolveFromShellAliases = value === 'true';
      break;
    case 'model':
      target.model = value;
      break;
    case 'playbook':
      target.playbook = value;
      break;
    case 'launchPrompt':
      target.launchPrompt = value;
      break;
  }
}

function yamlQuoteScalar(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new AgentConfigError(
      `value contains newlines, which the agents config serializer does not support: ${JSON.stringify(value)}`,
    );
  }
  if (value === '' || /[:#{}[\],&*?|>!%@`"'\\\t]/.test(value) || /^\s|\s$/.test(value)) {
    const escaped = value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\t/g, '\\t');
    return `"${escaped}"`;
  }
  return value;
}

function serializeAgentsConfig(agents: AgentConfig[]): string {
  const lines: string[] = ['agents:'];
  for (const a of agents) {
    lines.push(`  - id: ${yamlQuoteScalar(a.id)}`);
    lines.push(`    label: ${yamlQuoteScalar(a.label)}`);
    lines.push(`    command: ${yamlQuoteScalar(a.command)}`);
    if (a.model) {
      lines.push(`    model: ${yamlQuoteScalar(a.model)}`);
    }
    if (a.playbook) {
      lines.push(`    playbook: ${yamlQuoteScalar(a.playbook)}`);
    }
    if (a.launchPrompt) {
      lines.push(`    launchPrompt: ${yamlQuoteScalar(a.launchPrompt)}`);
    }
    if (a.args && a.args.length > 0) {
      lines.push(`    args:`);
      for (const arg of a.args) {
        lines.push(`      - ${yamlQuoteScalar(arg)}`);
      }
    }
    if (a.promptArgPosition && a.promptArgPosition !== 'first') {
      lines.push(`    promptArgPosition: ${a.promptArgPosition}`);
    }
    if (a.default) {
      lines.push(`    default: true`);
    }
    if (a.resolveFromShellAliases) {
      lines.push(`    resolveFromShellAliases: true`);
    }
    if (a.resume) {
      appendSessionInvocation(lines, 'resume', a.resume);
    }
    if (a.fork) {
      appendSessionInvocation(lines, 'fork', a.fork);
    }
  }
  return lines.join('\n');
}

function appendSessionInvocation(
  lines: string[],
  key: 'resume' | 'fork',
  invocation: SessionInvocation,
): void {
  lines.push(`    ${key}:`);
  if (invocation.command !== undefined) {
    lines.push(`      command: ${yamlQuoteScalar(invocation.command)}`);
  }
  lines.push(`      args:`);
  for (const arg of invocation.args) {
    lines.push(`        - ${yamlQuoteScalar(arg)}`);
  }
}

export async function writeAgentsConfig(agents: AgentConfig[]): Promise<void> {
  validateAgentList(agents);
  const configPath = resolve(syntaurRoot(), 'config.md');
  const agentsBlock = serializeAgentsConfig(agents);

  const existing = (await fileExists(configPath))
    ? await readFile(configPath, 'utf-8')
    : renderConfig({ defaultProjectDir: defaultProjectDir() });

  const fmMatch = existing.match(/^(---\n)([\s\S]*?)\n(---)/);
  if (!fmMatch) {
    const content = `---\nversion: "2.0"\ndefaultProjectDir: ${defaultProjectDir()}\n${agentsBlock}\n---\n${existing}`;
    await writeFileForce(configPath, content.replace(/\n\n---/, '\n---'));
    return;
  }

  const fmBlock = fmMatch[2];
  const afterFrontmatter = existing.slice(fmMatch[0].length);
  const cleanedFm = stripTopLevelBlock(fmBlock, 'agents');
  const newFm = `${cleanedFm}\n${agentsBlock}`.replace(/^\n+/, '').replace(/\n+$/, '');
  const newContent = `---\n${newFm}\n---${afterFrontmatter}`;
  await writeFileForce(configPath, newContent);
}

export async function deleteAgentsConfig(): Promise<void> {
  const configPath = resolve(syntaurRoot(), 'config.md');
  if (!(await fileExists(configPath))) return;

  const existing = await readFile(configPath, 'utf-8');
  const fmMatch = existing.match(/^(---\n)([\s\S]*?)\n(---)/);
  if (!fmMatch) return;

  const fmBlock = fmMatch[2];
  const afterFrontmatter = existing.slice(fmMatch[0].length);
  const cleanedFm = stripTopLevelBlock(fmBlock, 'agents');
  const newContent = `---\n${cleanedFm}\n---${afterFrontmatter}`;
  await writeFileForce(configPath, newContent);
}

export async function writeStatusConfig(statuses: StatusConfig): Promise<void> {
  const configPath = resolve(syntaurRoot(), 'config.md');
  const statusBlock = serializeStatusConfig(statuses);

  if (!(await fileExists(configPath))) {
    // Create new config file with defaults + statuses
    const content = `---\nversion: "2.0"\ndefaultProjectDir: ~/projects\n${statusBlock}\n---\n`;
    await writeFileForce(configPath, content);
    return;
  }

  const existing = await readFile(configPath, 'utf-8');
  const fmMatch = existing.match(/^(---\n)([\s\S]*?)\n(---)/);
  if (!fmMatch) {
    // No frontmatter — wrap in new frontmatter
    const content = `---\nversion: "2.0"\n${statusBlock}\n---\n${existing}`;
    await writeFileForce(configPath, content);
    return;
  }

  const fmBlock = fmMatch[2];
  const afterFrontmatter = existing.slice(fmMatch[0].length);

  // Remove existing statuses: block from frontmatter
  const statusesStart = fmBlock.match(/^statuses:\s*$/m);
  let cleanedFm: string;
  if (statusesStart) {
    const startIdx = fmBlock.indexOf(statusesStart[0]);
    const before = fmBlock.slice(0, startIdx);
    const after = fmBlock.slice(startIdx + statusesStart[0].length);
    // Skip all indented lines (belonging to statuses block)
    const remaining = after.split('\n');
    let endIdx = 0;
    for (let i = 0; i < remaining.length; i++) {
      const line = remaining[i];
      if (line.trim() === '') { endIdx = i + 1; continue; }
      if (line.length > 0 && line[0] !== ' ') break;
      endIdx = i + 1;
    }
    cleanedFm = before + remaining.slice(endIdx).join('\n');
  } else {
    cleanedFm = fmBlock;
  }

  // Trim trailing whitespace/newlines from cleaned frontmatter
  cleanedFm = cleanedFm.replace(/\n+$/, '');

  const newContent = `---\n${cleanedFm}\n${statusBlock}\n---${afterFrontmatter}`;
  await writeFileForce(configPath, newContent);
}

export async function deleteStatusConfig(): Promise<void> {
  const configPath = resolve(syntaurRoot(), 'config.md');
  if (!(await fileExists(configPath))) return;

  const existing = await readFile(configPath, 'utf-8');
  const fmMatch = existing.match(/^(---\n)([\s\S]*?)\n(---)/);
  if (!fmMatch) return;

  const fmBlock = fmMatch[2];
  const afterFrontmatter = existing.slice(fmMatch[0].length);
  const cleanedFm = stripTopLevelBlock(fmBlock, 'statuses');

  const newContent = `---\n${cleanedFm}\n---${afterFrontmatter}`;
  await writeFileForce(configPath, newContent);
}

/**
 * Parse the nested `search:` block from raw config.md content. Returns null when
 * absent (caller falls back to DEFAULT_SEARCH_CONFIG). Mirrors parseStatusConfig's
 * manual block walk: `defaultScope`/`externalIds` are scalars, `aliases:` is a
 * one-level prefix→kind map. Tolerant — invalid rows are dropped by
 * normalizeSearchConfig.
 */
/**
 * Parse the optional `staleness:` block into a partial `StaleThresholds`
 * (defaults-first — only keys present here override). Values are durations
 * (`7d`, `12h`, `30m`, `90s`, `500ms`) or bare ms numbers. Malformed/non-positive
 * values are dropped (the gate falls back to its default). Returns null when the
 * block is absent or yields no valid override.
 *
 *   staleness:
 *     inProgressNoActivity: 14d
 *     reviewAging: 2d
 */
export function parseStalenessConfig(content: string): Partial<StaleThresholds> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fmBlock = match[1];

  const blockStart = fmBlock.match(/^staleness:\s*$/m);
  if (!blockStart) return null;

  const startIdx = (blockStart.index ?? 0) + blockStart[0].length;
  const lines = fmBlock.slice(startIdx).split('\n');

  const out: Partial<StaleThresholds> = {};
  for (const line of lines) {
    if (line.trim() === '') continue;
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;
    if (indent === 0) break; // dedent out of the staleness: block
    const ci = trimmed.indexOf(':');
    if (ci <= 0) continue;
    const key = trimmed.slice(0, ci).trim();
    const field = STALENESS_KEY_TO_FIELD[key];
    if (!field) continue;
    let value = trimmed.slice(ci + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    const ms = parseDurationMs(value);
    if (ms !== null) out[field] = ms;
  }

  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Validate the raw `staleness:` block, returning a problem string per offending
 * entry (unknown key, or unparseable/non-positive duration). Empty array = OK
 * (including when the block is absent). The parser fails safe by dropping these
 * silently; this surfaces them in `syntaur doctor` so typos don't go unnoticed.
 */
export function validateStalenessConfig(content: string): string[] {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return [];
  const fmBlock = match[1];
  const blockStart = fmBlock.match(/^staleness:\s*$/m);
  if (!blockStart) return [];

  const startIdx = (blockStart.index ?? 0) + blockStart[0].length;
  const lines = fmBlock.slice(startIdx).split('\n');
  const problems: string[] = [];

  for (const line of lines) {
    if (line.trim() === '') continue;
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;
    if (indent === 0) break;
    const ci = trimmed.indexOf(':');
    if (ci <= 0) continue;
    const key = trimmed.slice(0, ci).trim();
    let value = trimmed.slice(ci + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in STALENESS_KEY_TO_FIELD)) {
      problems.push(`staleness.${key}: unknown key (expected one of ${Object.keys(STALENESS_KEY_TO_FIELD).join(', ')})`);
      continue;
    }
    if (parseDurationMs(value) === null) {
      problems.push(`staleness.${key}: "${value}" is not a positive duration (e.g. 7d, 12h, 30m, 90s, 500ms)`);
    }
  }
  return problems;
}

export function parseSearchConfig(content: string): SearchConfig | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fmBlock = match[1];

  const blockStart = fmBlock.match(/^search:\s*$/m);
  if (!blockStart) return null;

  // Use the regex match offset (NOT indexOf) — the literal text `search:` can
  // appear earlier inside another block's value (e.g. an AQL derive condition
  // `when: "search:foo"`), and indexOf would slice from there.
  const startIdx = (blockStart.index ?? 0) + blockStart[0].length;
  const lines = fmBlock.slice(startIdx).split('\n');

  const unquote = (v: string): string => {
    const t = v.trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1);
    }
    return t;
  };

  const raw: { defaultScope?: string; aliases?: Record<string, string>; externalIds?: boolean } = {};
  let inAliases = false;

  for (const line of lines) {
    if (line.trim() === '') continue;
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;
    if (indent === 0) break; // dedent out of the search: block

    if (indent <= 2) {
      inAliases = false;
      if (trimmed === 'aliases:') {
        inAliases = true;
        raw.aliases = {};
        continue;
      }
      const ci = trimmed.indexOf(':');
      if (ci <= 0) continue;
      const key = trimmed.slice(0, ci).trim();
      const value = unquote(trimmed.slice(ci + 1).trim());
      if (key === 'defaultScope') {
        raw.defaultScope = value;
      } else if (key === 'externalIds') {
        // Only recognize real booleans; anything else stays undefined so
        // normalizeSearchConfig falls back to the default (true).
        const v = value.toLowerCase();
        if (v === 'true') raw.externalIds = true;
        else if (v === 'false') raw.externalIds = false;
      }
    } else if (inAliases) {
      const ci = trimmed.indexOf(':');
      if (ci <= 0) continue;
      raw.aliases ??= {};
      raw.aliases[trimmed.slice(0, ci).trim()] = unquote(trimmed.slice(ci + 1).trim());
    }
  }

  return normalizeSearchConfig(raw);
}

/** Serialize a SearchConfig into the `search:` frontmatter block (no trailing newline). */
export function serializeSearchConfig(search: SearchConfig): string {
  const cfg = normalizeSearchConfig(search);
  const lines: string[] = ['search:'];
  lines.push(`  defaultScope: ${cfg.defaultScope}`);
  lines.push('  aliases:');
  for (const [prefix, kind] of Object.entries(cfg.aliases)) {
    lines.push(`    ${prefix}: ${kind}`);
  }
  lines.push(`  externalIds: ${cfg.externalIds ? 'true' : 'false'}`);
  return lines.join('\n');
}

export async function writeSearchConfig(search: SearchConfig): Promise<void> {
  const configPath = resolve(syntaurRoot(), 'config.md');
  const searchBlock = serializeSearchConfig(search);

  if (!(await fileExists(configPath))) {
    const content = `---\nversion: "2.0"\ndefaultProjectDir: ~/projects\n${searchBlock}\n---\n`;
    await writeFileForce(configPath, content);
    return;
  }

  const existing = await readFile(configPath, 'utf-8');
  const fmMatch = existing.match(/^(---\n)([\s\S]*?)\n(---)/);
  if (!fmMatch) {
    const content = `---\nversion: "2.0"\n${searchBlock}\n---\n${existing}`;
    await writeFileForce(configPath, content);
    return;
  }

  const fmBlock = fmMatch[2];
  const afterFrontmatter = existing.slice(fmMatch[0].length);
  const cleanedFm = stripTopLevelBlock(fmBlock, 'search');

  const newContent = `---\n${cleanedFm}\n${searchBlock}\n---${afterFrontmatter}`;
  await writeFileForce(configPath, newContent);
}

export async function deleteSearchConfig(): Promise<void> {
  const configPath = resolve(syntaurRoot(), 'config.md');
  if (!(await fileExists(configPath))) return;

  const existing = await readFile(configPath, 'utf-8');
  const fmMatch = existing.match(/^(---\n)([\s\S]*?)\n(---)/);
  if (!fmMatch) return;

  const fmBlock = fmMatch[2];
  const afterFrontmatter = existing.slice(fmMatch[0].length);
  const cleanedFm = stripTopLevelBlock(fmBlock, 'search');

  const newContent = `---\n${cleanedFm}\n---${afterFrontmatter}`;
  await writeFileForce(configPath, newContent);
}

/** The configured search settings, or the built-in defaults when unset. */
export function getSearchConfig(config: SyntaurConfig): SearchConfig {
  return config.searchConfig ?? DEFAULT_SEARCH_CONFIG;
}

export async function updateIntegrationConfig(
  integrations: Partial<IntegrationConfig>,
): Promise<void> {
  const configPath = resolve(syntaurRoot(), 'config.md');
  const nextIntegrations: IntegrationConfig = {
    ...(await readConfig()).integrations,
    ...integrations,
  };

  const integrationBlock = serializeIntegrationConfig(nextIntegrations);
  const existing = await fileExists(configPath)
    ? await readFile(configPath, 'utf-8')
    : renderConfig({ defaultProjectDir: defaultProjectDir() });

  const fmMatch = existing.match(/^(---\n)([\s\S]*?)\n(---)/);
  if (!fmMatch) {
    const content = `---\nversion: "2.0"\ndefaultProjectDir: ${defaultProjectDir()}\n${integrationBlock ?? ''}\n---\n${existing}`;
    await writeFileForce(configPath, content.replace(/\n\n---/, '\n---'));
    return;
  }

  const fmBlock = fmMatch[2];
  const afterFrontmatter = existing.slice(fmMatch[0].length);
  const cleanedFm = stripTopLevelBlock(fmBlock, 'integrations');
  const newFm = integrationBlock
    ? `${cleanedFm}\n${integrationBlock}`.replace(/^\n+/, '')
    : cleanedFm;
  const normalizedFm = newFm.replace(/\n+$/, '');
  const newContent = `---\n${normalizedFm}\n---${afterFrontmatter}`;
  await writeFileForce(configPath, newContent);
}

export async function updateOnboardingConfig(
  onboarding: Partial<OnboardingConfig>,
): Promise<void> {
  const configPath = resolve(syntaurRoot(), 'config.md');
  const nextOnboarding: OnboardingConfig = {
    ...(await readConfig()).onboarding,
    ...onboarding,
  };

  const onboardingBlock = serializeOnboardingConfig(nextOnboarding);
  const existing = await fileExists(configPath)
    ? await readFile(configPath, 'utf-8')
    : renderConfig({ defaultProjectDir: defaultProjectDir() });

  const fmMatch = existing.match(/^(---\n)([\s\S]*?)\n(---)/);
  if (!fmMatch) {
    const content = `---\nversion: "2.0"\ndefaultProjectDir: ${defaultProjectDir()}\n${onboardingBlock}\n---\n${existing}`;
    await writeFileForce(configPath, content.replace(/\n\n---/, '\n---'));
    return;
  }

  const fmBlock = fmMatch[2];
  const afterFrontmatter = existing.slice(fmMatch[0].length);
  const cleanedFm = stripTopLevelBlock(fmBlock, 'onboarding');
  const newFm = `${cleanedFm}\n${onboardingBlock}`.replace(/^\n+/, '');
  const normalizedFm = newFm.replace(/\n+$/, '');
  const newContent = `---\n${normalizedFm}\n---${afterFrontmatter}`;
  await writeFileForce(configPath, newContent);
}

export async function updateBackupConfig(
  backup: Partial<BackupConfig>,
): Promise<void> {
  const configPath = resolve(syntaurRoot(), 'config.md');
  const current = (await readConfig()).backup;
  const nextBackup: BackupConfig = {
    repo: current?.repo ?? null,
    categories: current?.categories ?? 'projects, playbooks, todos, servers, config',
    lastBackup: current?.lastBackup ?? null,
    lastRestore: current?.lastRestore ?? null,
    ...backup,
  };

  const backupBlock = serializeBackupConfig(nextBackup);
  const existing = await fileExists(configPath)
    ? await readFile(configPath, 'utf-8')
    : renderConfig({ defaultProjectDir: defaultProjectDir() });

  const fmMatch = existing.match(/^(---\n)([\s\S]*?)\n(---)/);
  if (!fmMatch) {
    const content = `---\nversion: "2.0"\ndefaultProjectDir: ${defaultProjectDir()}\n${backupBlock}\n---\n${existing}`;
    await writeFileForce(configPath, content.replace(/\n\n---/, '\n---'));
    return;
  }

  const fmBlock = fmMatch[2];
  const afterFrontmatter = existing.slice(fmMatch[0].length);
  const cleanedFm = stripTopLevelBlock(fmBlock, 'backup');
  const newFm = `${cleanedFm}\n${backupBlock}`.replace(/^\n+/, '');
  const normalizedFm = newFm.replace(/\n+$/, '');
  const newContent = `---\n${normalizedFm}\n---${afterFrontmatter}`;
  await writeFileForce(configPath, newContent);
}

// Guard so the legacy-config migration runs at most once per config path per
// process lifetime. Keyed by absolute path so tests with multiple sandbox
// HOMEs still get the migration applied to each.
const migratedConfigPaths = new Set<string>();

export async function readConfig(): Promise<SyntaurConfig> {
  const configPath = resolve(syntaurRoot(), 'config.md');
  if (!(await fileExists(configPath))) {
    return cloneDefaultConfig();
  }

  if (!migratedConfigPaths.has(configPath)) {
    migratedConfigPaths.add(configPath);
    await migrateLegacyConfig(configPath);
  }

  const content = await readFile(configPath, 'utf-8');
  const fm = parseFrontmatter(content);

  if (Object.keys(fm).length === 0) {
    console.warn('Warning: ~/.syntaur/config.md has malformed frontmatter, using defaults');
    return cloneDefaultConfig();
  }

  let projectDir = fm['defaultProjectDir']
    ? expandHome(String(fm['defaultProjectDir']))
    : DEFAULT_CONFIG.defaultProjectDir;
  if (!isAbsolute(projectDir)) {
    console.warn(
      `Warning: config.md defaultProjectDir is not an absolute path ("${fm['defaultProjectDir']}"), using default`,
    );
    projectDir = DEFAULT_CONFIG.defaultProjectDir;
  }

  const fmBlock = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';

  return {
    version: fm['version'] || DEFAULT_CONFIG.version,
    defaultProjectDir: projectDir,
    onboarding: {
      completed: fm['onboarding.completed'] === 'true',
    },
    agentDefaults: {
      trustLevel:
        (fm['agentDefaults.trustLevel'] as SyntaurConfig['agentDefaults']['trustLevel']) ||
        DEFAULT_CONFIG.agentDefaults.trustLevel,
      autoApprove:
        fm['agentDefaults.autoApprove'] === 'true' ||
        DEFAULT_CONFIG.agentDefaults.autoApprove,
      autoCreateWorktree: AUTO_CREATE_WORKTREE_VALUES.includes(
        fm['agentDefaults.autoCreateWorktree'] as AutoCreateWorktree,
      )
        ? (fm['agentDefaults.autoCreateWorktree'] as AutoCreateWorktree)
        : DEFAULT_CONFIG.agentDefaults.autoCreateWorktree,
    },
    session: {
      autoTrack: SESSION_AUTO_TRACK_VALUES.includes(
        fm['session.autoTrack'] as SessionAutoTrack,
      )
        ? (fm['session.autoTrack'] as SessionAutoTrack)
        : DEFAULT_CONFIG.session.autoTrack,
    },
    integrations: {
      claudePluginDir: parseOptionalAbsolutePath(
        fm['integrations.claudePluginDir'],
        'integrations.claudePluginDir',
      ),
      codexPluginDir: parseOptionalAbsolutePath(
        fm['integrations.codexPluginDir'],
        'integrations.codexPluginDir',
      ),
      codexMarketplacePath: parseOptionalAbsolutePath(
        fm['integrations.codexMarketplacePath'],
        'integrations.codexMarketplacePath',
      ),
      ...parseInstalledAgents(fm),
    },
    backup: fm['backup.repo'] || fm['backup.categories']
      ? {
          repo: fm['backup.repo'] && fm['backup.repo'] !== 'null' ? fm['backup.repo'] : null,
          categories: fm['backup.categories'] || 'projects, playbooks, todos, servers, config',
          lastBackup: fm['backup.lastBackup'] && fm['backup.lastBackup'] !== 'null' ? fm['backup.lastBackup'] : null,
          lastRestore: fm['backup.lastRestore'] && fm['backup.lastRestore'] !== 'null' ? fm['backup.lastRestore'] : null,
        }
      : null,
    statuses: parseStatusConfig(content),
    types: null,
    agents: normalizeAgentsFromConfig(parseAgentsConfig(content)),
    playbooks: parsePlaybooksConfig(fmBlock),
    theme: parseThemeConfig(content),
    hotkeys: parseHotkeyBindingsConfig(content),
    terminal: (() => {
      try {
        return parseTerminalConfig(fm['terminal']);
      } catch (err) {
        const msg = err instanceof TerminalConfigError ? err.message : String(err);
        console.warn(`Warning: ${msg} — falling back to default`);
        return null;
      }
    })(),
    searchConfig: parseSearchConfig(content),
    workspaceVisibility: parseWorkspaceVisibilityConfig(fmBlock),
    staleness: parseStalenessConfig(content),
  };
}

export function getAssignmentTypes(config: SyntaurConfig): TypesConfig {
  return config.types ?? DEFAULT_ASSIGNMENT_TYPES;
}

export function getAgents(config: SyntaurConfig): AgentConfig[] {
  if (config.agents === null) return BUILTIN_AGENTS;
  // For agents whose id matches any builtin (claude/codex/pi/openclaw/hermes),
  // inherit that builtin's resume/fork for whichever the user omitted. Builtins
  // without a recipe (openclaw/hermes) have nothing to inherit, so an omitted
  // field stays omitted. Omission means "inherit", not
  // "disable": there is no syntax to express intentional disable, and the
  // dashboard agent editor (api-agents coerceAgentRow) silently drops these
  // fields, so omission is frequently accidental. User-provided values win;
  // non-builtin agents pass through untouched. Inputs are never mutated.
  const builtinById = new Map(BUILTIN_AGENTS.map((a) => [a.id, a]));
  return config.agents.map((agent) => {
    const builtin = builtinById.get(agent.id);
    if (!builtin) return agent;
    const resume = agent.resume ?? builtin.resume;
    const fork = agent.fork ?? builtin.fork;
    if (resume === agent.resume && fork === agent.fork) return agent;
    return {
      ...agent,
      ...(resume ? { resume } : {}),
      ...(fork ? { fork } : {}),
    };
  });
}

export class TerminalConfigError extends Error {}

/**
 * Parse the `terminal:` scalar from raw frontmatter values.
 * Returns null when the key is absent (caller falls back to platform default).
 * Throws TerminalConfigError when the value is not a known choice.
 */
export function parseTerminalConfig(value: unknown): TerminalChoice | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new TerminalConfigError(
      `terminal must be a string — got ${typeof value}`,
    );
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!TERMINAL_CHOICES.includes(trimmed as TerminalChoice)) {
    throw new TerminalConfigError(
      `terminal "${trimmed}" is not a known choice — expected one of ${TERMINAL_CHOICES.join('|')}`,
    );
  }
  return trimmed as TerminalChoice;
}

/**
 * Return the configured terminal, or the platform default when unset.
 *
 * darwin → terminal-app (always available).
 * linux  → first of [kitty, alacritty, warp] resolvable via `which`, in that
 *          order. If none are installed, return terminal-app as a stable
 *          sentinel (doctor will surface the install gap separately).
 * other  → terminal-app sentinel.
 *
 * The Linux probe order is intentionally deterministic and documented so the
 * dashboard's preflight + the Settings hint show the same value.
 */
export function getTerminal(config: SyntaurConfig): TerminalChoice {
  if (config.terminal) return config.terminal;
  if (process.platform === 'darwin') return 'terminal-app';
  if (process.platform === 'linux') {
    const order: TerminalChoice[] = ['kitty', 'alacritty', 'warp'];
    for (const candidate of order) {
      const result = spawnSync('which', [candidate], { encoding: 'utf-8' });
      if (result.status === 0 && result.stdout.trim().length > 0) {
        return candidate;
      }
    }
  }
  return 'terminal-app';
}

export interface AgentsMutation {
  kind: 'add' | 'remove' | 'set' | 'reorder';
  apply: (current: AgentConfig[]) => AgentConfig[];
}

/**
 * Apply a mutation to the agents list, validate, and either write or return the
 * proposed new list (for --dry-run). Always runs full validation.
 */
export async function updateAgentsConfig(
  mutation: AgentsMutation,
  options: { dryRun?: boolean } = {},
): Promise<{ previous: AgentConfig[]; next: AgentConfig[]; written: boolean }> {
  const config = await readConfig();
  const previous = config.agents ?? [...BUILTIN_AGENTS];
  const next = mutation.apply(previous);
  validateAgentList(next);

  if (options.dryRun) {
    return { previous, next, written: false };
  }

  await writeAgentsConfig(next);
  return { previous, next, written: true };
}
