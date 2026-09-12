/**
 * `syntaur migrate v2` — one-time migration from v1 / Phase-A layout to v2
 * id-prefixed ticket folders and colon-free keys (plan decision 8, task 9).
 *
 * Dry-run by default. Sets `SYNTAUR_HOME` from `--root` BEFORE any helper touch;
 * all paths derive from `<root>` directly — never from config.defaultProjectDir.
 */

import { Command } from 'commander';
import { cp, readFile, readdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { expandHome, syntaurRoot } from '../utils/paths.js';
import { ensureDir, fileExists, writeFileForce } from '../utils/fs.js';
import { derivePrefix } from '../utils/ticket-ids.js';
import { formatTicketFolderName, parseTicketFolderName } from '../utils/ticket-folder.js';
import { parseTicketFrontmatter } from '../lifecycle/frontmatter.js';
import { renderProject } from '../templates/project.js';
import { rebuildChatIndex } from '../chat/store.js';
import {
  closeSessionDb,
  initSessionDb,
  resetSessionDb,
} from '../dashboard/session-db.js';
import { closeEventsDb, initEventsDb, resetEventsDb } from '../db/events-db.js';
import { closeUsageDb, initUsageDb, resetUsageDb } from '../db/usage-db.js';

export const V2_MIGRATED_MARKER = 'v2-migrated';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPACT_TS_RE = /^\d{8}T\d{6}Z$/;

const SIDECAR_FILES = [
  'progress.md',
  'comments.md',
  'handoff.md',
  'scratchpad.md',
  'plan.md',
  'decision-record.md',
];

export interface MigrateV2Options {
  root?: string;
  apply?: boolean;
  /** Repeated `slug=PFX` overrides from `--prefix`. */
  prefix?: string[];
}

interface DiscoveredTicket {
  uuid: string;
  slug: string;
  status: string;
  created: string;
  oldFolder: string;
  ticketMdRel: string;
  ticketDir: string;
  ticketMdPath: string;
  isStandalone: boolean;
  projectSlug: string | null;
  newId: string;
  newFolder: string;
}

interface ProjectPlan {
  slug: string;
  projectDir: string;
  prefix: string;
  nextTicket: number;
  tickets: DiscoveredTicket[];
}

interface MigrationMaps {
  uuidToId: Map<string, string>;
  slugToId: Map<string, string>;
  projectSlugToId: Map<string, Map<string, string>>;
  itemIdMap: Map<string, string>;
}

export interface MigrateV2Transcript {
  lines: string[];
}

function logLine(lines: string[], mode: string, text: string): void {
  const line = `${mode}${text}`;
  lines.push(line);
  console.log(line);
}

function parsePrefixOverrides(raw: string[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of raw ?? []) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new Error(`Invalid --prefix "${pair}" — expected slug=PFX`);
    }
    const slug = pair.slice(0, eq);
    const pfx = pair.slice(eq + 1).toUpperCase();
    if (!/^[A-Z]{2,5}$/.test(pfx)) {
      throw new Error(`Invalid prefix "${pfx}" for project "${slug}" — use 2–5 uppercase letters`);
    }
    out.set(slug, pfx);
  }
  return out;
}

function replaceFrontmatterScalar(content: string, key: string, value: string): string {
  const fieldRegex = new RegExp(`^(${key}:)\\s*.*$`, 'm');
  if (fieldRegex.test(content)) {
    return content.replace(fieldRegex, `$1 ${value}`);
  }
  const closeIdx = content.indexOf('\n---', 4);
  if (closeIdx === -1) return content;
  return `${content.slice(0, closeIdx)}\n${key}: ${value}${content.slice(closeIdx)}`;
}

