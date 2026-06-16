import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { extractFrontmatter, getField } from '../dashboard/parser.js';
import { ensureDir, fileExists, writeFileForce } from '../utils/fs.js';
import type {
  TodoItem,
  TodoChecklist,
  TodoStatus,
  ArchiveInterval,
  LogEntry,
  TodoLog,
} from './types.js';

// --- Short ID ---

export function generateShortId(): string {
  return randomBytes(2).toString('hex');
}

export function generateUniqueId(existingIds: Set<string>): string {
  let id = generateShortId();
  let attempts = 0;
  while (existingIds.has(id) && attempts < 100) {
    id = generateShortId();
    attempts++;
  }
  return id;
}

// --- Checklist parsing ---

const ITEM_REGEX = /^- \[([ x!]|>[^\]]*)\]\s+(.+)$/;
const ID_REGEX = /\[t:([a-f0-9]{4})\]/;
const TAG_REGEX = /#([a-zA-Z0-9_-]+)/g;
// Meta token follows `[t:<id>]` and looks like `<key=value;key=value;...>`.
// Anchored at end of line. Recognized keys: b (branch), w (worktreePath),
// c (createdAt), u (updatedAt), p (planDir), l (linkedAssignmentId),
// lr (linkedAssignmentRef). Unknown keys are dropped.
const META_TOKEN_REGEX = /\[t:[a-f0-9]{4}\]\s+<([^>]*)>\s*$/;
const META_ENCODE_CHARS = ['%', '<', '>', '[', ']', '=', ';', '\n', '\r'];

export function encodeMetaValue(value: string): string {
  let out = '';
  for (const ch of value) {
    if (META_ENCODE_CHARS.includes(ch)) {
      out += '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
    } else {
      out += ch;
    }
  }
  return out;
}

