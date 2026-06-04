/**
 * Generic frontmatter/markdown parser for all Syntaur file types.
 * Pattern copied from src/lifecycle/frontmatter.ts:3-23 (extractFrontmatter + parseSimpleValue).
 */

import type { StatusHistoryEntry } from '../lifecycle/types.js';

export interface ParsedFile {
  frontmatter: Record<string, string>;
  body: string;
}

/**
 * Split a markdown file into its frontmatter block and body.
 */
export function extractFrontmatter(fileContent: string): [string, string] {
  const match = fileContent.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return ['', fileContent];
  }
  const frontmatterBlock = match[1];
  const body = fileContent.slice(match[0].length).trim();
  return [frontmatterBlock, body];
}

/**
 * Parse a simple YAML value, handling null and quoted strings.
 */
function parseSimpleValue(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === 'null' || trimmed === '~' || trimmed === '') return null;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Extract a top-level scalar field from frontmatter text.
 */
export function getField(frontmatter: string, key: string): string | null {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  if (!match) return null;
  return parseSimpleValue(match[1]);
}

/**
 * Extract an indented scalar field (one level deep) from frontmatter text.
 */
export function getNestedField(frontmatter: string, parent: string, key: string): string | null {
  const parentRegex = new RegExp(`^${parent}:\\s*\\n((?:\\s+.*\\n?)*)`, 'm');
  const parentMatch = frontmatter.match(parentRegex);
  if (!parentMatch) return null;
  const block = parentMatch[1];
  const fieldMatch = block.match(new RegExp(`^\\s+${key}:\\s*(.*)$`, 'm'));
  if (!fieldMatch) return null;
  return parseSimpleValue(fieldMatch[1]);
}

/**
 * Parse a YAML list field (e.g., tags, dependsOn, relatedAssignments).
 *
 * Supports the empty inline form `field: []` and the block-list form
 * `field:\n  - a\n  - b`. Does NOT support populated inline arrays
 * (`field: [a, b]`). List items are returned as raw trimmed text; callers
 * that expect quoted-string entries should pass each item through
 * {@link unquoteYamlString}.
 */
function parseListField(frontmatter: string, fieldName: string): string[] {
  const inlineMatch = frontmatter.match(new RegExp(`^${fieldName}:\\s*\\[\\s*\\]`, 'm'));
  if (inlineMatch) return [];

  const results: string[] = [];
  const blockMatch = frontmatter.match(
    new RegExp(`^${fieldName}:\\s*\\n((?:\\s+-\\s+.*\\n?)*)`, 'm'),
  );
  if (blockMatch) {
    let item: RegExpExecArray | null;
    const regex = /^\s+-\s+(.+)$/gm;
    while ((item = regex.exec(blockMatch[1])) !== null) {
      results.push(item[1].trim());
    }
  }
  return results;
}

/**
 * Strip a paired surrounding `"..."` or `'...'` from a YAML scalar.
 * Mirrors `parseSimpleValue`'s quote handling for list-item entries (which
 * `parseListField` leaves raw).
 */