function mapListField(
  content: string,
  field: 'dependsOn' | 'links',
  mapper: (ref: string) => string,
): string {
  const inline = new RegExp(`^${field}:\\s*\\[\\s*\\]`, 'm');
  if (inline.test(content)) return content;

  const block = new RegExp(`^${field}:\\s*\\n((?:\\s+-\\s+.*\\n?)*)`, 'm');
  const match = content.match(block);
  if (!match) return content;

  const mapped = match[1].replace(/^\s+-\s+(.+)$/gm, (_, raw: string) => {
    const trimmed = raw.trim().replace(/^["']|["']$/g, '');
    return `  - ${mapper(trimmed)}`;
  });
  return content.replace(block, `${field}:\n${mapped}`);
}

function updateProjectMd(
  content: string,
  prefix: string,
  nextTicket: number,
): string {
  let next = content;
  next = replaceFrontmatterScalar(next, 'prefix', prefix);
  next = replaceFrontmatterScalar(next, 'nextTicket', String(nextTicket));
  if (!/^defaultTemplate:\s*/m.test(next)) {
    next = replaceFrontmatterScalar(next, 'defaultTemplate', 'feature');
  }
  return next;
}

export function migrateSessionKey(
  sessionKey: string,
  uuidToId: Map<string, string>,
): string {
  if (!sessionKey.includes(':')) return sessionKey;
  const colonIdx = sessionKey.indexOf(':');
  const first = sessionKey.slice(0, colonIdx);
  const rest = sessionKey.slice(colonIdx + 1);
  const id = uuidToId.get(first);
  if (!id) return sessionKey;
  if (rest === '@assignment') return `${id}~@ticket`;
  return `${id}~${rest}`;
}

export function migrateItemId(
  itemId: string,
  uuidToId: Map<string, string>,
  itemIdMap: Map<string, string>,
): string {
  if (itemIdMap.has(itemId)) return itemIdMap.get(itemId)!;

  const replay = itemId.match(/^replay:(\d+):(\d+)$/);
  if (replay) return `replay~${replay[1]}~${replay[2]}`;

  const sessionScoped = itemId.match(/^session:([^:]+):([^:]+):(\d+)$/);
  if (sessionScoped) {
    const uuid = sessionScoped[1];
    const harness = sessionScoped[2];
    const n = sessionScoped[3];
    const id = uuidToId.get(uuid) ?? uuid;
    return `session~${id}~${harness}~${n}`;
  }

  const turnScoped = itemId.match(/^([0-9a-f-]{36}):(\d+)$/i);
  if (turnScoped) {
    const uuid = turnScoped[1];
    const n = turnScoped[2];
    const id = uuidToId.get(uuid);
    return id ? `${id}~${n}` : `${uuid}~${n}`;
  }

  if (itemId.includes(':')) {
    const parts = itemId.split(':');
    if (uuidToId.has(parts[0])) {
      parts[0] = uuidToId.get(parts[0])!;
      return parts.join('~');
    }
  }

  return itemId;
}

export function migrateSnoozeKey(
  key: string,
  uuidToId: Map<string, string>,
  itemIdMap: Map<string, string>,
): string {
  if (itemIdMap.has(key)) return itemIdMap.get(key)!;
  if (!key.includes(':')) return key;

  const colonIdx = key.indexOf(':');
  const first = key.slice(0, colonIdx);
  const rest = key.slice(colonIdx + 1);

  // `<UUID>:<category>` or `<UUID>:<compact-ts>`
  const idFromFirst = uuidToId.get(first);
  if (idFromFirst) return `${idFromFirst}~${rest}`;

  // `<category>:<UUID>` (legacy inbox row key)
  const idFromRest = uuidToId.get(rest);
  if (idFromRest && UUID_RE.test(rest)) return `${idFromRest}~${first}`;

  // Chat item ids and other colon forms
  return migrateItemId(key, uuidToId, itemIdMap);
}

function migratePayloadValue(
  value: unknown,
  uuidToId: Map<string, string>,
  itemIdMap: Map<string, string>,
): unknown {
  if (typeof value === 'string') {
    if (value.includes(':')) {
      if (UUID_RE.test(value) && uuidToId.has(value)) return uuidToId.get(value)!;
      return migrateItemId(value, uuidToId, itemIdMap);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => migratePayloadValue(v, uuidToId, itemIdMap));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = migratePayloadValue(v, uuidToId, itemIdMap);
    }
    return out;
  }
  return value;
}

function migratePayloadKeys(
  value: unknown,
  uuidToId: Map<string, string>,
  itemIdMap: Map<string, string>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => migratePayloadKeys(v, uuidToId, itemIdMap));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'assignmentId' && typeof v === 'string') {
        out.ticketId = uuidToId.get(v) ?? v;
        continue;
      }
      out[k] = migratePayloadKeys(v, uuidToId, itemIdMap);
    }
    return out;
  }
  return migratePayloadValue(value, uuidToId, itemIdMap);
}

function migrateChatEventLine(
  line: string,
  uuidToId: Map<string, string>,
  itemIdMap: Map<string, string>,
): string {
  if (!line.trim()) return line;
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (typeof event.assignmentId === 'string') {
      event.ticketId = uuidToId.get(event.assignmentId) ?? event.assignmentId;
      delete event.assignmentId;
    } else if (typeof event.ticketId === 'string') {
      event.ticketId = uuidToId.get(event.ticketId) ?? event.ticketId;
    }
    if (typeof event.sessionKey === 'string') {
      event.sessionKey = migrateSessionKey(event.sessionKey, uuidToId);
    }
    if ('payload' in event) {
      event.payload = migratePayloadKeys(event.payload, uuidToId, itemIdMap);
    }
    return `${JSON.stringify(event)}\n`;
  } catch {
    return line.endsWith('\n') ? line : `${line}\n`;
  }
}