export function decodeMetaValue(value: string): string {
  return value.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

interface MetaFields {
  branch: string | null;
  worktreePath: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  planDir: string | null;
  linkedAssignmentId: string | null;
  linkedAssignmentRef: string | null;
  bundleId: string | null;
}

function emptyMetaFields(): MetaFields {
  return {
    branch: null,
    worktreePath: null,
    createdAt: null,
    updatedAt: null,
    planDir: null,
    linkedAssignmentId: null,
    linkedAssignmentRef: null,
    bundleId: null,
  };
}

export function parseMetaToken(line: string): MetaFields {
  const match = line.match(META_TOKEN_REGEX);
  if (!match) return emptyMetaFields();
  const body = match[1];
  if (!body) return emptyMetaFields();
  const fields = emptyMetaFields();
  for (const pair of body.split(';')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const rawValue = trimmed.slice(eq + 1);
    const value = decodeMetaValue(rawValue);
    switch (key) {
      case 'b': fields.branch = value; break;
      case 'w': fields.worktreePath = value; break;
      case 'c': fields.createdAt = value; break;
      case 'u': fields.updatedAt = value; break;
      case 'p': fields.planDir = value; break;
      case 'l': fields.linkedAssignmentId = value; break;
      case 'lr': fields.linkedAssignmentRef = value; break;
      case 'bn': fields.bundleId = value; break;
    }
  }
  return fields;
}

export function serializeMetaToken(item: TodoItem): string {
  const pairs: string[] = [];
  if (item.branch !== null) pairs.push(`b=${encodeMetaValue(item.branch)}`);
  if (item.worktreePath !== null) pairs.push(`w=${encodeMetaValue(item.worktreePath)}`);
  if (item.createdAt !== null) pairs.push(`c=${encodeMetaValue(item.createdAt)}`);
  if (item.updatedAt !== null) pairs.push(`u=${encodeMetaValue(item.updatedAt)}`);
  if (item.planDir !== null) pairs.push(`p=${encodeMetaValue(item.planDir)}`);
  if (item.linkedAssignmentId !== null) pairs.push(`l=${encodeMetaValue(item.linkedAssignmentId)}`);
  if (item.linkedAssignmentRef !== null) pairs.push(`lr=${encodeMetaValue(item.linkedAssignmentRef)}`);
  if (item.bundleId !== null) pairs.push(`bn=${encodeMetaValue(item.bundleId)}`);
  if (pairs.length === 0) return '';
  return `<${pairs.join(';')}>`;
}

function parseStatus(marker: string): { status: TodoStatus; session: string | null } {
  if (marker === ' ') return { status: 'open', session: null };
  if (marker === 'x') return { status: 'completed', session: null };
  if (marker === '!') return { status: 'blocked', session: null };
  if (marker.startsWith('>:')) return { status: 'in_progress', session: marker.slice(2) };
  if (marker === '>') return { status: 'in_progress', session: null };
  return { status: 'open', session: null };
}

function sanitizeSession(session: string): string {
  // Strip characters that would break the markdown checkbox syntax
  return session.replace(/[\[\]]/g, '');
}

function statusToMarker(item: TodoItem): string {
  switch (item.status) {
    case 'open':
      return ' ';
    case 'completed':
      return 'x';
    case 'blocked':
      return '!';
    case 'in_progress':
      return item.session ? `>:${sanitizeSession(item.session)}` : '>';
  }
}

/**
 * Escape backslash-special characters in a todo description so that prose
 * containing `#`, `[`, or `\` is never mistaken for a structural tag/id token.
 * Order matters: backslash must be escaped first.
 */
function escapeDescription(description: string): string {
  return description.replace(/\\/g, '\\\\').replace(/#/g, '\\#').replace(/\[/g, '\\[');
}

/**
 * Reverse of escapeDescription: `\#`→`#`, `\[`→`[`, `\\`→`\`.
 * A single pass handles all sequences correctly because escapes are
 * non-overlapping (a `\` always pairs with the following char).
 */
function unescapeDescription(escaped: string): string {
  let out = '';
  for (let i = 0; i < escaped.length; i++) {
    if (escaped[i] === '\\' && i + 1 < escaped.length) {
      const next = escaped[i + 1];
      if (next === '\\' || next === '#' || next === '[') {
        out += next;
        i++;
        continue;
      }
    }
    out += escaped[i];
  }
  return out;
}

/**
 * Find the index in `rest` of the first UN-escaped structural token: either a
 * `#tag` start (`#` followed by a tag char) or a `[t:` / `[` bracket. A token is
 * "escaped" when preceded by an odd number of backslashes. Returns the length of
 * `rest` if no structural token exists (whole line is description).
 */
function findStructuralCut(rest: string): number {
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch !== '#' && ch !== '[') continue;
    // Count preceding backslashes to determine escaped-ness.
    let backslashes = 0;
    let j = i - 1;
    while (j >= 0 && rest[j] === '\\') {
      backslashes++;
      j--;
    }
    if (backslashes % 2 === 1) continue; // escaped — part of the description
    if (ch === '#') {
      // Only a structural tag if followed by a tag char.
      if (/[a-zA-Z0-9_-]/.test(rest[i + 1] ?? '')) return i;
    } else {
      // ch === '[' — any unescaped bracket starts the structural tail.
      return i;
    }
  }
  return rest.length;
}

export function parseChecklistItem(line: string): TodoItem | null {
  const match = line.match(ITEM_REGEX);
  if (!match) return null;

  const marker = match[1];
  const rest = match[2];

  const { status, session } = parseStatus(marker);

  // Split the line at the first UN-escaped structural token. Everything before
  // is the (escaped) description; everything after is the structural tail from
  // which tags / id / meta are extracted. This keeps escaped prose like `\#42`
  // out of the tag collection.
  const cut = findStructuralCut(rest);
  const description = unescapeDescription(rest.slice(0, cut).trim());
  const tail = rest.slice(cut);

  const idMatch = tail.match(ID_REGEX);
  const id = idMatch ? idMatch[1] : '';

  const tags: string[] = [];
  let tagMatch;
  const tagRegex = new RegExp(TAG_REGEX.source, 'g');
  while ((tagMatch = tagRegex.exec(tail)) !== null) {
    tags.push(tagMatch[1]);
  }

  const meta = parseMetaToken(line);

  return {
    id,
    description,
    status,
    tags,
    session,
    branch: meta.branch,
    worktreePath: meta.worktreePath,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    planDir: meta.planDir,
    linkedAssignmentId: meta.linkedAssignmentId,
    linkedAssignmentRef: meta.linkedAssignmentRef,
    bundleId: meta.bundleId,
  };
}

