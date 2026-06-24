import type {
  AssignmentFrontmatter,
  AttestationRecord,
  ExternalId,
  PlanApproval,
  StatusHistoryEntry,
  StatusOverride,
  Workspace,
} from './types.js';

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
    // Decode the escapes formatYamlValue encodes — round-trip safety for
    // values containing quotes/backslashes (codex code-review finding 4).
    return trimmed.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
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

  // Use the regex match offset, NOT indexOf(headerMatch[0]) — an earlier scalar
  // value could contain the substring "statusHistory:" (e.g. a title) and shift
  // the start position, dropping the real block.
  const headerStart = headerMatch.index ?? frontmatter.indexOf(headerMatch[0]);
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
    // Dimension-aware optional keys (derived-status v3); absent on old entries.
    if ('phaseFrom' in entry) result.phaseFrom = entry['phaseFrom'];
    if ('phaseTo' in entry) result.phaseTo = entry['phaseTo'];
    if ('dispositionFrom' in entry) result.dispositionFrom = entry['dispositionFrom'];
    if ('dispositionTo' in entry) result.dispositionTo = entry['dispositionTo'];
    results.push(result);
  }
  return results;
}

/**
 * Parse a flat nested mapping block (`header:` + indented `key: value` lines)
 * into a string map. Returns null when the header is absent or explicitly null.
 * Shared by `planApproval` / `override` parsing; mirrors `parseWorkspace`'s
 * field scanning but generically.
 */
function parseNestedBlock(frontmatter: string, header: string): Record<string, string | null> | null {
  if (new RegExp(`^${header}:\\s*(null|~)\\s*$`, 'm').test(frontmatter)) return null;
  const headerMatch = frontmatter.match(new RegExp(`^${header}:\\s*$`, 'm'));
  if (!headerMatch) return null;
  const headerStart = headerMatch.index ?? frontmatter.indexOf(headerMatch[0]);
  const after = frontmatter.slice(headerStart + headerMatch[0].length + 1);
  const out: Record<string, string | null> = {};
  for (const line of after.split('\n')) {
    if (line.length === 0) continue;
    if (line[0] !== ' ' && line[0] !== '\t') break; // top-level key — block ended
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    if (!key) continue;
    out[key] = parseSimpleValue(line.slice(colonIdx + 1));
  }
  return Object.keys(out).length > 0 ? out : null;
}

function parsePlanApproval(frontmatter: string): PlanApproval | null {
  const block = parseNestedBlock(frontmatter, 'planApproval');
  if (!block || !block['file'] || !block['digest']) return null;
  return {
    file: block['file'],
    digest: block['digest'],
    by: block['by'] ?? null,
    at: block['at'] ?? '',
  };
}

function parseOverride(frontmatter: string): StatusOverride | null {
  const block = parseNestedBlock(frontmatter, 'override');
  if (!block || !block['status']) return null;
  return {
    status: block['status'],
    source: block['source'] ?? 'human',
    reason: block['reason'] ?? null,
    at: block['at'] ?? '',
  };
}

/**
 * Parse the `facts:` map (custom asserted fact values). Reuses
 * {@link parseNestedBlock}: absent/null block → `{}`; entries whose value is
 * null (empty / `null` / `~`) are DROPPED; remaining values kept as trimmed
 * strings (parseSimpleValue already trims + strips quotes). Typed coercion
 * against declarations happens in facts.ts — hand-edited garbage degrades there.
 */
