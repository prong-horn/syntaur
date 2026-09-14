import type { PlanBlock, TicketFrontmatter, Workspace } from './types.js';

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
  if (trimmed === 'null' || trimmed === '~' || trimmed === '') return null;
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseDependsOn(frontmatter: string): string[] {
  const inlineMatch = frontmatter.match(/^depends_on:\s*\[\s*\]/m);
  if (inlineMatch) return [];

  const results: string[] = [];
  const blockMatch = frontmatter.match(/^depends_on:\s*\n((?:\s+-\s+.*\n?)*)/m);
  if (blockMatch) {
    const items = blockMatch[1].matchAll(/^\s+-\s+(.+)$/gm);
    for (const item of items) {
      results.push(item[1].trim());
    }
  }
  return results;
}

function parseLinks(frontmatter: string): string[] {
  const inlineMatch = frontmatter.match(/^links:\s*\[\s*\]/m);
  if (inlineMatch) return [];

  const results: string[] = [];
  const blockMatch = frontmatter.match(/^links:\s*\n((?:\s+-\s+.*\n?)*)/m);
  if (blockMatch) {
    const items = blockMatch[1].matchAll(/^\s+-\s+(.+)$/gm);
    for (const item of items) {
      results.push(item[1].trim());
    }
  }
  return results;
}

function parseNestedBlock(frontmatter: string, header: string): Record<string, string | null> | null {
  if (new RegExp(`^${header}:\\s*(null|~)\\s*$`, 'm').test(frontmatter)) return null;
  const headerMatch = frontmatter.match(new RegExp(`^${header}:\\s*$`, 'm'));
  if (!headerMatch) return null;
  const headerStart = headerMatch.index ?? frontmatter.indexOf(headerMatch[0]);
  const after = frontmatter.slice(headerStart + headerMatch[0].length + 1);
  const out: Record<string, string | null> = {};
  for (const line of after.split('\n')) {
    if (line.length === 0) continue;
    if (line[0] !== ' ' && line[0] !== '\t') break;
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    if (!key) continue;
    out[key] = parseSimpleValue(line.slice(colonIdx + 1));
  }
  return Object.keys(out).length > 0 ? out : null;
}

export const EMPTY_PLAN_BLOCK: PlanBlock = {
  file: null,
  approvedDigest: null,
  approvedAt: null,
  approvedBy: null,
};

function parsePlanBlock(frontmatter: string): PlanBlock {
  const block = parseNestedBlock(frontmatter, 'plan');
  if (!block) return { ...EMPTY_PLAN_BLOCK };
  return {
    file: block['file'] ?? null,
    approvedDigest: block['approvedDigest'] ?? null,
    approvedAt: block['approvedAt'] ?? null,
    approvedBy: block['approvedBy'] ?? null,
  };
}

function parseWorkspace(frontmatter: string): Workspace {
  const defaults: Workspace = {
    repository: null,
    worktree: null,
    branch: null,
    parentBranch: null,
  };

  const fields = ['repository', 'worktree', 'worktreePath', 'branch', 'parentBranch'] as const;
  for (const field of fields) {
    const match = frontmatter.match(new RegExp(`^\\s+${field}:\\s*(.*)$`, 'm'));
    if (match) {
      const value = parseSimpleValue(match[1]);
      if (field === 'worktree' || field === 'worktreePath') {
        if (!defaults.worktree) defaults.worktree = value;
      } else if (field === 'repository') {
        defaults.repository = value;
      } else if (field === 'branch') {
        defaults.branch = value;
      } else if (field === 'parentBranch') {
        defaults.parentBranch = value;
      }
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

export function parseTicketFrontmatter(fileContent: string): TicketFrontmatter {
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
    project: getField('project'),
    template: getField('template'),
    status: getField('status') ?? 'backlog',
    priority: (getField('priority') ?? 'medium') as TicketFrontmatter['priority'],
    blocked: getField('blocked') ?? getField('blockedReason'),
    parked: (() => {
      const raw = getField('parked');
      if (raw === null || raw === 'false' || raw === 'null') return null;
      if (raw === 'true') return 'parked';
      return raw;
    })(),
    depends_on: parseDependsOn(frontmatter),
    assignee: getField('assignee'),
    tags: parseTags(frontmatter),
    links: parseLinks(frontmatter),
    workspace: parseWorkspace(frontmatter),
    plan: parsePlanBlock(frontmatter),
    created: getField('created') ?? '',
    updated: getField('updated') ?? '',
  };
}

function formatYamlValue(value: string | boolean | null): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null) return 'null';
  if (/[\r\n]/.test(value)) {
    value = value.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return `"${value}"`;
  }
  if (/^(null|~|true|false|-?\d+(\.\d+)?)$/i.test(value)) {
    return `"${value}"`;
  }
  if (
    /[:#{}[\],&*?|>!%@\`]/.test(value) ||
    /^\s|\s$/.test(value) ||
    /^["']|["']$/.test(value) ||
    value === ''
  ) {
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return value;
}

export function updateTicketFile(
  fileContent: string,
  updates: Partial<
    Pick<
      TicketFrontmatter,
      'status' | 'template' | 'assignee' | 'blocked' | 'parked' | 'updated'
    >
  >,
): string {
  let result = fileContent;

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    const formatted = formatYamlValue(value as string | boolean | null);
    const fieldRegex = new RegExp(`^(${key}:)\\s*.*$`, 'm');
    if (fieldRegex.test(result)) {
      result = result.replace(fieldRegex, `$1 ${formatted}`);
    } else {
      const closeIdx = result.indexOf('\n---', 4);
      if (closeIdx !== -1) {
        result = `${result.slice(0, closeIdx)}\n${key}: ${formatted}${result.slice(closeIdx)}`;
      }
    }
  }

  return result;
}

function findWorkspaceBlock(
  fmBlock: string,
): { headerStart: number; bodyStart: number; bodyEnd: number } | null {
  const headerMatch = fmBlock.match(/^workspace:\s*$/m);
  if (!headerMatch) return null;
  const headerStart = headerMatch.index ?? fmBlock.indexOf(headerMatch[0]);
  const bodyStart = headerStart + headerMatch[0].length + 1;
  const after = fmBlock.slice(bodyStart);
  const lines = after.split('\n');
  let consumed = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) {
      consumed += line.length + 1;
      continue;
    }
    if (line[0] !== ' ') break;
    consumed += line.length + 1;
  }
  const bodyEnd = Math.min(bodyStart + consumed, fmBlock.length);
  return { headerStart, bodyStart, bodyEnd };
}

