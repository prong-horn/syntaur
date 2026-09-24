import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, isAbsolute } from 'node:path';
import { syntaurRoot, defaultProjectDir, expandHome } from './paths.js';
import { fileExists, writeFileForce } from './fs.js';
import { renderConfig } from '../templates/config.js';
import { migrateLegacyConfig } from './fs-migration.js';
import {
  BINDABLE_ACTION_KINDS,
  canonicalizeCombo,
  isBindableActionKind,
  isReservedCombo,
  type BindableActionKind,
} from './hotkeysCatalog.js';
import { isValidSlug } from './slug.js';

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

import type { StaleThresholds } from '../staleness/classify.js';

const REMOVED_IN_V2 = 'removed in v2';

/** @deprecated v2 — derive rules are no longer config-driven. */
export interface PhaseRung {
  phase: string;
  when: string;
  next?: string;
}

/** @deprecated v2 — derive rules are no longer config-driven. */
export interface DispositionRule {
  when: string | null;
  is: string;
}

/** @deprecated v2 — derive rules are no longer config-driven. */
export interface HeadlineProjection {
  terminal: string;
  parked: string;
  blocked: string;
  active: string;
}

export function validateDeriveConfig(_config: unknown): string[] {
  throw new Error(REMOVED_IN_V2);
}

export function validateDeriveShape(_raw: unknown): string[] {
  throw new Error(REMOVED_IN_V2);
}

/** @deprecated v2 — custom facts removed. */
export type RawFactDeclaration = { name: string; type: string; binds: string | null };

/** @deprecated v2 — custom facts removed. */
export type FactDeclaration = RawFactDeclaration;

export function validateFactDeclarations(_facts: RawFactDeclaration[]): string[] {
  throw new Error(REMOVED_IN_V2);
}

export function normalizeFactDeclarations(_facts: RawFactDeclaration[]): FactDeclaration[] {
  throw new Error(REMOVED_IN_V2);
}

/** @deprecated v2 — stage engine routes are template-driven, not config-driven. */
export const ROUTE_TRIGGERS: readonly string[] = [];

export type RouteTrigger = string;
export type StageCheck = unknown;
export type StageRoute = unknown;
export type StageWork = unknown;
export type WorkflowStage = unknown;
export type WorkflowFlag = unknown;
export type WorkflowFlags = unknown;
export type StageWorkflow = unknown;

export const DEFAULT_STATUS_COLORS: Record<string, string> = {};