function parseFactsMap(frontmatter: string): Record<string, string> {
  const block = parseNestedBlock(frontmatter, 'facts');
  if (!block) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(block)) {
    if (v === null) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Parse the `attestations:` record list. Modeled on {@link parseStatusHistory}
 * (same end-of-input-safe line scan). Records missing any required key
 * (fact/actor/verdict/at) or carrying an unknown verdict are dropped.
 */
function parseAttestations(frontmatter: string): AttestationRecord[] {
  if (/^attestations:\s*\[\s*\]/m.test(frontmatter)) return [];

  const headerMatch = frontmatter.match(/^attestations:\s*$/m);
  if (!headerMatch) return [];

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

  const results: AttestationRecord[] = [];
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
    const verdict = entry['verdict'];
    if (!entry['fact'] || !entry['actor'] || !verdict || !entry['at']) continue;
    if (verdict !== 'approved' && verdict !== 'changes-requested') continue;
    const record: AttestationRecord = {
      fact: entry['fact'],
      actor: entry['actor'],
      verdict,
      at: entry['at'],
    };
    if (entry['note'] != null) record.note = entry['note'];
    if (entry['file'] != null) record.file = entry['file'];
    if (entry['digest'] != null) record.digest = entry['digest'];
    if (entry['commit'] != null) record.commit = entry['commit'];
    results.push(record);
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
    phase: getField('phase'),
    disposition: getField('disposition'),
    planApproval: parsePlanApproval(frontmatter),
    parked: getField('parked') === 'true',
    reviewRequested: getField('reviewRequested') === 'true',
    reworkRequested: getField('reworkRequested') === 'true',
    implementationStarted: getField('implementationStarted') === 'true',
    override: parseOverride(frontmatter),
    facts: parseFactsMap(frontmatter),
    attestations: parseAttestations(frontmatter),
  };
}

function formatYamlValue(value: string | boolean | null): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null) return 'null';
  // Frontmatter scalars are single-line by contract: flatten embedded
  // newlines rather than corrupting the block (codex code-review finding 4).
  if (/[\r\n]/.test(value)) {
    value = value.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return `"${value}"`;
  }
  // Quote YAML keyword/number look-alikes so a literal string "null"/"true"/
  // "42" round-trips as a string, not the YAML scalar.
  if (/^(null|~|true|false|-?\d+(\.\d+)?)$/i.test(value)) {
    return `"${value}"`;
  }
  // Quote values containing YAML-special characters that could cause parse
  // issues, OR a value that is itself wrapped in quote chars (e.g.
  // `"connection refused"` / `'x'`) — otherwise parseSimpleValue strips the
  // literal surrounding quotes on read and the value does not round-trip.
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