export function updateTicketWorkspace(
  fileContent: string,
  partial: Partial<Workspace>,
): string {
  const fmMatch = fileContent.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!fmMatch) {
    throw new Error('No frontmatter found in ticket file. Expected --- delimiters.');
  }

  const fmBlock = fmMatch[2];
  const fields = ['repository', 'worktree', 'branch', 'parentBranch'] as const;
  const block = findWorkspaceBlock(fmBlock);

  let newFm = fmBlock;

  if (block) {
    let body = fmBlock.slice(block.bodyStart, block.bodyEnd);
    for (const field of fields) {
      if (!(field in partial)) continue;
      const value = partial[field] ?? null;
      const formatted = formatYamlValue(value);
      const lineRegex = new RegExp(`^(\\s+${field}:)\\s*.*$`, 'm');
      if (lineRegex.test(body)) {
        body = body.replace(lineRegex, `$1 ${formatted}`);
      } else {
        const trimmed = body.replace(/\n+$/, '');
        body = `${trimmed}${trimmed.length > 0 ? '\n' : ''}  ${field}: ${formatted}\n`;
      }
    }
    newFm =
      fmBlock.slice(0, block.bodyStart) + body + fmBlock.slice(block.bodyEnd);
  } else {
    const lines = ['workspace:'];
    for (const field of fields) {
      const value = field in partial ? (partial[field] ?? null) : null;
      lines.push(`  ${field}: ${formatYamlValue(value)}`);
    }
    newFm = `${fmBlock.replace(/\n+$/, '')}\n${lines.join('\n')}`;
  }

  return `${fmMatch[1]}${newFm}${fmMatch[3]}${fileContent.slice(fmMatch[0].length)}`;
}

function setFrontmatterBlock(fileContent: string, header: string, rendered: string): string {
  const fmMatch = fileContent.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!fmMatch) {
    throw new Error('No frontmatter found in ticket file. Expected --- delimiters.');
  }
  const fmBlock = fmMatch[2];
  const headerRe = new RegExp(`^${header}:.*$`, 'm');
  const headerMatch = fmBlock.match(headerRe);
  let newFm: string;
  if (headerMatch) {
    const start = headerMatch.index ?? 0;
    let end = start + headerMatch[0].length;
    const after = fmBlock.slice(end);
    let scanned = 0;
    for (const line of after.split('\n').slice(1)) {
      if (line.length === 0) {
        scanned += 1 + line.length;
        continue;
      }
      if (line[0] !== ' ' && line[0] !== '\t') break;
      scanned += 1 + line.length;
      end += scanned;
      scanned = 0;
    }
    newFm = fmBlock.slice(0, start) + rendered + fmBlock.slice(end);
  } else {
    newFm = `${fmBlock.replace(/\n+$/, '')}\n${rendered}`;
  }
  return `${fmMatch[1]}${newFm}${fmMatch[3]}${fileContent.slice(fmMatch[0].length)}`;
}

export function updateNestedBlock(
  fileContent: string,
  header: string,
  record: Record<string, string | null> | null,
): string {
  const rendered =
    record === null
      ? `${header}: null`
      : [`${header}:`, ...Object.entries(record).map(([k, v]) => `  ${k}: ${formatYamlValue(v)}`)].join('\n');
  return setFrontmatterBlock(fileContent, header, rendered);
}

export function updatePlanBlock(fileContent: string, patch: Partial<PlanBlock>): string {
  const [fm] = extractFrontmatter(fileContent);
  const current = parsePlanBlock(fm);
  const merged: PlanBlock = { ...current, ...patch };
  return updateNestedBlock(fileContent, 'plan', {
    file: merged.file,
    approvedDigest: merged.approvedDigest,
    approvedAt: merged.approvedAt,
    approvedBy: merged.approvedBy,
  });
}
