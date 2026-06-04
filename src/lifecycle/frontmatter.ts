import type { AssignmentFrontmatter, ExternalId, StatusHistoryEntry, Workspace } from './types.js';

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
 * Parse the `statusHistory` list-of-mappings from a frontmatter string.
 *
 * NOTE on the boundary: `extractFrontmatter` strips the closing `\n---`, so when
 * `statusHistory` is the LAST frontmatter key there is no trailing `---` and no
 * following top-level key. The `parseExternalIds` regex boundary `(?=^\w|\n---)`
 * would silently drop such a block, and `$` under `/m` matches end-of-LINE (which
 * would truncate an entry after its first line). So this uses a robust line-scan:
 * collect blank/indented lines after the header until the first column-0 non-blank
 * line OR end of input. This is end-of-input safe regardless of the `---` delimiter.
 */
function parseStatusHistory(frontmatter: string): StatusHistoryEntry[] {
  if (/^statusHistory:\s*\[\s*\]/m.test(frontmatter)) return [];

  const headerMatch = frontmatter.match(/^statusHistory:\s*$/m);
  if (!headerMatch) return [];

  const headerStart = frontmatter.indexOf(headerMatch[0]);
  const bodyStart = headerStart + headerMatch[0].length + 1; // skip the trailing \n
  const after = frontmatter.slice(bodyStart);

  const bodyLines: string[] = [];
  for (const line of after.split('\n')) {
    if (line.length === 0) {
      bodyLines.push(line); // blank line — keep scanning (YAML allows blanks in a block)
      continue;
    }
    if (line[0] !== ' ' && line[0] !== '\t') break; // column-0 non-blank → block ended
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
    // `to` is required; `from` is null only on the seed/create entry.
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
    project: getField('project'),
    type: getField('type'),
    status: getField('status') ?? 'pending',
    priority: (getField('priority') ?? 'medium') as AssignmentFrontmatter['priority'],
    created: getField('created') ?? '',
    updated: getField('updated') ?? '',
    assignee: getField('assignee'),
    externalIds: parseExternalIds(frontmatter),
    statusHistory: parseStatusHistory(frontmatter),
    dependsOn: parseDependsOn(frontmatter),
    links: parseLinks(frontmatter),
    blockedReason: getField('blockedReason'),
    workspace: parseWorkspace(frontmatter),
    tags: parseTags(frontmatter),
    archived: getField('archived') === 'true',
    archivedAt: getField('archivedAt'),
    archivedReason: getField('archivedReason'),
  };
}

function formatYamlValue(value: string | boolean | null): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
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
  updates: Partial<
    Pick<
      AssignmentFrontmatter,
      'status' | 'assignee' | 'blockedReason' | 'updated' | 'archived' | 'archivedAt' | 'archivedReason'
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
      // Insert a missing field just before the closing frontmatter delimiter.
      // `indexOf('\n---', 4)` skips the opening `---`; mirrors setTopLevelField.
      const closeIdx = result.indexOf('\n---', 4);
      if (closeIdx !== -1) {
        result = `${result.slice(0, closeIdx)}\n${key}: ${formatted}${result.slice(closeIdx)}`;
      }
    }
  }

  return result;
}

/**
 * Locate the `workspace:` block inside a frontmatter string and return the
 * [start, end) byte offsets of the *body* of that block (lines indented under
 * `workspace:`, excluding the `workspace:` header line itself). Returns null
 * if no `workspace:` block is present.
 */
function findWorkspaceBlock(
  fmBlock: string,
): { headerStart: number; bodyStart: number; bodyEnd: number } | null {
  const headerMatch = fmBlock.match(/^workspace:\s*$/m);
  if (!headerMatch) return null;
  const headerStart = fmBlock.indexOf(headerMatch[0]);
  const bodyStart = headerStart + headerMatch[0].length + 1; // skip the trailing \n
  const after = fmBlock.slice(bodyStart);
  const lines = after.split('\n');
  let consumed = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) {
      // blank line — consume but keep scanning; YAML allows blanks inside a block
      consumed += line.length + 1;
      continue;
    }
    if (line[0] !== ' ') break; // top-level key — block ended
    consumed += line.length + 1;
  }
  // Trim a trailing newline we counted past EOF
  const bodyEnd = Math.min(bodyStart + consumed, fmBlock.length);
  return { headerStart, bodyStart, bodyEnd };
}