function unquoteYamlString(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

// --- Project Parser ---

export interface ParsedProject {
  id: string;
  slug: string;
  title: string;
  archived: boolean;
  archivedAt: string | null;
  archivedReason: string | null;
  statusOverride: string | null;
  created: string;
  updated: string;
  tags: string[];
  workspace: string | null;
  /**
   * Repositories the project spans. Empty array when the field is absent —
   * existing project.md files predate this field, so callers must treat
   * missing as `[]`. Paths with YAML-special characters (spaces, colons,
   * leading dashes) must be quoted in source; quotes are stripped here.
   */
  repositories: string[];
  externalIds: Array<{ system: string; id: string; url: string | null }>;
  body: string;
}

export function parseProject(fileContent: string): ParsedProject {
  const [fm, body] = extractFrontmatter(fileContent);
  // Legacy alias: pre-v0.2.0 installs used `mission` as the slug key. The
  // fs-migration helper renames the file but doesn't rewrite user-owned
  // frontmatter. Accept either key.
  const slug = getField(fm, 'slug') ?? getField(fm, 'mission') ?? '';
  return {
    id: getField(fm, 'id') ?? '',
    slug,
    title: getField(fm, 'title') ?? '',
    archived: getField(fm, 'archived') === 'true',
    archivedAt: getField(fm, 'archivedAt'),
    archivedReason: getField(fm, 'archivedReason'),
    statusOverride: getField(fm, 'statusOverride'),
    created: getField(fm, 'created') ?? '',
    updated: getField(fm, 'updated') ?? '',
    tags: parseListField(fm, 'tags'),
    workspace: getField(fm, 'workspace'),
    repositories: parseListField(fm, 'repositories').map(unquoteYamlString),
    externalIds: parseExternalIds(fm),
    body,
  };
}

// --- Status Parser (for _status.md) ---

export interface ParsedStatus {
  project: string;
  status: string;
  progress: Record<string, number> & { total: number };
  needsAttention: {
    blockedCount: number;
    failedCount: number;
    openQuestions: number;
  };
  body: string;
}

export function parseStatus(fileContent: string): ParsedStatus {
  const [fm, body] = extractFrontmatter(fileContent);

  // Dynamically parse progress fields
  const progress: Record<string, number> & { total: number } = { total: 0 };
  const progressMatch = fm.match(/^progress:\s*\n((?:\s+.*\n?)*)/m);
  if (progressMatch) {
    const lines = progressMatch[1].split('\n');
    for (const line of lines) {
      const kv = line.match(/^\s+(\w+):\s*(\d+)/);
      if (kv) {
        progress[kv[1]] = parseInt(kv[2], 10);
      }
    }
  }

  return {
    project: getField(fm, 'project') ?? '',
    status: getField(fm, 'status') ?? 'pending',
    progress,
    needsAttention: {
      blockedCount: parseInt(getNestedField(fm, 'needsAttention', 'blockedCount') ?? '0', 10),
      failedCount: parseInt(getNestedField(fm, 'needsAttention', 'failedCount') ?? '0', 10),
      openQuestions: parseInt(getNestedField(fm, 'needsAttention', 'openQuestions') ?? '0', 10),
    },
    body,
  };
}

// --- Assignment Summary Parser ---

export interface ParsedAssignmentSummary {
  id: string;
  slug: string;
  title: string;
  status: string;
  priority: string;
  assignee: string | null;
  dependsOn: string[];
  links: string[];
  updated: string;
}

export function parseAssignmentSummary(fileContent: string): ParsedAssignmentSummary {
  const [fm] = extractFrontmatter(fileContent);
  return {
    id: getField(fm, 'id') ?? '',
    slug: getField(fm, 'slug') ?? '',
    title: getField(fm, 'title') ?? '',
    status: getField(fm, 'status') ?? 'pending',
    priority: getField(fm, 'priority') ?? 'medium',
    assignee: getField(fm, 'assignee'),
    dependsOn: parseListField(fm, 'dependsOn'),
    links: parseListField(fm, 'links'),
    updated: getField(fm, 'updated') ?? '',
  };
}

// --- Full Assignment Parser ---

export interface ParsedAssignmentFull {
  id: string;
  slug: string;
  title: string;
  project: string | null;
  workspaceGroup: string | null;
  type: string | null;
  status: string;
  priority: string;
  assignee: string | null;
  dependsOn: string[];
  links: string[];
  blockedReason: string | null;
  workspace: {
    repository: string | null;
    worktreePath: string | null;
    branch: string | null;
    parentBranch: string | null;
  };
  externalIds: Array<{ system: string; id: string; url: string | null }>;
  statusHistory: StatusHistoryEntry[];
  tags: string[];
  archived: boolean;
  archivedAt: string | null;
  archivedReason: string | null;
  created: string;
  updated: string;
  body: string;
}

function parseExternalIds(frontmatter: string): Array<{ system: string; id: string; url: string | null }> {
  const inlineMatch = frontmatter.match(/^externalIds:\s*\[\s*\]/m);
  if (inlineMatch) return [];

  const results: Array<{ system: string; id: string; url: string | null }> = [];
  const blockMatch = frontmatter.match(
    /^externalIds:\s*\n((?:\s+-\s+[\s\S]*?)(?=^\w|\n---))/m,
  );
  if (!blockMatch) return [];

  const itemBlocks = blockMatch[1].split(/\n\s+-\s+/).filter(Boolean);
  for (const block of itemBlocks) {
    const lines = block.split('\n');
    const entry: Record<string, string | null> = {};
    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx < 0) continue;
      const key = line.slice(0, colonIdx).trim().replace(/^-\s+/, '');
      if (!key) continue;
      entry[key] = parseSimpleValue(line.slice(colonIdx + 1));
    }
    if (entry['system'] && entry['id']) {
      results.push({
        system: entry['system'],
        id: entry['id'],
        url: entry['url'] || null,
      });
    }
  }
  return results;
}

