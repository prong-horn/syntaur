/**
 * Generic frontmatter/markdown parser for all Syntaur file types.
 * Pattern copied from src/lifecycle/frontmatter.ts:3-23 (extractFrontmatter + parseSimpleValue).
 */

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
  if (trimmed === 'null' || trimmed === '') return null;
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
  body: string;
}

export function parseProject(fileContent: string): ParsedProject {
  const [fm, body] = extractFrontmatter(fileContent);
  return {
    id: getField(fm, 'id') ?? '',
    slug: getField(fm, 'slug') ?? '',
    title: getField(fm, 'title') ?? '',
    archived: getField(fm, 'archived') === 'true',
    archivedAt: getField(fm, 'archivedAt'),
    archivedReason: getField(fm, 'archivedReason'),
    statusOverride: getField(fm, 'statusOverride'),
    created: getField(fm, 'created') ?? '',
    updated: getField(fm, 'updated') ?? '',
    tags: parseListField(fm, 'tags'),
    workspace: getField(fm, 'workspace'),
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
    unansweredQuestions: number;
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
      unansweredQuestions: parseInt(getNestedField(fm, 'needsAttention', 'unansweredQuestions') ?? '0', 10),
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
  externalIds: Array<{ system: string; id: string; url: string }>;
  tags: string[];
  created: string;
  updated: string;
  body: string;
}

function parseExternalIds(frontmatter: string): Array<{ system: string; id: string; url: string }> {
  const inlineMatch = frontmatter.match(/^externalIds:\s*\[\s*\]/m);
  if (inlineMatch) return [];

  const results: Array<{ system: string; id: string; url: string }> = [];
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

export function parseAssignmentFull(fileContent: string): ParsedAssignmentFull {
  const [fm, body] = extractFrontmatter(fileContent);
  return {
    id: getField(fm, 'id') ?? '',
    slug: getField(fm, 'slug') ?? '',
    title: getField(fm, 'title') ?? '',
    project: getField(fm, 'project'),
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
    tags: parseListField(fm, 'tags'),
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