function tableColumns(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

async function discoverTicketMd(
  ticketDir: string,
  folderName: string,
): Promise<{ path: string; rel: string } | null> {
  const assignmentMd = resolve(ticketDir, folderName, 'assignment.md');
  const ticketMd = resolve(ticketDir, folderName, 'ticket.md');
  if (await fileExists(assignmentMd)) return { path: assignmentMd, rel: 'assignment.md' };
  if (await fileExists(ticketMd)) return { path: ticketMd, rel: 'ticket.md' };
  return null;
}

async function discoverProjectTickets(
  projectSlug: string,
  projectDir: string,
): Promise<DiscoveredTicket[]> {
  const tickets: DiscoveredTicket[] = [];
  for (const sub of ['assignments', 'tickets'] as const) {
    const base = resolve(projectDir, sub);
    if (!(await fileExists(base))) continue;
    const entries = await readdir(base, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) {
        continue;
      }
      if (parseTicketFolderName(entry.name)) continue;
      const md = await discoverTicketMd(base, entry.name);
      if (!md) continue;
      const content = await readFile(md.path, 'utf-8');
      const fm = parseTicketFrontmatter(content);
      if (!fm.id || !fm.slug) continue;
      tickets.push({
        uuid: fm.id,
        slug: fm.slug,
        status: fm.status,
        created: fm.created || '',
        oldFolder: entry.name,
        ticketMdRel: md.rel,
        ticketDir: resolve(base, entry.name),
        ticketMdPath: md.path,
        isStandalone: false,
        projectSlug,
        newId: '',
        newFolder: '',
      });
    }
  }
  return tickets;
}

async function discoverStandaloneTickets(home: string): Promise<DiscoveredTicket[]> {
  const base = resolve(home, 'tickets');
  if (!(await fileExists(base))) return [];
  const tickets: DiscoveredTicket[] = [];
  const entries = await readdir(base, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    if (parseTicketFolderName(entry.name)) continue;
    const md = await discoverTicketMd(base, entry.name);
    if (!md) continue;
    const content = await readFile(md.path, 'utf-8');
    const fm = parseTicketFrontmatter(content);
    if (!fm.id || !fm.slug) continue;
    tickets.push({
      uuid: fm.id,
      slug: fm.slug,
      status: fm.status,
      created: fm.created || '',
      oldFolder: entry.name,
      ticketMdRel: md.rel,
      ticketDir: resolve(base, entry.name),
      ticketMdPath: md.path,
      isStandalone: true,
      projectSlug: null,
      newId: '',
      newFolder: '',
    });
  }
  return tickets;
}

async function hasHalfAppliedTicketFolders(projectsDir: string): Promise<boolean> {
  if (!(await fileExists(projectsDir))) return false;
  const projects = await readdir(projectsDir, { withFileTypes: true });
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    for (const sub of ['assignments', 'tickets']) {
      const base = resolve(projectsDir, project.name, sub);
      if (!(await fileExists(base))) continue;
      const entries = await readdir(base, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && parseTicketFolderName(entry.name)) return true;
      }
    }
  }
  return false;
}

function buildMaps(plans: ProjectPlan[], standalone: DiscoveredTicket[]): MigrationMaps {
  const uuidToId = new Map<string, string>();
  const slugToId = new Map<string, string>();
  const projectSlugToId = new Map<string, Map<string, string>>();
  const itemIdMap = new Map<string, string>();

  for (const plan of plans) {
    const perProject = new Map<string, string>();
    for (const t of plan.tickets) {
      uuidToId.set(t.uuid, t.newId);
      slugToId.set(`${plan.slug}:${t.slug}`, t.newId);
      perProject.set(t.slug, t.newId);
    }
    projectSlugToId.set(plan.slug, perProject);
  }
  for (const t of standalone) {
    uuidToId.set(t.uuid, t.newId);
    slugToId.set(`scratch:${t.slug}`, t.newId);
  }

  return { uuidToId, slugToId, projectSlugToId, itemIdMap };
}

function mapTicketRef(
  ref: string,
  projectSlug: string | null,
  maps: MigrationMaps,
): string {
  if (maps.uuidToId.has(ref)) return maps.uuidToId.get(ref)!;
  if (projectSlug) {
    const per = maps.projectSlugToId.get(projectSlug);
    if (per?.has(ref)) return per.get(ref)!;
  }
  for (const per of maps.projectSlugToId.values()) {
    if (per.has(ref)) return per.get(ref)!;
  }
  if (maps.slugToId.has(`scratch:${ref}`)) return maps.slugToId.get(`scratch:${ref}`)!;
  return ref;
}