export function toTitleCase(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function buildDefaultStatusConfig(): StatusConfig {
  throw new Error(REMOVED_IN_V2);
}

/** Config keys for the `staleness:` block → `StaleThresholds` ms fields. Keyed
 * on the contradiction (phase/disposition), not raw status ids. */
const STALENESS_KEY_TO_FIELD: Record<string, keyof StaleThresholds> = {
  inProgressNoActivity: 'inProgressNoActivityMs',
  readyUnclaimed: 'readyUnclaimedMs',
  reviewAging: 'reviewAgingMs',
  blockedAging: 'blockedAgingMs',
  planAging: 'planApprovalAgingMs',
};

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/;
const DURATION_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * `session.idleSweepHours` — finite and > 0, else the default. Mirrors the
 * finite-guard in `parseDurationMs` below.
 */
function parseIdleSweepHours(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_CONFIG.session.idleSweepHours;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CONFIG.session.idleSweepHours;
}

/** Parse a duration like `7d`/`12h`/`30m`/`90s`/`500ms` (or a bare number = ms)
 * to milliseconds. Returns null when malformed or non-positive. */
export function parseDurationMs(raw: string): number | null {
  const m = raw.trim().match(DURATION_RE);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n * DURATION_UNIT_MS[m[2] ?? 'ms'];
}

export interface StatusConfig {
  statuses: StatusDefinition[];
  order: string[];
  transitions: StatusTransition[];
  /** Custom-fact declarations (raw — see {@link RawFactDeclaration}). Persisted
   * under `statuses.facts`; preserved verbatim so invalid rows round-trip and
   * doctor can diagnose them. Null/absent → no custom vocabulary. */
  facts?: RawFactDeclaration[] | null;
}

/**
 * A named lifecycle workflow: a full {@link StatusConfig} bundle
 * (`definitions`/`order`/`transitions`/`derive`/`facts`) plus a human `label`.
 * Workflows live in a global library (`config.md` → `workflows: { <id>: … }`)
 * referenced by id; the legacy top-level `statuses:` block reads as the
 * built-in `default` workflow (see {@link parseWorkflowsConfig}).
 */
export interface WorkflowDefinition extends StatusConfig {
  label: string;
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

/**
 * Automatic session tracking scope:
 * - `all`: every discovered/hooked session is written to the sessions DB.
 * - `workspaces-only`: only sessions whose cwd has `.syntaur/context.json`.
 * - `off`: no automatic DB writes (manual `track-session` still works).
 */
export type SessionAutoTrack = 'all' | 'workspaces-only' | 'off';

/** Which backend generates session auto-summaries. */
export type SummarizeBackendName = 'claude' | 'pi';

/**
 * Master switch for automatic session summarization, which runs on the
 * dashboard's discovery interval — turning it off guarantees no background LLM
 * spend.
 */
export type SessionAutoSummarize = 'on' | 'off';


export interface SyntaurConfig {
  version: string;
  defaultProjectDir: string;
  agentDefaults: {
    trustLevel: 'low' | 'medium' | 'high';
    autoApprove: boolean;
    autoCreateWorktree: AutoCreateWorktree;
  };
  session: {
    autoTrack: SessionAutoTrack;
    summarizeBackend: SummarizeBackendName;
    autoSummarize: SessionAutoSummarize;
    /** Hours a session's transcript may sit idle before the scanner's
     *  Agent-View keep-alive expires and the row is swept `stopped`. */
    idleSweepHours: number;
  };
  statuses: StatusConfig | null;
  /** Global library of named lifecycle workflows, referenced by id. Absent →
   * the legacy single `statuses:` lifecycle is the built-in `default` workflow.
   * @see resolveWorkflowId */
  workflows?: Record<string, WorkflowDefinition> | null;
  /** Global fallback workflow id (last rung of binding resolution). Absent →
   * `'default'`. */
  defaultWorkflow?: string | null;
  playbooks: PlaybooksConfig;
  theme: ThemeConfig | null;
  hotkeys: HotkeyBindingsConfig | null;
  terminal: TerminalChoice | null;
  searchConfig: SearchConfig | null;
  /** Optional per-reason staleness age-gate overrides (defaults-first; null = all defaults). */
  staleness: Partial<StaleThresholds> | null;
  /** Opt-in: run the read-only staleness watchdog on the dashboard loop (emits
   * staleness-detected/cleared audit events; never mutates status). Off by default. */
  stalenessWatchdog: boolean;
  /** Default cwd for a standalone claude-agent launch (null → home at launch). */
  standaloneDefaultCwd: string | null;
}

const DEFAULT_CONFIG: SyntaurConfig = {
  version: '2.0',
  get defaultProjectDir() {
    return defaultProjectDir();
  },
  agentDefaults: {
    trustLevel: 'medium',
    autoApprove: false,
    autoCreateWorktree: 'ask',
  },
  session: {
    autoTrack: 'all',
    summarizeBackend: 'claude',
    autoSummarize: 'on',
    idleSweepHours: 6,
  },
  statuses: null,
  workflows: null,
  defaultWorkflow: null,
  playbooks: {
    disabled: [],
  },
  theme: null,
  hotkeys: null,
  terminal: null,
  searchConfig: null,
  staleness: null,
  stalenessWatchdog: false,
  standaloneDefaultCwd: null,
};

const AUTO_CREATE_WORKTREE_VALUES: readonly AutoCreateWorktree[] = ['skip', 'ask', 'always'];

const SESSION_AUTO_TRACK_VALUES: readonly SessionAutoTrack[] = ['all', 'workspaces-only', 'off'];

const SUMMARIZE_BACKEND_VALUES: readonly SummarizeBackendName[] = ['claude', 'pi'];

const SESSION_AUTO_SUMMARIZE_VALUES: readonly SessionAutoSummarize[] = ['on', 'off'];






function cloneDefaultConfig(): SyntaurConfig {
  return {
    ...DEFAULT_CONFIG,
    agentDefaults: { ...DEFAULT_CONFIG.agentDefaults },
    session: { ...DEFAULT_CONFIG.session },
    statuses: null,
    workflows: null,
    playbooks: {
      disabled: [...DEFAULT_CONFIG.playbooks.disabled],
    },
    theme: DEFAULT_CONFIG.theme ? { ...DEFAULT_CONFIG.theme } : null,
    hotkeys: DEFAULT_CONFIG.hotkeys
      ? { bindings: { ...DEFAULT_CONFIG.hotkeys.bindings } }
      : null,
    terminal: DEFAULT_CONFIG.terminal,
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

export function parseStatusConfig(_content: string): StatusConfig | null {
  return null;
}

export function parseWorkflowsConfig(
  _content: string,
): Record<string, WorkflowDefinition> | null {
  return null;
}

export function serializeStatusConfig(_statuses: StatusConfig): string {
  throw new Error(REMOVED_IN_V2);
}

export function serializeWorkflowsConfig(
  _workflows: Record<string, WorkflowDefinition>,
): string {
  throw new Error(REMOVED_IN_V2);
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
 * Remove any top-level `key: <value>` scalar line from a YAML frontmatter block.
 * Used for scalar keys that don't have child lines, so they can't use the
 * block-style `stripTopLevelBlock`. No-op when the key is absent.
 */
export function stripTopLevelScalar(fmBlock: string, key: string): string {
  const lines = fmBlock.split('\n');
  const keyRegex = new RegExp(`^${key}:\\s*\\S`);
  const filtered = lines.filter((line) => !keyRegex.test(line));
  return filtered.join('\n').replace(/\n+$/, '');
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

export function stripTopLevelBlock(fmBlock: string, key: string): string {
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

/** Retired config.md frontmatter keys removed by `syntaur migrate cleanup`. */
export const RETIRED_CONFIG_KEYS = [
  'agents',
  'agentDiscovery',
  'backup',
  'statuses',
  'workflows',
] as const;

function fmBlockContainsKey(fmBlock: string, key: string): boolean {
  if (new RegExp(`^${key}:\\s*$`, 'm').test(fmBlock)) return true;
  if (new RegExp(`^${key}:[ \\t]*\\S`, 'm').test(fmBlock)) return true;
  return false;
}

function stripKeyFromFrontmatter(fmBlock: string, key: string): string {
  let next = stripTopLevelBlock(fmBlock, key);
  const inlineRegex = new RegExp(`^${key}:[ \\t]*\\S.*$`, 'm');
  next = next
    .split('\n')
    .filter((line) => !inlineRegex.test(line))
    .join('\n')
    .replace(/\n+$/, '');
  return next;
}

/**
 * Remove retired top-level keys from config.md frontmatter (block and inline forms).
 * Body after the closing `---` is unchanged.
 */
export function removeRetiredConfigKeys(
  content: string,
  keys: readonly string[] = RETIRED_CONFIG_KEYS,
): { content: string; removed: string[] } {
  const fmMatch = content.match(/^(---\n)([\s\S]*?)\n(---)/);
  if (!fmMatch) return { content, removed: [] };

  let fmBlock = fmMatch[2];
  const removed: string[] = [];
  for (const key of keys) {
    if (!fmBlockContainsKey(fmBlock, key)) continue;
    const next = stripKeyFromFrontmatter(fmBlock, key);
    if (next !== fmBlock) {
      removed.push(key);
      fmBlock = next;
    }
  }

  if (removed.length === 0) return { content, removed: [] };
  const afterFrontmatter = content.slice(fmMatch[0].length);
  const newContent = `---\n${fmBlock}\n---${afterFrontmatter}`;
  return { content: newContent, removed };
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


function yamlQuoteScalar(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(
      `value contains newlines, which the config serializer does not support: ${JSON.stringify(value)}`,
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





/** @deprecated v2 — legacy workflow writers removed. */
export class LegacyWorkflowWriteLockedError extends Error {
  constructor() {
    super(REMOVED_IN_V2);
    this.name = 'LegacyWorkflowWriteLockedError';
  }
}

export async function writeStatusConfig(_statuses: StatusConfig): Promise<void> {
  throw new Error(REMOVED_IN_V2);
}

export async function deleteStatusConfig(): Promise<void> {
  throw new Error(REMOVED_IN_V2);
}

export async function writeWorkflowsConfig(
  _workflows: Record<string, WorkflowDefinition>,
  _defaultWorkflow: string,
): Promise<void> {
  throw new Error(REMOVED_IN_V2);
}

export async function deleteWorkflowsConfig(): Promise<void> {
  throw new Error(REMOVED_IN_V2);
}

export async function writeDefaultWorkflowScalar(_defaultWorkflow: string): Promise<void> {
  throw new Error(REMOVED_IN_V2);
}

export async function deleteLegacyStatusesBlock(): Promise<void> {
  throw new Error(REMOVED_IN_V2);
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
      summarizeBackend: SUMMARIZE_BACKEND_VALUES.includes(
        fm['session.summarizeBackend'] as SummarizeBackendName,
      )
        ? (fm['session.summarizeBackend'] as SummarizeBackendName)
        : DEFAULT_CONFIG.session.summarizeBackend,
      autoSummarize: SESSION_AUTO_SUMMARIZE_VALUES.includes(
        fm['session.autoSummarize'] as SessionAutoSummarize,
      )
        ? (fm['session.autoSummarize'] as SessionAutoSummarize)
        : DEFAULT_CONFIG.session.autoSummarize,
      // The only numeric key in this block — the three siblings are enums. Guard
      // the VALUE (finite and positive), not the key: a zero/negative/NaN
      // threshold would sweep every active row on the next scan.
      idleSweepHours: parseIdleSweepHours(fm['session.idleSweepHours']),
    },
    statuses: null,
    workflows: null,
    defaultWorkflow: fm['defaultWorkflow'] ? String(fm['defaultWorkflow']) : null,
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
    staleness: parseStalenessConfig(content),
    stalenessWatchdog: String(fm['stalenessWatchdog']).toLowerCase() === 'true',
    standaloneDefaultCwd: parseOptionalAbsolutePath(
      fm['standaloneDefaultCwd'],
      'standaloneDefaultCwd',
    ),
  };
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