export function updateAssignmentFile(
  fileContent: string,
  updates: Partial<
    Pick<
      AssignmentFrontmatter,
      | 'status'
      | 'assignee'
      | 'blockedReason'
      | 'updated'
      | 'archived'
      | 'archivedAt'
      | 'archivedReason'
      | 'phase'
      | 'disposition'
      | 'parked'
      | 'reviewRequested'
      | 'reworkRequested'
      | 'implementationStarted'
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
  // Regex match offset, not indexOf — guards against an earlier scalar value
  // (e.g. a title) containing the substring "workspace:". Mirrors
  // findStatusHistoryBlock / parseStatusHistory.
  const headerStart = headerMatch.index ?? fmBlock.indexOf(headerMatch[0]);
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
 * Relabel a status id within an assignment's `statusHistory` — rewrite every
 * entry whose `from`/`to` equals `oldId` to `newId`, WITHOUT appending a new
 * entry or changing any `at`. Used by `syntaur status rename`: a rename is a
 * relabel, not a transition, so it must preserve `statusAge` (no new entry) yet
 * keep historical labels consistent with the new id (so derived `completedAt`
 * stays correct after renaming a terminal status). Scoped to the frontmatter
 * block; `from:`/`to:` keys are unique to statusHistory entries there. Exact
 * value match avoids relabeling a status whose id is a substring of another.
 */
export function renameStatusInHistory(
  content: string,
  oldId: string,
  newId: string,
): string {
  const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!fmMatch) return content;
  const esc = oldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // phaseFrom/phaseTo also hold status ids (phase namespace = status definitions),
  // so a rename must relabel them too. Disposition keys hold dimension values
  // (active/blocked/...), not status ids — excluded. The OLD value may be QUOTED
  // when its id is a YAML keyword/number look-alike — match both forms with
  // ("?)…\2. The NEW value is (re)serialized via formatYamlValue so it is quoted
  // exactly when needed (e.g. newId `null`/`true`/`42`), instead of reusing the
  // old value's quote state (which dropped/mistyped keyword-id entries on parse).
  const re = new RegExp(`^(\\s+(?:from|to|phaseFrom|phaseTo):[ \\t]*)("?)${esc}\\2[ \\t]*$`, 'gm');
  const newFm = fmMatch[2].replace(re, (_m, prefix: string) => `${prefix}${formatYamlValue(newId)}`);
  return `${fmMatch[1]}${newFm}${fmMatch[3]}${content.slice(fmMatch[0].length)}`;
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
  // Regex match offset, not indexOf — guards against an earlier scalar value
  // containing the substring "statusHistory:".
  const headerStart = headerMatch.index ?? fmBlock.indexOf(headerMatch[0]);
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
  // Dimension-aware optional keys — rendered only when present, so entries
  // written by plain status transitions stay byte-identical to the v1 format.
  for (const key of ['phaseFrom', 'phaseTo', 'dispositionFrom', 'dispositionTo'] as const) {
    if (entry[key] !== undefined) {
      lines.push(`    ${key}: ${formatYamlValue(entry[key] ?? null)}`);
    }
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
/**
 * Set or clear a flat nested mapping block (`header:` + indented `key: value`
 * lines) in assignment frontmatter. `record = null` writes `header: null`
 * (preserving the key so future sets edit in place). Creates the block before
 * the closing `---` when absent. Used for `planApproval` and `override`.
 *
 * Duplicate headers: only the FIRST block is edited — consistent with
 * parseNestedBlock, which also reads the first. This writer never creates a
 * second block, so duplicates can only come from hand edits; doctor territory.
 */
export function updateNestedBlock(
  fileContent: string,
  header: string,
  record: Record<string, string | null> | null,
): string {
  const fmMatch = fileContent.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!fmMatch) {
    throw new Error('No frontmatter found in assignment file. Expected --- delimiters.');
  }
  const fmBlock = fmMatch[2];

  const rendered =
    record === null
      ? `${header}: null`
      : [`${header}:`, ...Object.entries(record).map(([k, v]) => `  ${k}: ${formatYamlValue(v)}`)].join('\n');

  // Replace an existing block (header + indented body) or scalar form, else append.
  const headerRe = new RegExp(`^${header}:.*$`, 'm');
  const headerMatch = fmBlock.match(headerRe);
  let newFm: string;
  if (headerMatch) {
    const start = headerMatch.index ?? 0;
    let end = start + headerMatch[0].length;
    // consume any indented body lines following the header; blanks inside a
    // block are scanned past (mirrors findWorkspaceBlock) but only indented
    // lines extend the consumed range, so trailing blanks aren't swallowed.
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

export function updatePlanApproval(fileContent: string, approval: PlanApproval | null): string {
  return updateNestedBlock(
    fileContent,
    'planApproval',
    approval === null
      ? null
      : { file: approval.file, digest: approval.digest, by: approval.by, at: approval.at },
  );
}

export function updateOverride(fileContent: string, override: StatusOverride | null): string {
  return updateNestedBlock(
    fileContent,
    'override',
    override === null
      ? null
      : { status: override.status, source: override.source, reason: override.reason, at: override.at },
  );
}

/**
 * Set one custom fact value in the `facts:` map (read-modify-write the whole
 * map through {@link updateNestedBlock}). `value` must already be the CANONICAL
 * serialization (`'true'`/`'false'` / `String(n)`) — the CLI coerces before
 * calling. Dedicated block writer (like {@link updatePlanApproval}); no
 * `updateAssignmentFile` whitelist entry needed.
 */
export function updateFactsMap(fileContent: string, name: string, value: string): string {
  const [frontmatter] = extractFrontmatter(fileContent);
  const current = parseFactsMap(frontmatter);
  current[name] = value;
  return updateNestedBlock(fileContent, 'facts', current);
}

function renderAttestationItem(r: AttestationRecord): string {
  const lines = [
    `  - fact: ${formatYamlValue(r.fact)}`,
    `    actor: ${formatYamlValue(r.actor)}`,
    `    verdict: ${formatYamlValue(r.verdict)}`,
    `    at: ${formatYamlValue(r.at)}`,
  ];
  if (r.note !== undefined && r.note !== null) lines.push(`    note: ${formatYamlValue(r.note)}`);
  if (r.file !== undefined && r.file !== null) lines.push(`    file: ${formatYamlValue(r.file)}`);
  if (r.digest !== undefined && r.digest !== null) lines.push(`    digest: ${formatYamlValue(r.digest)}`);
  if (r.commit !== undefined && r.commit !== null) lines.push(`    commit: ${formatYamlValue(r.commit)}`);
  return lines.join('\n');
}

/**
 * Locate the `attestations:` block (multi-line list form). Mirrors
 * {@link findStatusHistoryBlock}; returns null when no block header.
 */
function findAttestationsBlock(
  fmBlock: string,
): { headerStart: number; bodyStart: number; bodyEnd: number } | null {
  const headerMatch = fmBlock.match(/^attestations:\s*$/m);
  if (!headerMatch) return null;
  const headerStart = headerMatch.index ?? fmBlock.indexOf(headerMatch[0]);
  const bodyStart = headerStart + headerMatch[0].length + 1; // skip the trailing \n
  const after = fmBlock.slice(bodyStart);
  const lines = after.split('\n');
  let consumed = 0;
  for (const line of lines) {
    if (line.length === 0) {
      consumed += line.length + 1;
      continue;
    }
    if (line[0] !== ' ' && line[0] !== '\t') break;
    consumed += line.length + 1;
  }
  const bodyEnd = Math.min(bodyStart + consumed, fmBlock.length);
  return { headerStart, bodyStart, bodyEnd };
}

/**
 * Upsert one attestation record into the `attestations:` frontmatter list:
 * any existing record with the same (fact, actor) is replaced, then the whole
 * block is re-rendered. Robust to no key / inline `[]` / existing block, like
 * {@link appendStatusHistoryEntry}.
 */
export function upsertAttestation(fileContent: string, record: AttestationRecord): string {
  const fmMatch = fileContent.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!fmMatch) {
    throw new Error('No frontmatter found in assignment file. Expected --- delimiters.');
  }
  const fmBlock = fmMatch[2];

  const existing = parseAttestations(fmBlock);
  const next = existing.filter((r) => !(r.fact === record.fact && r.actor === record.actor));
  next.push(record);
  const rendered = `attestations:\n${next.map(renderAttestationItem).join('\n')}`;

  // Inline empty list `[]` OR a scalar `null`/`~` form — both parse as "no
  // records" but findAttestationsBlock (which requires an empty tail) skips the
  // scalar form, so handle both here to avoid appending a duplicate key.
  const scalarRegex = /^attestations:[ \t]*(\[[ \t]*\]|null|~)[ \t]*$/m;
  const block = findAttestationsBlock(fmBlock);

  let newFm: string;
  if (scalarRegex.test(fmBlock)) {
    newFm = fmBlock.replace(scalarRegex, rendered);
  } else if (block) {
    const before = fmBlock.slice(0, block.headerStart);
    const rest = fmBlock.slice(block.bodyEnd);
    const sep = rest.length > 0 && !rest.startsWith('\n') ? '\n' : '';
    newFm = `${before}${rendered}${sep}${rest}`;
  } else {
    newFm = `${fmBlock.replace(/\n+$/, '')}\n${rendered}`;
  }
  return `${fmMatch[1]}${newFm}${fmMatch[3]}${fileContent.slice(fmMatch[0].length)}`;
}

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