/**
 * Parse the `statusHistory` list-of-mappings. Parity copy of
 * `src/lifecycle/frontmatter.ts::parseStatusHistory` — uses the same robust
 * line-scan (NOT the `parseExternalIds` regex boundary), because this module's
 * `extractFrontmatter` also strips the closing `\n---`, so a last-key
 * `statusHistory` block would otherwise be dropped. Keep in sync with the
 * lifecycle parser (dashboard-parser parity test guards this).
 */
function parseStatusHistory(frontmatter: string): StatusHistoryEntry[] {
  if (/^statusHistory:\s*\[\s*\]/m.test(frontmatter)) return [];

  const headerMatch = frontmatter.match(/^statusHistory:\s*$/m);
  if (!headerMatch) return [];

  // Regex match offset, not indexOf — guards against an earlier scalar value
  // containing the substring "statusHistory:".
  const headerStart = headerMatch.index ?? frontmatter.indexOf(headerMatch[0]);
  const bodyStart = headerStart + headerMatch[0].length + 1; // skip the trailing \n
  const after = frontmatter.slice(bodyStart);

  const bodyLines: string[] = [];
  for (const line of after.split('\n')) {
    if (line.length === 0) {
      bodyLines.push(line);
      continue;
    }
    if (line[0] !== ' ' && line[0] !== '\t') break;
    bodyLines.push(line);
  }
  const body = bodyLines.join('\n');

  const results: StatusHistoryEntry[] = [];
  const itemBlocks = body.split(/\n\s+-\s+/).filter((b) => b.trim().length > 0);
  for (const block of itemBlocks) {
    const entry: Record<string, string | null> = {};
    for (const line of block.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx < 0) continue;
      const key = line.slice(0, colonIdx).trim().replace(/^-\s+/, '');
      if (!key) continue;
      entry[key] = parseSimpleValue(line.slice(colonIdx + 1));
    }
    if (!entry['to']) continue;
    const result: StatusHistoryEntry = {
      at: entry['at'] ?? '',
      from: entry['from'] ?? null,
      to: entry['to'],
      command: entry['command'] ?? '',
      by: entry['by'] ?? null,
    };
    if (entry['reason'] != null) result.reason = entry['reason'];
    results.push(result);
  }
  return results;
}

export function parseAssignmentFull(fileContent: string): ParsedAssignmentFull {
  const [fm, body] = extractFrontmatter(fileContent);
  return {
    id: getField(fm, 'id') ?? '',
    slug: getField(fm, 'slug') ?? '',
    title: getField(fm, 'title') ?? '',
    project: getField(fm, 'project'),
    workspaceGroup: getField(fm, 'workspaceGroup'),
    type: getField(fm, 'type'),
    status: getField(fm, 'status') ?? 'pending',
    priority: getField(fm, 'priority') ?? 'medium',
    assignee: getField(fm, 'assignee'),
    dependsOn: parseListField(fm, 'dependsOn'),
    links: parseListField(fm, 'links'),
    blockedReason: getField(fm, 'blockedReason'),
    workspace: {
      repository: getNestedField(fm, 'workspace', 'repository'),
      worktreePath: getNestedField(fm, 'workspace', 'worktreePath'),
      branch: getNestedField(fm, 'workspace', 'branch'),
      parentBranch: getNestedField(fm, 'workspace', 'parentBranch'),
    },
    externalIds: parseExternalIds(fm),
    statusHistory: parseStatusHistory(fm),
    tags: parseListField(fm, 'tags'),
    archived: getField(fm, 'archived') === 'true',
    archivedAt: getField(fm, 'archivedAt'),
    archivedReason: getField(fm, 'archivedReason'),
    created: getField(fm, 'created') ?? '',
    updated: getField(fm, 'updated') ?? '',
    body,
  };
}

