import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { syntaurRoot, defaultProjectDir, expandHome } from './paths.js';
import { fileExists, writeFileForce } from './fs.js';
import { renderConfig } from '../templates/config.js';

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

export interface SyntaurConfig {
  version: string;
  defaultProjectDir: string;
  onboarding: OnboardingConfig;
  agentDefaults: {
    trustLevel: 'low' | 'medium' | 'high';
    autoApprove: boolean;
  };
  integrations: IntegrationConfig;
  backup: BackupConfig | null;
  statuses: StatusConfig | null;
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
  },
  integrations: {
    claudePluginDir: null,
    codexPluginDir: null,
    codexMarketplacePath: null,
  },
  backup: null,
  statuses: null,
};

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

export async function readConfig(): Promise<SyntaurConfig> {
  const configPath = resolve(syntaurRoot(), 'config.md');
  if (!(await fileExists(configPath))) {
    return { ...DEFAULT_CONFIG };
  }
  const content = await readFile(configPath, 'utf-8');
  const fm = parseFrontmatter(content);

  if (Object.keys(fm).length === 0) {
    console.warn('Warning: ~/.syntaur/config.md has malformed frontmatter, using defaults');
    return { ...DEFAULT_CONFIG };
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
  };
}