async function rewriteSidecarTicketField(
  path: string,
  projectSlug: string | null,
  maps: MigrationMaps,
): Promise<void> {
  if (!(await fileExists(path))) return;
  const content = await readFile(path, 'utf-8');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return;
  const ticketVal = fmMatch[1].match(/^ticket:\s*(.*)$/m)?.[1]?.trim() ?? '';
  const bare = ticketVal.replace(/^["']|["']$/g, '');
  const mapped = mapTicketRef(bare, projectSlug, maps);
  if (mapped === bare) return;
  const next = replaceFrontmatterScalar(content, 'ticket', mapped);
  await writeFileForce(path, next);
}

async function rewriteCommentsItemMarkers(
  path: string,
  maps: MigrationMaps,
): Promise<void> {
  if (!(await fileExists(path))) return;
  let content = await readFile(path, 'utf-8');
  const next = content.replace(/item="([^"]+)"/g, (_, itemId: string) => {
    const migrated = migrateItemId(itemId, maps.uuidToId, maps.itemIdMap);
    maps.itemIdMap.set(itemId, migrated);
    return `item="${migrated}"`;
  });
  if (next !== content) await writeFileForce(path, next);
}

async function migrateChatEventsFile(
  ticketDir: string,
  maps: MigrationMaps,
): Promise<boolean> {
  const eventsPath = resolve(ticketDir, 'chat', 'events.jsonl');
  if (!(await fileExists(eventsPath))) return false;
  const raw = await readFile(eventsPath, 'utf-8');
  const lines = raw.split('\n');
  const out = lines
    .map((line) => (line.trim() ? migrateChatEventLine(line, maps.uuidToId, maps.itemIdMap) : ''))
    .join('\n');
  const normalized = out.endsWith('\n') || out.length === 0 ? out : `${out}\n`;
  await writeFileForce(eventsPath, normalized);
  return true;
}