// --- Plan Parser ---

export interface ParsedPlan {
  assignment: string;
  status: string;
  created: string;
  updated: string;
  body: string;
}

export function parsePlan(fileContent: string): ParsedPlan {
  const [fm, body] = extractFrontmatter(fileContent);
  return {
    assignment: getField(fm, 'assignment') ?? '',
    status: getField(fm, 'status') ?? '',
    created: getField(fm, 'created') ?? '',
    updated: getField(fm, 'updated') ?? '',
    body,
  };
}

// --- Scratchpad Parser ---

export interface ParsedScratchpad {
  assignment: string;
  updated: string;
  body: string;
}

export function parseScratchpad(fileContent: string): ParsedScratchpad {
  const [fm, body] = extractFrontmatter(fileContent);
  return {
    assignment: getField(fm, 'assignment') ?? '',
    updated: getField(fm, 'updated') ?? '',
    body,
  };
}

// --- Handoff Parser ---

export interface ParsedHandoff {
  assignment: string;
  handoffCount: number;
  updated: string;
  body: string;
}

export function parseHandoff(fileContent: string): ParsedHandoff {
  const [fm, body] = extractFrontmatter(fileContent);
  return {
    assignment: getField(fm, 'assignment') ?? '',
    handoffCount: parseInt(getField(fm, 'handoffCount') ?? '0', 10),
    updated: getField(fm, 'updated') ?? '',
    body,
  };
}

// --- Decision Record Parser ---

export interface ParsedDecisionRecord {
  assignment: string;
  decisionCount: number;
  updated: string;
  body: string;
}

export function parseDecisionRecord(fileContent: string): ParsedDecisionRecord {
  const [fm, body] = extractFrontmatter(fileContent);
  return {
    assignment: getField(fm, 'assignment') ?? '',
    decisionCount: parseInt(getField(fm, 'decisionCount') ?? '0', 10),
    updated: getField(fm, 'updated') ?? '',
    body,
  };
}

// --- Comments Parser ---

export interface ParsedComment {
  id: string;
  timestamp: string;
  author: string;
  type: 'question' | 'note' | 'feedback';
  body: string;
  replyTo?: string;
  resolved?: boolean;
}

export interface ParsedComments {
  assignment: string;
  entryCount: number;
  updated: string;
  entries: ParsedComment[];
  body: string;
}

