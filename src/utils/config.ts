import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { syntaurRoot, defaultProjectDir, expandHome } from './paths.js';
import { fileExists, writeFileForce } from './fs.js';
import { renderConfig } from '../templates/config.js';
import { migrateLegacyConfig } from './fs-migration.js';

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

export interface StatusConfig {
  statuses: StatusDefinition[];
  order: string[];
  transitions: StatusTransition[];
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

export type PromptArgPosition = 'first' | 'last' | 'none';

export interface AgentConfig {
  id: string;
  label: string;
  command: string;
  args?: string[];
  promptArgPosition?: PromptArgPosition;
  default?: boolean;
  resolveFromShellAliases?: boolean;
}

export type AutoCreateWorktree = 'skip' | 'ask' | 'always';

export interface PlaybooksConfig {
  disabled: string[];
}

export interface ThemeConfig {
  preset: string;
}

export interface SyntaurConfig {
  version: string;
  defaultProjectDir: string;
  onboarding: OnboardingConfig;
  agentDefaults: {
    trustLevel: 'low' | 'medium' | 'high';
    autoApprove: boolean;
    autoCreateWorktree: AutoCreateWorktree;
  };
  integrations: IntegrationConfig;
  backup: BackupConfig | null;
  statuses: StatusConfig | null;
  types: TypesConfig | null;
  agents: AgentConfig[] | null;
  playbooks: PlaybooksConfig;
  theme: ThemeConfig | null;
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
};

export const BUILTIN_AGENTS: AgentConfig[] = [
  { id: 'claude', label: 'Claude', command: 'claude', default: true },
  { id: 'codex', label: 'Codex', command: 'codex' },
];

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const PROMPT_ARG_POSITIONS: readonly PromptArgPosition[] = ['first', 'last', 'none'];
const AUTO_CREATE_WORKTREE_VALUES: readonly AutoCreateWorktree[] = ['skip', 'ask', 'always'];

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
    if (agent.default) defaults++;
  }
  if (defaults > 1) {
    throw new AgentConfigError(
      `more than one agent is marked default: true (only one is allowed)`,
    );
  }
}

function cloneDefaultConfig(): SyntaurConfig {
  return {
    ...DEFAULT_CONFIG,
    onboarding: { ...DEFAULT_CONFIG.onboarding },
    agentDefaults: { ...DEFAULT_CONFIG.agentDefaults },
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
        }))
      : null,
    playbooks: {
      disabled: [...DEFAULT_CONFIG.playbooks.disabled],
    },
    theme: DEFAULT_CONFIG.theme ? { ...DEFAULT_CONFIG.theme } : null,
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

function parseStatusConfig(content: string): StatusConfig | null {
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

  // Parse sub-sections: definitions, order, transitions
  let currentSection: 'definitions' | 'order' | 'transitions' | null = null;
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
  }

  if (statuses.length === 0) return null;

  return {
    statuses,
    order: order.length > 0 ? order : statuses.map((s) => s.id),
    transitions,
  };
}

function serializeStatusConfig(statuses: StatusConfig): string {
  const lines: string[] = [];
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

function stripTopLevelBlock(fmBlock: string, key: string): string {
  const blockStart = fmBlock.match(new RegExp(`^${key}:\\s*$`, 'm'));
  if (!blockStart) {
    return fmBlock.replace(/\n+$/, '');
  }

  const startIdx = fmBlock.indexOf(blockStart[0]);
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
    });
    current = null;
    argsCapture = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    if (indent === 0 && trimmed !== '' && !trimmed.startsWith('#')) {
      break; // new top-level key
    }

    if (argsCapture) {
      if (indent > argsBaseIndent && trimmed.startsWith('- ')) {
        argsCapture.push(decodeYamlScalar(trimmed.slice(2).trim()));
        continue;
      } else {
        argsCapture = null;
        if (current) current.args = (current.args ?? []);
      }
    }

    if (indent === 2 && trimmed.startsWith('- ')) {
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
      assignAgentField(current, k, v);
    }
  }
  flushCurrent();

  if (agents.length === 0) return [];
  return agents;
}

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
  }
  return lines.join('\n');
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
  };
}

export function getAssignmentTypes(config: SyntaurConfig): TypesConfig {
  return config.types ?? DEFAULT_ASSIGNMENT_TYPES;
}

export function getAgents(config: SyntaurConfig): AgentConfig[] {
  return config.agents ?? BUILTIN_AGENTS;
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