export function serializeChecklistItem(item: TodoItem): string {
  const marker = statusToMarker(item);
  const tagStr = item.tags.map((t) => `#${t}`).join(' ');
  // Escape backslash-special chars in the description so prose `#`/`[`/`\` is
  // never re-parsed as a structural tag/id token. Real tags and `[t:id]` below
  // are emitted with literal, unescaped markers.
  const parts = [`- [${marker}] ${escapeDescription(item.description)}`];
  if (tagStr) parts.push(tagStr);
  parts.push(`[t:${item.id}]`);
  const meta = serializeMetaToken(item);
  if (meta) parts.push(meta);
  return parts.join(' ');
}

export function parseChecklist(content: string): TodoChecklist {
  const [fm, body] = extractFrontmatter(content);
  const workspace = getField(fm, 'workspace') || '_global';
  const archiveIntervalRaw = getField(fm, 'archiveInterval') || 'weekly';
  const archiveInterval = (['daily', 'weekly', 'monthly', 'never'].includes(archiveIntervalRaw)
    ? archiveIntervalRaw
    : 'weekly') as ArchiveInterval;

  const items: TodoItem[] = [];
  for (const line of body.split('\n')) {
    const item = parseChecklistItem(line);
    if (item) items.push(item);
  }

  return { workspace, archiveInterval, items };
}

export function serializeChecklist(checklist: TodoChecklist): string {
  const fm = [
    '---',
    `workspace: ${checklist.workspace}`,
    `archiveInterval: ${checklist.archiveInterval}`,
    '---',
  ].join('\n');

  const header = '# Quick Todos';
  const items = checklist.items.map(serializeChecklistItem).join('\n');

  return `${fm}\n\n${header}\n\n${items}\n`;
}

// --- Log parsing ---