function rekeyDatabase(
  dbPath: string,
  maps: MigrationMaps,
): {
  events: number;
  engagementByUuid: number;
  engagementBySlug: number;
  chatSessionsTicket: number;
  chatSessionsKey: number;
  chatItemsSessionKey: number;
  chatItemsTicket: number;
  usageEvents: number;
  usageDaily: number;
} {
  const database = new Database(dbPath);
  database.pragma('journal_mode = WAL');
  const counts = {
    events: 0,
    engagementByUuid: 0,
    engagementBySlug: 0,
    chatSessionsTicket: 0,
    chatSessionsKey: 0,
    chatItemsSessionKey: 0,
    chatItemsTicket: 0,
    usageEvents: 0,
    usageDaily: 0,
  };

  const eventsCols = tableColumns(database, 'events');
  const ticketCol = eventsCols.has('ticket_id') ? 'ticket_id' : 'assignment_id';
  if (eventsCols.has(ticketCol)) {
    for (const [uuid, id] of maps.uuidToId) {
      const r = database
        .prepare(`UPDATE events SET ${ticketCol} = ? WHERE ${ticketCol} = ?`)
        .run(id, uuid);
      counts.events += r.changes;
    }
  }

  const engagementCols = tableColumns(database, 'engagement');
  const engTicketCol = engagementCols.has('ticket_id') ? 'ticket_id' : 'assignment_id';
  if (engagementCols.has(engTicketCol)) {
    for (const [uuid, id] of maps.uuidToId) {
      const r = database
        .prepare(
          `UPDATE engagement SET ${engTicketCol} = ? WHERE ${engTicketCol} = ? AND ${engTicketCol} IS NOT NULL AND ${engTicketCol} != ''`,
        )
        .run(id, uuid);
      counts.engagementByUuid += r.changes;
    }
    if (engagementCols.has('project_slug') && engagementCols.has('assignment_slug')) {
      for (const [key, id] of maps.slugToId) {
        const [project, slug] = key.split(':');
        const r = database
          .prepare(
            `UPDATE engagement SET ${engTicketCol} = ? WHERE (${engTicketCol} IS NULL OR ${engTicketCol} = '') AND project_slug = ? AND assignment_slug = ?`,
          )
          .run(id, project, slug);
        counts.engagementBySlug += r.changes;
      }
    }
  }

  const chatSessionCols = tableColumns(database, 'chat_sessions');
  const chatTicketCol = chatSessionCols.has('ticket_id') ? 'ticket_id' : 'assignment_id';
  if (chatSessionCols.has(chatTicketCol)) {
    for (const [uuid, id] of maps.uuidToId) {
      counts.chatSessionsTicket += database
        .prepare(`UPDATE chat_sessions SET ${chatTicketCol} = ? WHERE ${chatTicketCol} = ?`)
        .run(id, uuid).changes;
    }
    const sessions = database
      .prepare('SELECT session_key FROM chat_sessions')
      .all() as Array<{ session_key: string }>;
    for (const row of sessions) {
      const next = migrateSessionKey(row.session_key, maps.uuidToId);
      if (next !== row.session_key) {
        counts.chatSessionsKey += database
          .prepare('UPDATE chat_sessions SET session_key = ? WHERE session_key = ?')
          .run(next, row.session_key).changes;
      }
    }
  }

  const chatItemCols = tableColumns(database, 'chat_items');
  const chatItemTicketCol = chatItemCols.has('ticket_id') ? 'ticket_id' : 'assignment_id';
  if (chatItemCols.has(chatItemTicketCol)) {
    for (const [uuid, id] of maps.uuidToId) {
      counts.chatItemsTicket += database
        .prepare(`UPDATE chat_items SET ${chatItemTicketCol} = ? WHERE ${chatItemTicketCol} = ?`)
        .run(id, uuid).changes;
    }
    const items = database
      .prepare('SELECT item_id, session_key FROM chat_items')
      .all() as Array<{ item_id: string; session_key: string }>;
    for (const row of items) {
      const nextItem = migrateItemId(row.item_id, maps.uuidToId, maps.itemIdMap);
      maps.itemIdMap.set(row.item_id, nextItem);
      const nextKey = migrateSessionKey(row.session_key, maps.uuidToId);
      if (nextItem !== row.item_id || nextKey !== row.session_key) {
        database
          .prepare(
            'UPDATE chat_items SET item_id = ?, session_key = ? WHERE item_id = ?',
          )
          .run(nextItem, nextKey, row.item_id);
        if (nextKey !== row.session_key) counts.chatItemsSessionKey += 1;
      }
    }
  }

  const usageEventCols = tableColumns(database, 'usage_events');
  const usageTicketCol = usageEventCols.has('ticket_id')
    ? 'ticket_id'
    : usageEventCols.has('assignment_slug')
      ? 'assignment_slug'
      : null;
  if (usageTicketCol) {
    for (const [uuid, id] of maps.uuidToId) {
      counts.usageEvents += database
        .prepare(`UPDATE usage_events SET ${usageTicketCol} = ? WHERE ${usageTicketCol} = ?`)
        .run(id, uuid).changes;
    }
    for (const [key, id] of maps.slugToId) {
      const [, slug] = key.split(':');
      counts.usageEvents += database
        .prepare(`UPDATE usage_events SET ${usageTicketCol} = ? WHERE ${usageTicketCol} = ?`)
        .run(id, slug).changes;
    }
  }

  const usageDailyCols = tableColumns(database, 'usage_daily');
  const dailyTicketCol = usageDailyCols.has('ticket_id')
    ? 'ticket_id'
    : usageDailyCols.has('assignment_slug')
      ? 'assignment_slug'
      : null;
  if (dailyTicketCol) {
    for (const [uuid, id] of maps.uuidToId) {
      counts.usageDaily += database
        .prepare(`UPDATE usage_daily SET ${dailyTicketCol} = ? WHERE ${dailyTicketCol} = ?`)
        .run(id, uuid).changes;
    }
    for (const [key, id] of maps.slugToId) {
      const [, slug] = key.split(':');
      counts.usageDaily += database
        .prepare(`UPDATE usage_daily SET ${dailyTicketCol} = ? WHERE ${dailyTicketCol} = ?`)
        .run(id, slug).changes;
    }
  }

  database.close();
  return counts;
}

async function createBackup(home: string): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = `${home}.bak-v2-${ts}`;
  await cp(home, backupDir, { recursive: true });
  const dbPath = resolve(home, 'syntaur.db');
  if (await fileExists(dbPath)) {
    const db = new Database(dbPath);
    await db.backup(resolve(backupDir, 'syntaur.db.pre-v2.bak'));
    db.close();
  }
  return backupDir;
}

async function ensureScratchProject(
  projectsDir: string,
  prefix: string,
  nextTicket: number,
): Promise<void> {
  const scratchDir = resolve(projectsDir, 'scratch');
  const projectMd = resolve(scratchDir, 'project.md');
  if (await fileExists(projectMd)) return;
  await ensureDir(scratchDir);
  const ts = new Date().toISOString();
  await writeFileForce(
    projectMd,
    renderProject({
      id: randomUUID(),
      slug: 'scratch',
      title: 'Scratch',
      timestamp: ts,
      prefix,
      nextTicket,
      defaultTemplate: 'feature',
    }),
  );
}

