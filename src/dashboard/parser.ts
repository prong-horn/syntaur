/**
 * Generic frontmatter/markdown parser for all Syntaur file types.
 * Pattern copied from src/lifecycle/frontmatter.ts:3-23 (extractFrontmatter + parseSimpleValue).
 */

import type { PlanBlock } from '../lifecycle/types.js';

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
  // Double-quoted: decode the escapes formatYamlValue writes (`\"` and `\\`), so
  // notes/values containing quotes or backslashes round-trip identically to the
  // lifecycle parser. Single-quoted: literal contents (parity with lifecycle).
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
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

/** Sidecar files name their ticket with the `ticket:` key. */
function sidecarTicketSlug(frontmatter: string): string {
  return getField(frontmatter, 'ticket') ?? '';
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
 * Parse a YAML list field (e.g., tags, depends_on, relatedTickets).
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
 * Parse a flat nested `header:` mapping block (indented `key: value` lines) into
 * a string map. Absent header → `{}`. Stops at the first non-indented line (a
 * sibling top-level key). Null-valued entries are dropped. Mirrors the lifecycle
 * parser's `parseNestedBlock` so the two parsers agree on e.g. `workflowByType`.
 */
function parseNestedMap(frontmatter: string, header: string): Record<string, string> {
  const headerMatch = frontmatter.match(new RegExp(`^${header}:\\s*$`, 'm'));
  if (!headerMatch) return {};
  const start =
    (headerMatch.index ?? frontmatter.indexOf(headerMatch[0])) + headerMatch[0].length + 1;
  const out: Record<string, string> = {};
  for (const line of frontmatter.slice(start).split('\n')) {
    if (line.length === 0) continue;
    if (line[0] !== ' ' && line[0] !== '\t') break; // sibling top-level key — block ended
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    if (!key) continue;
    const value = parseSimpleValue(line.slice(colonIdx + 1));
    if (value !== null) out[key] = value;
  }
  return out;
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

// --- Project Parser ---

export interface ParsedProject {
  id: string;
  slug: string;
  title: string;
  prefix: string | null;
  nextTicket: number | null;
  defaultTemplate: string | null;
  archived: boolean;
  archivedAt: string | null;
  archivedReason: string | null;
  statusOverride: string | null;
  created: string;
  updated: string;
  tags: string[];
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
  const nextTicketRaw = getField(fm, 'nextTicket');
  const nextTicketParsed =
    nextTicketRaw === null ? null : Number.parseInt(nextTicketRaw, 10);
  return {
    id: getField(fm, 'id') ?? '',
    slug,
    title: getField(fm, 'title') ?? '',
    prefix: getField(fm, 'prefix'),
    nextTicket:
      nextTicketParsed === null || Number.isNaN(nextTicketParsed)
        ? null
        : nextTicketParsed,
    defaultTemplate: getField(fm, 'defaultTemplate'),
    archived: getField(fm, 'archived') === 'true',
    archivedAt: getField(fm, 'archivedAt'),
    archivedReason: getField(fm, 'archivedReason'),
    statusOverride: getField(fm, 'statusOverride'),
    created: getField(fm, 'created') ?? '',
    updated: getField(fm, 'updated') ?? '',
    tags: parseListField(fm, 'tags'),
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

// --- Ticket Summary Parser ---

export interface ParsedTicketSummary {
  id: string;
  slug: string;
  title: string;
  status: string;
  priority: string;
  assignee: string | null;
  depends_on: string[];
  links: string[];
  updated: string;
}

export function parseTicketSummary(fileContent: string): ParsedTicketSummary {
  const [fm] = extractFrontmatter(fileContent);
  return {
    id: getField(fm, 'id') ?? '',
    slug: getField(fm, 'slug') ?? '',
    title: getField(fm, 'title') ?? '',
    status: getField(fm, 'status') ?? 'pending',
    priority: getField(fm, 'priority') ?? 'medium',
    assignee: getField(fm, 'assignee'),
    depends_on: parseListField(fm, 'depends_on'),
    links: parseListField(fm, 'links'),
    updated: getField(fm, 'updated') ?? '',
  };
}

// --- Full Ticket Parser ---

export interface ParsedTicketFull {
  id: string;
  slug: string;
  title: string;
  project: string | null;
  template: string | null;
  status: string;
  priority: string;
  blocked: string | null;
  parked: string | null;
  depends_on: string[];
  assignee: string | null;
  tags: string[];
  links: string[];
  workspace: {
    repository: string | null;
    worktree: string | null;
    branch: string | null;
    parentBranch: string | null;
  };
  plan: PlanBlock;
  created: string;
  updated: string;
  body: string;
}

function parsePlanBlockD(fm: string): PlanBlock {
  return {
    file: getNestedField(fm, 'plan', 'file'),
    approvedDigest: getNestedField(fm, 'plan', 'approvedDigest'),
    approvedAt: getNestedField(fm, 'plan', 'approvedAt'),
    approvedBy: getNestedField(fm, 'plan', 'approvedBy'),
  };
}

function parseWorkspaceBlock(fm: string): ParsedTicketFull['workspace'] {
  const worktree = getNestedField(fm, 'workspace', 'worktree');
  return {
    repository: getNestedField(fm, 'workspace', 'repository'),
    worktree,
    branch: getNestedField(fm, 'workspace', 'branch'),
    parentBranch: getNestedField(fm, 'workspace', 'parentBranch'),
  };
}

export function parseTicketFull(fileContent: string): ParsedTicketFull {
  const [fm, body] = extractFrontmatter(fileContent);
  const blockedRaw = getField(fm, 'blocked');
  const parkedRaw = getField(fm, 'parked');
  return {
    id: getField(fm, 'id') ?? '',
    slug: getField(fm, 'slug') ?? '',
    title: getField(fm, 'title') ?? '',
    project: getField(fm, 'project'),
    template: getField(fm, 'template'),
    status: getField(fm, 'status') ?? 'backlog',
    priority: getField(fm, 'priority') ?? 'medium',
    blocked: blockedRaw === 'null' ? null : blockedRaw,
    parked:
      parkedRaw === null || parkedRaw === 'false' || parkedRaw === 'null' ? null : parkedRaw,
    depends_on: parseListField(fm, 'depends_on'),
    assignee: getField(fm, 'assignee'),
    tags: parseListField(fm, 'tags'),
    links: parseListField(fm, 'links'),
    workspace: parseWorkspaceBlock(fm),
    plan: parsePlanBlockD(fm),
    created: getField(fm, 'created') ?? '',
    updated: getField(fm, 'updated') ?? '',
    body,
  };
}

// --- Plan Parser ---

export interface ParsedPlan {
  ticket: string;
  status: string;
  created: string;
  updated: string;
  body: string;
}

export function parsePlan(fileContent: string): ParsedPlan {
  const [fm, body] = extractFrontmatter(fileContent);
  return {
    ticket: sidecarTicketSlug(fm),
    status: getField(fm, 'status') ?? '',
    created: getField(fm, 'created') ?? '',
    updated: getField(fm, 'updated') ?? '',
    body,
  };
}

// --- Scratchpad Parser ---

export interface ParsedScratchpad {
  ticket: string;
  updated: string;
  body: string;
}

export function parseScratchpad(fileContent: string): ParsedScratchpad {
  const [fm, body] = extractFrontmatter(fileContent);
  return {
    ticket: sidecarTicketSlug(fm),
    updated: getField(fm, 'updated') ?? '',
    body,
  };
}

// --- Handoff Parser ---

export interface ParsedHandoff {
  ticket: string;
  handoffCount: number;
  updated: string;
  body: string;
}

export function parseHandoff(fileContent: string): ParsedHandoff {
  const [fm, body] = extractFrontmatter(fileContent);
  return {
    ticket: sidecarTicketSlug(fm),
    handoffCount: parseInt(getField(fm, 'handoffCount') ?? '0', 10),
    updated: getField(fm, 'updated') ?? '',
    body,
  };
}

// --- Decision Record Parser ---

export interface ParsedDecisionRecord {
  ticket: string;
  decisionCount: number;
  updated: string;
  body: string;
}

export function parseDecisionRecord(fileContent: string): ParsedDecisionRecord {
  const [fm, body] = extractFrontmatter(fileContent);
  return {
    ticket: sidecarTicketSlug(fm),
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
  ticket: string;
  entryCount: number;
  updated: string;
  entries: ParsedComment[];
  body: string;
}

export function parseComments(fileContent: string): ParsedComments {
  const [fm, body] = extractFrontmatter(fileContent);
  const entries: ParsedComment[] = [];
  // Split only at REAL comment headers — a `## <id>` line followed by the full
  // metadata prelude (Recorded → Author → Type<valid>) — so a markdown
  // `## Heading` inside a comment body (even one followed by a lone
  // `**Recorded:**` line) doesn't start a phantom section and truncate the body.
  // `\n\s*` mirrors the header regex's `^\s*` tolerance (no-blank/multi-blank).
  const sections = body
    .split(
      /^## (?=[^\n]*\n\s*\*\*Recorded:\*\*[^\n]*\n\*\*Author:\*\*[^\n]*\n\*\*Type:\*\*\s*(?:question|note|feedback)\b)/m,
    )
    .slice(1);
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
    ticket: sidecarTicketSlug(fm),
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
  ticket: string;
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
    ticket: sidecarTicketSlug(fm),
    entryCount: parseInt(getField(fm, 'entryCount') ?? '0', 10),
    updated: getField(fm, 'updated') ?? '',
    entries,
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