/**
 * Update nested workspace.* fields (repository, worktreePath, branch, parentBranch)
 * in-place. Edits only inside the `workspace:` block — other indented keys
 * with the same name elsewhere in frontmatter are not touched. Preserves
 * field ordering and unknown workspace fields. If the `workspace:` block does
 * not exist, it is appended to the frontmatter.
 */
export function updateAssignmentWorkspace(
  fileContent: string,
  partial: Partial<Workspace>,
): string {
  const fmMatch = fileContent.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!fmMatch) {
    throw new Error('No frontmatter found in assignment file. Expected --- delimiters.');
  }

  const fmBlock = fmMatch[2];
  const fields = ['repository', 'worktreePath', 'branch', 'parentBranch'] as const;
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

/**
 * Locate the `statusHistory:` block (the multi-line list form, not inline `[]`)
 * inside a frontmatter string and return the [bodyStart, bodyEnd) offsets of the
 * block body (the indented `- …` item lines, excluding the header line). Returns
 * null when there is no block header. Mirrors `findWorkspaceBlock`.
 */
function findStatusHistoryBlock(
  fmBlock: string,
): { headerStart: number; bodyStart: number; bodyEnd: number } | null {
  const headerMatch = fmBlock.match(/^statusHistory:\s*$/m);
  if (!headerMatch) return null;
  const headerStart = fmBlock.indexOf(headerMatch[0]);
  const bodyStart = headerStart + headerMatch[0].length + 1; // skip the trailing \n
  const after = fmBlock.slice(bodyStart);
  const lines = after.split('\n');
  let consumed = 0;
  for (const line of lines) {
    if (line.length === 0) {
      consumed += line.length + 1;
      continue;
    }
    if (line[0] !== ' ' && line[0] !== '\t') break; // top-level key — block ended
    consumed += line.length + 1;
  }
  const bodyEnd = Math.min(bodyStart + consumed, fmBlock.length);
  return { headerStart, bodyStart, bodyEnd };
}

function renderStatusHistoryItem(entry: StatusHistoryEntry): string {
  const lines = [
    `  - at: ${formatYamlValue(entry.at)}`,
    `    from: ${formatYamlValue(entry.from)}`,
    `    to: ${formatYamlValue(entry.to)}`,
    `    command: ${formatYamlValue(entry.command)}`,
    `    by: ${formatYamlValue(entry.by)}`,
  ];
  if (entry.reason !== undefined && entry.reason !== null) {
    lines.push(`    reason: ${formatYamlValue(entry.reason)}`);
  }
  return lines.join('\n');
}

/**
 * Append one entry to an assignment file's `statusHistory` frontmatter list,
 * returning the new file content. Robust to three states:
 *   (i)   no `statusHistory:` key      → create the block before the closing `---`;
 *   (ii)  inline `statusHistory: []`   → convert it to a block with this entry;
 *   (iii) existing block               → append the item after the last item.
 * This is the single shared serializer used by the lifecycle transition paths and
 * the dashboard write paths. Mirrors the bespoke block handling of
 * `updateAssignmentWorkspace` (scalar `updateAssignmentFile` cannot append to a list).
 */
export function appendStatusHistoryEntry(
  fileContent: string,
  entry: StatusHistoryEntry,
): string {
  const fmMatch = fileContent.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!fmMatch) {
    throw new Error('No frontmatter found in assignment file. Expected --- delimiters.');
  }
  const fmBlock = fmMatch[2];
  const item = renderStatusHistoryItem(entry);

  const inlineRegex = /^statusHistory:[ \t]*\[[ \t]*\][ \t]*$/m;
  const block = findStatusHistoryBlock(fmBlock);

  let newFm: string;
  if (inlineRegex.test(fmBlock)) {
    // (ii) inline empty list → block.
    newFm = fmBlock.replace(inlineRegex, `statusHistory:\n${item}`);
  } else if (block) {
    // (iii) existing block → insert after the last item line.
    const before = fmBlock.slice(0, block.bodyEnd);
    const rest = fmBlock.slice(block.bodyEnd);
    const sep1 = before.endsWith('\n') ? '' : '\n';
    const sep2 = rest.length > 0 && !rest.startsWith('\n') ? '\n' : '';
    newFm = `${before}${sep1}${item}${sep2}${rest}`;
  } else {
    // (i) no key → append a new block at the end of the frontmatter.
    newFm = `${fmBlock.replace(/\n+$/, '')}\nstatusHistory:\n${item}`;
  }

  return `${fmMatch[1]}${newFm}${fmMatch[3]}${fileContent.slice(fmMatch[0].length)}`;
}