function retargetTicketDir(ticket: DiscoveredTicket, fromSub: string, toSub: string): void {
  const from = `${fromSub}/`;
  const to = `${toSub}/`;
  if (!ticket.ticketDir.includes(from)) return;
  ticket.ticketDir = ticket.ticketDir.replace(from, to);
  ticket.ticketMdPath = resolve(ticket.ticketDir, basename(ticket.ticketMdPath));
}

async function applyFilesystemMigration(
  home: string,
  plans: ProjectPlan[],
  standalone: DiscoveredTicket[],
  maps: MigrationMaps,
  scratchPrefix: string,
): Promise<void> {
  const projectsDir = resolve(home, 'projects');

  for (const plan of plans) {
    const assignmentsDir = resolve(plan.projectDir, 'assignments');
    const ticketsPath = resolve(plan.projectDir, 'tickets');
    if (await fileExists(assignmentsDir) && !(await fileExists(ticketsPath))) {
      await rename(assignmentsDir, ticketsPath);
      for (const ticket of plan.tickets) {
        retargetTicketDir(ticket, 'assignments', 'tickets');
      }
    }

    const indexAssignments = resolve(plan.projectDir, '_index-assignments.md');
    const indexTickets = resolve(plan.projectDir, '_index-tickets.md');
    if (await fileExists(indexAssignments) && !(await fileExists(indexTickets))) {
      await rename(indexAssignments, indexTickets);
    }

    let projectMd = await readFile(resolve(plan.projectDir, 'project.md'), 'utf-8');
    projectMd = updateProjectMd(projectMd, plan.prefix, plan.nextTicket);
    await writeFileForce(resolve(plan.projectDir, 'project.md'), projectMd);

    for (const ticket of plan.tickets) {
      let content = await readFile(ticket.ticketMdPath, 'utf-8');
      content = replaceFrontmatterScalar(content, 'id', ticket.newId);
      content = mapListField(content, 'dependsOn', (ref) =>
        mapTicketRef(ref, plan.slug, maps),
      );
      content = mapListField(content, 'links', (ref) => mapTicketRef(ref, plan.slug, maps));
      await writeFileForce(ticket.ticketMdPath, content);

      const ticketMdPath = resolve(ticket.ticketDir, 'ticket.md');
      if (ticket.ticketMdPath !== ticketMdPath && (await fileExists(ticket.ticketMdPath))) {
        await rename(ticket.ticketMdPath, ticketMdPath);
      }

      const parentDir = resolve(ticket.ticketDir, '..');
      const newDir = resolve(parentDir, ticket.newFolder);
      if (ticket.ticketDir !== newDir) {
        await rename(ticket.ticketDir, newDir);
        ticket.ticketDir = newDir;
        ticket.ticketMdPath = resolve(newDir, 'ticket.md');
      }

      for (const sidecar of SIDECAR_FILES) {
        await rewriteSidecarTicketField(resolve(ticket.ticketDir, sidecar), plan.slug, maps);
      }
      await rewriteCommentsItemMarkers(resolve(ticket.ticketDir, 'comments.md'), maps);
    }
  }

  if (standalone.length > 0) {
    const maxNum = standalone.reduce((max, t) => {
      const n = Number.parseInt(t.newId.split('-')[1] ?? '0', 10);
      return Math.max(max, n);
    }, 0);
    await ensureScratchProject(projectsDir, scratchPrefix, maxNum + 1);
    const scratchTickets = resolve(projectsDir, 'scratch', 'tickets');
    await ensureDir(scratchTickets);

    for (const ticket of standalone) {
      let content = await readFile(ticket.ticketMdPath, 'utf-8');
      content = replaceFrontmatterScalar(content, 'id', ticket.newId);
      content = replaceFrontmatterScalar(content, 'project', 'scratch');
      content = mapListField(content, 'dependsOn', (ref) => mapTicketRef(ref, 'scratch', maps));
      content = mapListField(content, 'links', (ref) => mapTicketRef(ref, 'scratch', maps));
      await writeFileForce(ticket.ticketMdPath, content);

      const ticketMdPath = resolve(ticket.ticketDir, 'ticket.md');
      if (ticket.ticketMdPath !== ticketMdPath) {
        await rename(ticket.ticketMdPath, ticketMdPath);
      }

      const dest = resolve(scratchTickets, ticket.newFolder);
      await rename(ticket.ticketDir, dest);
      ticket.ticketDir = dest;
      ticket.ticketMdPath = resolve(dest, 'ticket.md');

      for (const sidecar of SIDECAR_FILES) {
        await rewriteSidecarTicketField(resolve(ticket.ticketDir, sidecar), 'scratch', maps);
      }
      await rewriteCommentsItemMarkers(resolve(ticket.ticketDir, 'comments.md'), maps);
    }
  }
}