export function parseLog(content: string): TodoLog {
  const [fm, body] = extractFrontmatter(content);
  const workspace = getField(fm, 'workspace') || '_global';

  const entries: LogEntry[] = [];
  const sections = body.split(/^### /m).filter((s) => s.match(/^\d{4}-/));

  for (const section of sections) {
    const lines = section.split('\n');
    const heading = lines[0]?.trim() || '';

    // Heading format: 2026-04-07T14:30:00Z — t:a3f1, t:b7c2
    const headingMatch = heading.match(/^(\S+)\s*—?\s*(.*)/);
    if (!headingMatch) continue;

    const timestamp = headingMatch[1];
    const idsPart = headingMatch[2] || '';
    const itemIds = [...idsPart.matchAll(/t:([a-f0-9]{4})/g)].map((m) => m[1]);

    const entry: LogEntry = {
      timestamp,
      itemIds,
      items: '',
      session: null,
      branch: null,
      summary: '',
      blockers: null,
      status: null,
    };

    for (const line of lines.slice(1)) {
      const fieldMatch = line.match(/^\*\*(\w+):\*\*\s*(.*)/);
      if (!fieldMatch) continue;
      const key = fieldMatch[1].toLowerCase();
      const value = fieldMatch[2].trim();
      switch (key) {
        case 'items':
          entry.items = value;
          break;
        case 'session':
          entry.session = value;
          break;
        case 'branch':
          entry.branch = value;
          break;
        case 'summary':
          entry.summary = value;
          break;
        case 'blockers':
          entry.blockers = value;
          break;
        case 'status':
          entry.status = value;
          break;
      }
    }

    entries.push(entry);
  }

  return { workspace, entries };
}

export function serializeLogEntry(entry: LogEntry): string {
  const idStr = entry.itemIds.map((id) => `t:${id}`).join(', ');
  const lines = [`### ${entry.timestamp} — ${idStr}`];
  if (entry.items) lines.push(`**Items:** ${entry.items}`);
  if (entry.session) lines.push(`**Session:** ${entry.session}`);
  if (entry.branch) lines.push(`**Branch:** ${entry.branch}`);
  if (entry.summary) lines.push(`**Summary:** ${entry.summary}`);
  if (entry.blockers) lines.push(`**Blockers:** ${entry.blockers}`);
  if (entry.status) lines.push(`**Status:** ${entry.status}`);
  return lines.join('\n');
}

/**
 * Serialize a full todo log file (frontmatter + header + entries) in the exact
 * format `readLog`/`appendLogEntry` produce. Uses the canonical
 * `serializeLogEntry` so no entry field (incl. `status`) is dropped. Callers
 * that rewrite a trimmed log should use this rather than hand-building lines.
 */
export function serializeLog(log: TodoLog): string {
  const header = `---\nworkspace: ${log.workspace}\n---\n\n# Todo Log\n`;
  if (log.entries.length === 0) {
    return header;
  }
  return header + '\n' + log.entries.map(serializeLogEntry).join('\n\n') + '\n';
}

// --- File I/O ---

export function checklistPath(todosDir: string, workspace: string): string {
  return resolve(todosDir, `${workspace}.md`);
}

export function logPath(todosDir: string, workspace: string): string {
  return resolve(todosDir, `${workspace}-log.md`);
}

export function archivePath(
  todosDir: string,
  workspace: string,
  interval: ArchiveInterval,
  now: Date = new Date(),
): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');

  let suffix: string;
  switch (interval) {
    case 'daily':
      suffix = `${year}-${month}-${day}`;
      break;
    case 'weekly': {
      // ISO week number
      const jan1 = new Date(year, 0, 1);
      const days = Math.floor((now.getTime() - jan1.getTime()) / 86400000);
      const week = String(Math.ceil((days + jan1.getDay() + 1) / 7)).padStart(2, '0');
      suffix = `${year}-W${week}`;
      break;
    }
    case 'monthly':
      suffix = `${year}-${month}`;
      break;
    default:
      suffix = `${year}-${month}-${day}`;
  }

  return resolve(todosDir, 'archive', `${workspace}-${suffix}.md`);
}

export async function readChecklist(todosDir: string, workspace: string): Promise<TodoChecklist> {
  const path = checklistPath(todosDir, workspace);
  if (!(await fileExists(path))) {
    return { workspace, archiveInterval: 'weekly', items: [] };
  }
  const content = await readFile(path, 'utf-8');
  return parseChecklist(content);
}

export async function writeChecklist(todosDir: string, checklist: TodoChecklist): Promise<void> {
  await ensureDir(todosDir);
  const path = checklistPath(todosDir, checklist.workspace);
  await writeFileForce(path, serializeChecklist(checklist));
}

export async function readLog(todosDir: string, workspace: string): Promise<TodoLog> {
  const path = logPath(todosDir, workspace);
  if (!(await fileExists(path))) {
    return { workspace, entries: [] };
  }
  const content = await readFile(path, 'utf-8');
  return parseLog(content);
}

export async function appendLogEntry(
  todosDir: string,
  workspace: string,
  entry: LogEntry,
): Promise<void> {
  await ensureDir(todosDir);
  const path = logPath(todosDir, workspace);
  let content: string;
  if (await fileExists(path)) {
    content = await readFile(path, 'utf-8');
    content = content.trimEnd() + '\n\n' + serializeLogEntry(entry) + '\n';
  } else {
    const fm = `---\nworkspace: ${workspace}\n---\n\n# Todo Log\n\n`;
    content = fm + serializeLogEntry(entry) + '\n';
  }
  await writeFileForce(path, content);
}

export function computeCounts(items: TodoItem[]) {
  const counts = { open: 0, in_progress: 0, completed: 0, blocked: 0, total: items.length };
  for (const item of items) {
    counts[item.status]++;
  }
  return counts;
}
