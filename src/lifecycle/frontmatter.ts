import type { AssignmentFrontmatter, ExternalId, Workspace } from './types.js';

function extractFrontmatter(fileContent: string): [string, string] {
  const match = fileContent.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error('No frontmatter found in file. Expected --- delimiters.');
  }
  const frontmatterBlock = match[1];
  const body = fileContent.slice(match[0].length);
  return [frontmatterBlock, body];
}

function parseSimpleValue(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === 'null') return null;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseDependsOn(frontmatter: string): string[] {
  const inlineMatch = frontmatter.match(/^dependsOn:\s*\[\s*\]/m);
  if (inlineMatch) return [];

  const results: string[] = [];
  const blockMatch = frontmatter.match(/^dependsOn:\s*\n((?:\s+-\s+.*\n?)*)/m);
  if (blockMatch) {
    const items = blockMatch[1].matchAll(/^\s+-\s+(.+)$/gm);
    for (const item of items) {
      results.push(item[1].trim());
    }
  }
  return results;
}

function parseExternalIds(frontmatter: string): ExternalId[] {
  const inlineMatch = frontmatter.match(/^externalIds:\s*\[\s*\]/m);
  if (inlineMatch) return [];

  const results: ExternalId[] = [];
  const blockMatch = frontmatter.match(
    /^externalIds:\s*\n((?:\s+-\s+[\s\S]*?)(?=^\w|\n---))/m,
  );
  if (!blockMatch) return [];

  const itemBlocks = blockMatch[1].split(/\n\s+-\s+/).filter(Boolean);
  for (const block of itemBlocks) {
    const lines = block.split('\n');
    const entry: Record<string, string> = {};
    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx < 0) continue;
      const key = line.slice(0, colonIdx).trim().replace(/^-\s+/, '');
      const value = line.slice(colonIdx + 1).trim();
      if (key && value) {
        entry[key] = value;
      }
    }
    if (entry['system'] && entry['id'] && entry['url']) {
      results.push({
        system: entry['system'],
        id: entry['id'],
        url: entry['url'],
      });
    }
  }
  return results;
}

function parseWorkspace(frontmatter: string): Workspace {
  const defaults: Workspace = {
    repository: null,
    worktreePath: null,
    branch: null,
    parentBranch: null,
  };

  const fields = ['repository', 'worktreePath', 'branch', 'parentBranch'] as const;
  for (const field of fields) {
    const match = frontmatter.match(new RegExp(`^\\s+${field}:\\s*(.*)$`, 'm'));
    if (match) {
      defaults[field] = parseSimpleValue(match[1]);
    }
  }
  return defaults;
}

function parseTags(frontmatter: string): string[] {
  const inlineMatch = frontmatter.match(/^tags:\s*\[\s*\]/m);
  if (inlineMatch) return [];

  const results: string[] = [];
  const blockMatch = frontmatter.match(/^tags:\s*\n((?:\s+-\s+.*\n?)*)/m);
  if (blockMatch) {
    const items = blockMatch[1].matchAll(/^\s+-\s+(.+)$/gm);
    for (const item of items) {
      results.push(item[1].trim());
    }
  }
  return results;
}

export function parseAssignmentFrontmatter(fileContent: string): AssignmentFrontmatter {
  const [frontmatter] = extractFrontmatter(fileContent);

  function getField(key: string): string | null {
    const match = frontmatter.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
    if (!match) return null;
    return parseSimpleValue(match[1]);
  }

  return {
    id: getField('id') ?? '',
    slug: getField('slug') ?? '',
    title: getField('title') ?? '',
    status: getField('status') ?? 'pending',
    priority: (getField('priority') ?? 'medium') as AssignmentFrontmatter['priority'],
    created: getField('created') ?? '',
    updated: getField('updated') ?? '',
    assignee: getField('assignee'),
    externalIds: parseExternalIds(frontmatter),
    dependsOn: parseDependsOn(frontmatter),
    blockedReason: getField('blockedReason'),
    workspace: parseWorkspace(frontmatter),
    tags: parseTags(frontmatter),
  };
}

function formatYamlValue(value: string | null): string {
  if (value === null) return 'null';
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return `"${value}"`;
  }
  // Quote values containing YAML-special characters that could cause parse issues
  if (/[:#{}[\],&*?|>!%@`]/.test(value) || /^\s|\s$/.test(value) || value === '') {
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return value;
}

export function updateAssignmentFile(
  fileContent: string,
  updates: Partial<Pick<AssignmentFrontmatter, 'status' | 'assignee' | 'blockedReason' | 'updated'>>,
): string {
  let result = fileContent;

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    const formatted = formatYamlValue(value as string | null);
    const fieldRegex = new RegExp(`^(${key}:)\\s*.*$`, 'm');
    if (fieldRegex.test(result)) {
      result = result.replace(fieldRegex, `$1 ${formatted}`);
    }
  }

  return result;
}