async function migrateChatAndRebuild(
  tickets: DiscoveredTicket[],
  maps: MigrationMaps,
): Promise<void> {
  const dbPath = resolve(syntaurRoot(), 'syntaur.db');
  resetSessionDb();
  resetEventsDb();
  resetUsageDb();
  initSessionDb(dbPath);
  initEventsDb(dbPath);
  initUsageDb(dbPath);

  for (const ticket of tickets) {
    const hadEvents = await migrateChatEventsFile(ticket.ticketDir, maps);
    if (hadEvents) {
      await rebuildChatIndex(ticket.ticketDir, ticket.newId);
    }
  }

  closeSessionDb();
  closeEventsDb();
  closeUsageDb();
  resetSessionDb();
  resetEventsDb();
  resetUsageDb();
}

async function rewriteInboxSnoozes(home: string, maps: MigrationMaps): Promise<void> {
  const path = resolve(home, 'inbox-snoozes.json');
  if (!(await fileExists(path))) return;
  const raw = await readFile(path, 'utf-8');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const migrated = migrateSnoozeKey(key, maps.uuidToId, maps.itemIdMap);
    if (!key.includes(':') || COMPACT_TS_RE.test(key.split(':')[1] ?? '')) {
      maps.itemIdMap.set(key, migrated);
    }
    next[migrated] = value;
  }
  await writeFileForce(path, `${JSON.stringify(next, null, 2)}\n`);
}

async function rewriteConfigDefaultProjectDir(home: string, root: string): Promise<void> {
  const configPath = resolve(home, 'config.md');
  if (!(await fileExists(configPath))) return;
  const content = await readFile(configPath, 'utf-8');
  const target = resolve(root, 'projects');
  const next = content.replace(
    /^defaultProjectDir:\s*.*$/m,
    `defaultProjectDir: ${target}`,
  );
  if (next !== content) await writeFileForce(configPath, next);
}