export function parseComments(fileContent: string): ParsedComments {
  const [fm, body] = extractFrontmatter(fileContent);
  const entries: ParsedComment[] = [];
  const sections = body.split(/^## /m).slice(1);
  for (const section of sections) {
    const newlineIdx = section.indexOf('\n');
    if (newlineIdx === -1) continue;
    const id = section.slice(0, newlineIdx).trim();
    const rest = section.slice(newlineIdx + 1);
    const headerMatch = rest.match(
      /^\s*\*\*Recorded:\*\*\s*(.*)\n\*\*Author:\*\*\s*(.*)\n\*\*Type:\*\*\s*(question|note|feedback)(?:\n\*\*Reply to:\*\*\s*(.*))?(?:\n\*\*Resolved:\*\*\s*(true|false))?\n+([\s\S]*)$/,
    );
    if (!headerMatch) continue;
    const [, timestamp, author, type, replyTo, resolvedStr, entryBody] = headerMatch;
    const entry: ParsedComment = {
      id,
      timestamp: timestamp.trim(),
      author: author.trim(),
      type: type as 'question' | 'note' | 'feedback',
      body: entryBody.trim(),
    };
    if (replyTo) entry.replyTo = replyTo.trim();
    if (resolvedStr) entry.resolved = resolvedStr === 'true';
    entries.push(entry);
  }
  return {
    assignment: getField(fm, 'assignment') ?? '',
    entryCount: parseInt(getField(fm, 'entryCount') ?? '0', 10),
    updated: getField(fm, 'updated') ?? '',
    entries,
    body,
  };
}

// --- Progress Parser ---

export interface ProgressEntry {
  timestamp: string;
  body: string;
}

export interface ParsedProgress {
  assignment: string;
  entryCount: number;
  updated: string;
  entries: ProgressEntry[];
  body: string;
}

export function parseProgress(fileContent: string): ParsedProgress {
  const [fm, body] = extractFrontmatter(fileContent);
  const entries: ProgressEntry[] = [];
  const sections = body.split(/^## /m).slice(1);
  for (const section of sections) {
    const newlineIdx = section.indexOf('\n');
    if (newlineIdx === -1) continue;
    const timestamp = section.slice(0, newlineIdx).trim();
    const entryBody = section.slice(newlineIdx + 1).trim();
    entries.push({ timestamp, body: entryBody });
  }
  return {
    assignment: getField(fm, 'assignment') ?? '',
    entryCount: parseInt(getField(fm, 'entryCount') ?? '0', 10),
    updated: getField(fm, 'updated') ?? '',
    entries,
    body,
  };
}

// --- Resource Parser ---

export interface ParsedResource {
  name: string;
  source: string;
  category: string;
  relatedAssignments: string[];
  created: string;
  updated: string;
  body: string;
}

export function parseResource(fileContent: string): ParsedResource {
  const [fm, body] = extractFrontmatter(fileContent);
  return {
    name: getField(fm, 'name') ?? '',
    source: getField(fm, 'source') ?? '',
    category: getField(fm, 'category') ?? '',
    relatedAssignments: parseListField(fm, 'relatedAssignments'),
    created: getField(fm, 'created') ?? '',
    updated: getField(fm, 'updated') ?? '',
    body,
  };
}

// --- Memory Parser ---

export interface ParsedMemory {
  name: string;
  source: string;
  scope: string;
  sourceAssignment: string | null;
  relatedAssignments: string[];
  tags: string[];
  created: string;
  updated: string;
  body: string;
}

export function parseMemory(fileContent: string): ParsedMemory {
  const [fm, body] = extractFrontmatter(fileContent);
  return {
    name: getField(fm, 'name') ?? '',
    source: getField(fm, 'source') ?? '',
    scope: getField(fm, 'scope') ?? '',
    sourceAssignment: getField(fm, 'sourceAssignment'),
    relatedAssignments: parseListField(fm, 'relatedAssignments'),
    tags: parseListField(fm, 'tags'),
    created: getField(fm, 'created') ?? '',
    updated: getField(fm, 'updated') ?? '',
    body,
  };
}

// --- Playbook Parser ---

export interface ParsedPlaybook {
  slug: string;
  name: string;
  description: string;
  whenToUse: string;
  created: string;
  updated: string;
  tags: string[];
  body: string;
}

export function parsePlaybook(fileContent: string): ParsedPlaybook {
  const [fm, body] = extractFrontmatter(fileContent);
  return {
    slug: getField(fm, 'slug') ?? '',
    name: getField(fm, 'name') ?? '',
    description: getField(fm, 'description') ?? '',
    whenToUse: getField(fm, 'when_to_use') ?? '',
    created: getField(fm, 'created') ?? '',
    updated: getField(fm, 'updated') ?? '',
    tags: parseListField(fm, 'tags'),
    body,
  };
}

// --- Mermaid Graph Extractor ---

/**
 * Extract the mermaid code block from _status.md body content.
 * Returns null if no mermaid block is found.
 */
export function extractMermaidGraph(body: string): string | null {
  const match = body.match(/```mermaid\n([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}
