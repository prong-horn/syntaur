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
// c (createdAt), u (updatedAt), p (planDir). Unknown keys are dropped.
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
}

function emptyMetaFields(): MetaFields {
  return { branch: null, worktreePath: null, createdAt: null, updatedAt: null, planDir: null };
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

export function parseChecklistItem(line: string): TodoItem | null {
  const match = line.match(ITEM_REGEX);
  if (!match) return null;

  const marker = match[1];
  const rest = match[2];

  const { status, session } = parseStatus(marker);

  const idMatch = rest.match(ID_REGEX);
  const id = idMatch ? idMatch[1] : '';

  const tags: string[] = [];
  let tagMatch;
  const tagRegex = new RegExp(TAG_REGEX.source, 'g');
  while ((tagMatch = tagRegex.exec(rest)) !== null) {
    tags.push(tagMatch[1]);
  }

  // Description is everything before the first #tag or [t:...], trimmed
  let description = rest;
  const firstTagIdx = rest.search(/#[a-zA-Z0-9_-]/);
  const firstIdIdx = rest.search(/\[t:[a-f0-9]{4}\]/);
  const cutPoints = [firstTagIdx, firstIdIdx].filter((i) => i >= 0);
  if (cutPoints.length > 0) {
    description = rest.slice(0, Math.min(...cutPoints)).trim();
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
  };
}

export function serializeChecklistItem(item: TodoItem): string {
  const marker = statusToMarker(item);
  const tagStr = item.tags.map((t) => `#${t}`).join(' ');
  const parts = [`- [${marker}] ${item.description}`];
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