export async function migrateV2Command(
  options: MigrateV2Options,
): Promise<MigrateV2Transcript> {
  process.env.SYNTAUR_HOME = resolve(expandHome(options.root ?? syntaurRoot()));
  const home = syntaurRoot();
  const projectsDir = resolve(home, 'projects');
  const mode = options.apply ? '[apply] ' : '[dry-run] ';
  const lines: string[] = [];

  const markerPath = resolve(home, V2_MIGRATED_MARKER);
  if (await fileExists(markerPath)) {
    throw new Error(
      'v2 migration already completed (v2-migrated marker present). Remove the marker only if you have restored from backup.',
    );
  }

  if (options.apply && (await hasHalfAppliedTicketFolders(projectsDir))) {
    throw new Error(
      'Refusing apply: id-prefixed ticket folders found without v2-migrated marker (possible half-applied migration). ' +
        'Restore from your .bak-v2-* backup before retrying.',
    );
  }

  const prefixOverrides = parsePrefixOverrides(options.prefix);
  const usedPrefixes = new Set<string>(prefixOverrides.values());

  const plans: ProjectPlan[] = [];
  if (await fileExists(projectsDir)) {
    const entries = await readdir(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectDir = resolve(projectsDir, entry.name);
      if (!(await fileExists(resolve(projectDir, 'project.md')))) continue;
      const tickets = await discoverProjectTickets(entry.name, projectDir);
      let prefix = prefixOverrides.get(entry.name);
      if (!prefix) {
        prefix = derivePrefix(entry.name, usedPrefixes);
      }
      usedPrefixes.add(prefix);
      plans.push({ slug: entry.name, projectDir, prefix, nextTicket: 1, tickets });
    }
  }

  let standalone = await discoverStandaloneTickets(home);
  let scratchPrefix = 'SCR';
  if (standalone.length > 0) {
    scratchPrefix = prefixOverrides.get('scratch') ?? derivePrefix('scratch', usedPrefixes);
    usedPrefixes.add(scratchPrefix);
    const sorted = [...standalone].sort((a, b) =>
      a.created.localeCompare(b.created) || a.slug.localeCompare(b.slug),
    );
    let n = 1;
    for (const t of sorted) {
      t.newId = `${scratchPrefix}-${n}`;
      t.newFolder = formatTicketFolderName(t.newId, t.slug);
      n += 1;
    }
  }

  for (const plan of plans) {
    const sorted = [...plan.tickets].sort(
      (a, b) => a.created.localeCompare(b.created) || a.slug.localeCompare(b.slug),
    );
    let n = 1;
    for (const t of sorted) {
      t.newId = `${plan.prefix}-${n}`;
      t.newFolder = formatTicketFolderName(t.newId, t.slug);
      n += 1;
    }
    plan.nextTicket = n;
  }

  const maps = buildMaps(plans, standalone);
  const allTickets = [...plans.flatMap((p) => p.tickets), ...standalone];
  let backupPath = '';

  for (const plan of plans) {
    logLine(lines, mode, `project ${plan.slug}: prefix ${plan.prefix}, ${plan.tickets.length} tickets`);
    for (const t of plan.tickets) {
      logLine(
        lines,
        mode,
        `${t.oldFolder} → ${t.newFolder} · ${t.newId} · ${t.status}→${t.status}`,
      );
    }
  }

  if (standalone.length > 0) {
    logLine(lines, mode, `standalone: ${standalone.length} tickets → scratch`);
  }

  for (const t of allTickets) {
    logLine(lines, mode, `UUID ${t.uuid} → ${t.newId}`);
  }
  for (const [key, id] of maps.slugToId) {
    const [project, slug] = key.split(':');
    logLine(lines, mode, `(${project}, ${slug}) → ${id}`);
  }

  if (!options.apply) {
    logLine(
      lines,
      mode,
      'status mapping and template: legacy deferred to templates ticket',
    );
    logLine(
      lines,
      mode,
      `totals: ${plans.length} projects, ${allTickets.length} tickets`,
    );
    return { lines };
  }

  try {
    backupPath = await createBackup(home);
    logLine(lines, mode, `backup: ${backupPath}`);

    if (options.root) {
      logLine(lines, mode, `config defaultProjectDir → ${resolve(home, 'projects')}`);
      await rewriteConfigDefaultProjectDir(home, home);
    }

    await applyFilesystemMigration(home, plans, standalone, maps, scratchPrefix);

    const dbPath = resolve(home, 'syntaur.db');
    if (await fileExists(dbPath)) {
      const counts = rekeyDatabase(dbPath, maps);
      logLine(lines, mode, `re-keyed events.ticket_id: ${counts.events}  (project_slug dropped)`);
      logLine(
        lines,
        mode,
        `re-keyed engagement.ticket_id: ${counts.engagementByUuid}  (project_slug, assignment_slug dropped)`,
      );
      if (counts.engagementBySlug > 0) {
        logLine(
          lines,
          mode,
          `re-keyed engagement.ticket_id (by slug): ${counts.engagementBySlug}`,
        );
      }
      logLine(
        lines,
        mode,
        `re-keyed chat_sessions.ticket_id: ${counts.chatSessionsTicket}  (project_slug, assignment_slug dropped)`,
      );
      logLine(lines, mode, `re-keyed chat_sessions.session_key: ${counts.chatSessionsKey}`);
      logLine(lines, mode, `re-keyed chat_items.session_key: ${counts.chatItemsSessionKey}`);
      logLine(lines, mode, `re-keyed chat_items.ticket_id: ${counts.chatItemsTicket}`);
      logLine(
        lines,
        mode,
        `re-keyed usage_events.ticket_id: ${counts.usageEvents}  (assignment_slug dropped; project_slug kept)`,
      );
      logLine(
        lines,
        mode,
        `re-keyed usage_daily.ticket_id: ${counts.usageDaily}  (assignment_slug dropped; project_slug kept)`,
      );
    }

    await migrateChatAndRebuild(allTickets, maps);
    await rewriteInboxSnoozes(home, maps);

    await writeFileForce(markerPath, `${new Date().toISOString()}\n`);
    logLine(
      lines,
      mode,
      'status mapping and template: legacy deferred to templates ticket',
    );
    logLine(
      lines,
      mode,
      `totals: ${plans.length} projects, ${allTickets.length} tickets`,
    );
    return { lines };
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : String(err);
    throw new Error(
      `${msg}\nMigration aborted. Restore from backup at ${backupPath || '<none>'}.`,
    );
  }
}

export const v2MigrateCommand = new Command('v2')
  .description(
    'Migrate v1 / Phase-A ticket layout to v2 id-prefixed folders and colon-free keys',
  )
  .option('--apply', 'Apply changes (default is dry-run)')
  .option('--root <path>', 'Syntaur home to migrate (default ~/.syntaur)')
  .option('--prefix <pairs...>', 'Project prefix override as slug=PFX (repeatable)')
  .action(async (opts: { apply?: boolean; root?: string; prefix?: string[] }) => {
    try {
      await migrateV2Command({
        apply: opts.apply,
        root: opts.root,
        prefix: opts.prefix,
      });
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
