import { Command } from 'commander';
import { readFile, readdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { readConfig } from '../utils/config.js';
import { expandHome, syntaurRoot } from '../utils/paths.js';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { isValidSlug } from '../utils/slug.js';
import { isTicketId, allocateTicketId, parseTicketId, readProjectTicketCounter } from '../utils/ticket-ids.js';
import { resolveTicketWithProject } from '../utils/ticket-target.js';
import { formatTicketFolderName } from '../utils/ticket-folder.js';
import { extractFrontmatter, getField, parseProject } from '../dashboard/parser.js';
import { acquireTicketMutationLock } from '../utils/ticket-mutation-lock.js';
import { rekeyTicket, type TicketRekeyCounts } from '../db/ticket-rekey.js';
import { rewriteChatEventLineForTicket } from '../chat/ticket-event-rewrite.js';
import { rebuildChatIndex } from '../chat/store.js';
import { deleteChatItems } from '../db/chat-db.js';
import { initSessionDb, closeSessionDb, getSessionDb, resetSessionDb } from '../dashboard/session-db.js';
import { initEventsDb, closeEventsDb, resetEventsDb } from '../db/events-db.js';
import { initUsageDb, closeUsageDb, resetUsageDb } from '../db/usage-db.js';
import type { ChatSessionState } from '../chat/types.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { listTicketsByProject } from '../utils/ticket-walk.js';
import { parseTicketFrontmatter } from '../lifecycle/frontmatter.js';
import {
  appendMovedFromEntry,
  arraysEqual,
  replaceQuotedScalarField,
  replaceScalarField,
  rewriteYamlBlockListItems,
} from '../utils/ticket-frontmatter-patch.js';

const BUSY_CHAT_STATES = new Set<ChatSessionState>(['spawning', 'ready', 'running', 'idle']);

export type MoveFailStep = 'db-rekey' | 'chat-rebuild' | 'home-json';

export interface MoveDeps {
  syntaurHome: string;
  now: () => string;
  fail?: (step: MoveFailStep) => void;
}

export interface MoveTicketPlan {
  oldId: string;
  newId: string;
  newIdPreview: boolean;
  slug: string;
  srcProject: string;
  dstProject: string;
  srcTicketDir: string;
  dstTicketDir: string;
  srcTicketMd: string;
  dstTicketMd: string;
}

export class MoveRefusedError extends Error {
  /** Lines already formatted for stdout when the move fails after partial output. */
  readonly reportLines?: readonly string[];

  constructor(message: string, reportLines?: readonly string[]) {
    super(message);
    this.reportLines = reportLines;
  }
}

type UndoFn = () => Promise<void>;

/** Like dashboard `extractFrontmatter` but preserves body bytes after the closing `---`. */
function extractFrontmatterPreservingBody(fileContent: string): [string, string] {
  const match = fileContent.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return ['', fileContent];
  return [match[1], fileContent.slice(match[0].length)];
}

interface UndoEntry {
  kind: 'folder' | 'file' | 'db';
  fn: UndoFn;
}

function rewriteMarkerFile(content: string, oldId: string, newId: string): string {
  return content.replace(/item="([^"]+)"/g, (_, itemId: string) => {
    let next = itemId;
    if (next.startsWith(`session~${oldId}~`)) {
      next = `session~${newId}~${next.slice(`session~${oldId}~`.length)}`;
    }
    next = next.replaceAll(`~${oldId}~`, `~${newId}~`);
    return `item="${next}"`;
  });
}

function rewriteSnoozeKey(key: string, oldId: string, newId: string): string {
  if (key.startsWith(`session~${oldId}~`)) {
    return `session~${newId}~${key.slice(`session~${oldId}~`.length)}`;
  }
  if (key.startsWith(`${oldId}~`)) {
    return `${newId}~${key.slice(oldId.length + 1)}`;
  }
  return key;
}

function patchReferencingTicketFrontmatter(
  fm: string,
  parsed: ReturnType<typeof parseTicketFrontmatter>,
  oldId: string,
  newId: string,
  oldLink: string,
  newLink: string,
): string | null {
  const nextDepends = parsed.depends_on.map((d) => (d === oldId ? newId : d));
  const nextLinks = parsed.links.map((l) => {
    if (l === oldLink) return newLink;
    if (l === oldId) return newId;
    return l;
  });
  if (arraysEqual(parsed.depends_on, nextDepends) && arraysEqual(parsed.links, nextLinks)) {
    return null;
  }
  let next = fm;
  const dependsPatch = rewriteYamlBlockListItems(next, 'depends_on', (item) =>
    item === oldId ? newId : item,
  );
  if (dependsPatch !== null) next = dependsPatch;
  const linksPatch = rewriteYamlBlockListItems(next, 'links', (item) => {
    if (item === oldLink) return newLink;
    if (item === oldId) return newId;
    return item;
  });
  if (linksPatch !== null) next = linksPatch;
  return next === fm ? null : next;
}

async function readProjectMeta(projectDir: string): Promise<{ archived: boolean }> {
  const content = await readFile(resolve(projectDir, 'project.md'), 'utf-8');
  const parsed = parseProject(content);
  return { archived: parsed.archived };
}

async function slugExistsInProject(
  projectsDir: string,
  projectSlug: string,
  slug: string,
): Promise<boolean> {
  const ticketsPath = resolve(projectsDir, projectSlug, 'tickets');
  if (!(await fileExists(ticketsPath))) return false;
  const entries = await readdir(ticketsPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const ticketMd = resolve(ticketsPath, entry.name, 'ticket.md');
    if (!(await fileExists(ticketMd))) continue;
    try {
      const content = await readFile(ticketMd, 'utf-8');
      const [fm] = extractFrontmatter(content);
      if ((getField(fm, 'slug') ?? '') === slug) return true;
    } catch {
      // skip
    }
  }
  return false;
}

async function ticketHasBusyChat(home: string, ticketId: string): Promise<boolean> {
  const dbPath = resolve(home, 'syntaur.db');
  if (!(await fileExists(dbPath))) return false;
  resetSessionDb();
  initSessionDb(dbPath);
  try {
    const db = getSessionDb();
    const cols = db.prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>;
    const ticketCol = cols.some((c) => c.name === 'ticket_id') ? 'ticket_id' : 'assignment_id';
    const rows = db
      .prepare(`SELECT state FROM chat_sessions WHERE ${ticketCol} = ?`)
      .all(ticketId) as Array<{ state: string }>;
    return rows.some((r) => BUSY_CHAT_STATES.has(r.state as ChatSessionState));
  } finally {
    closeSessionDb();
    resetSessionDb();
  }
}

export async function planMoveTicket(
  projectsDir: string,
  ticketId: string,
  dstProject: string,
  opts: { srcProject?: string; previewOffset?: number } = {},
): Promise<MoveTicketPlan> {
  if (!isTicketId(ticketId)) {
    throw new MoveRefusedError(`Invalid ticket id "${ticketId}".`);
  }
  if (!isValidSlug(dstProject)) {
    throw new MoveRefusedError(`Invalid destination project slug "${dstProject}".`);
  }

  const resolved = await resolveTicketWithProject(projectsDir, ticketId, opts.srcProject);
  if (!resolved) {
    throw new MoveRefusedError(`Ticket "${ticketId}" not found.`);
  }

  const srcProject = resolved.projectSlug;
  if (srcProject === dstProject) {
    throw new MoveRefusedError(`Ticket is already in project "${dstProject}".`);
  }

  const dstDir = resolve(projectsDir, dstProject);
  if (!(await fileExists(resolve(dstDir, 'project.md')))) {
    throw new MoveRefusedError(`Destination project "${dstProject}" does not exist.`);
  }
  const dstMeta = await readProjectMeta(dstDir);
  if (dstMeta.archived) {
    throw new MoveRefusedError(`Destination project "${dstProject}" is archived.`);
  }

  const ticketMd = resolve(resolved.ticketDir, 'ticket.md');
  const content = await readFile(ticketMd, 'utf-8');
  const [fm] = extractFrontmatter(content);
  const slug = getField(fm, 'slug');
  if (!slug) throw new MoveRefusedError('Ticket is missing slug in frontmatter.');

  if (await slugExistsInProject(projectsDir, dstProject, slug)) {
    throw new MoveRefusedError(
      `Destination already has a ticket with slug "${slug}". Rename the source or destination ticket first (syntaur rename).`,
    );
  }

  if (await ticketHasBusyChat(resolve(projectsDir, '..'), resolved.id)) {
    throw new MoveRefusedError(
      'Ticket has an active chat session. Stop the chat or close the dashboard first.',
    );
  }

  const { prefix, nextTicket } = await readProjectTicketCounter(dstDir);
  const offset = opts.previewOffset ?? 0;
  const previewId = `${prefix}-${nextTicket + offset}`;
  const newId = previewId;

  const dstTicketDir = resolve(dstDir, 'tickets', formatTicketFolderName(newId, slug));
  return {
    oldId: resolved.id,
    newId,
    newIdPreview: true,
    slug,
    srcProject,
    dstProject,
    srcTicketDir: resolved.ticketDir,
    dstTicketDir,
    srcTicketMd: ticketMd,
    dstTicketMd: resolve(dstTicketDir, 'ticket.md'),
  };
}

async function listProjectTicketsSorted(projectsDir: string, projectSlug: string): Promise<
  Array<{ id: string; ticketDir: string }>
> {
  const walk = await listTicketsByProject(projectsDir);
  const tickets = walk.withTicketMd
    .filter((t) => t.projectSlug === projectSlug && t.ticketId)
    .map((t) => ({ id: t.ticketId!, ticketDir: t.ticketDir }));
  tickets.sort((a, b) => {
    const pa = parseTicketId(a.id);
    const pb = parseTicketId(b.id);
    if (!pa || !pb) return a.id.localeCompare(b.id);
    return pa.number - pb.number;
  });
  return tickets;
}

export async function applyMove(plan: MoveTicketPlan, deps: MoveDeps): Promise<TicketRekeyCounts> {
  const home = deps.syntaurHome;
  const projectsDir = resolve(home, 'projects');
  const undo: UndoEntry[] = [];
  const rollback = async (): Promise<void> => {
    const files = undo.filter((u) => u.kind === 'file');
    const dbs = undo.filter((u) => u.kind === 'db');
    const folders = undo.filter((u) => u.kind === 'folder');
    for (let i = files.length - 1; i >= 0; i--) await files[i].fn();
    for (const entry of folders) await entry.fn();
    for (let i = dbs.length - 1; i >= 0; i--) await dbs[i].fn();
  };

  const oldId = plan.oldId;
  const now = deps.now();

  const srcLock = await acquireTicketMutationLock(plan.srcTicketMd, home);

  let newId = plan.newId;
  if (plan.newIdPreview) {
    const dstDir = resolve(projectsDir, plan.dstProject);
    newId = await allocateTicketId(dstDir);
  }

  const dstTicketDir = resolve(
    projectsDir,
    plan.dstProject,
    'tickets',
    formatTicketFolderName(newId, plan.slug),
  );
  const dstTicketMd = resolve(dstTicketDir, 'ticket.md');
  const dstLock = await acquireTicketMutationLock(dstTicketMd, home);
  undo.push({
    kind: 'file',
    fn: async () => {
      await dstLock.release();
      await srcLock.release();
    },
  });

  const originalTicketBytes = await readFile(plan.srcTicketMd, 'utf-8');
  const movedFromEntry = `${oldId}@${plan.srcProject}`;

  try {
    try {
      await rename(plan.srcTicketDir, dstTicketDir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EXDEV') {
        throw new MoveRefusedError('Ticket move requires source and destination on the same filesystem.');
      }
      throw err;
    }
    undo.push({
      kind: 'folder',
      fn: async () => {
        await rename(dstTicketDir, plan.srcTicketDir);
      },
    });

    const [fmStart, body] = extractFrontmatterPreservingBody(originalTicketBytes);
    let fm = fmStart;
    fm = replaceScalarField(fm, 'id', newId);
    fm = replaceScalarField(fm, 'project', plan.dstProject);
    fm = appendMovedFromEntry(fm, movedFromEntry);
    fm = replaceQuotedScalarField(fm, 'updated', `"${now}"`);
    const ticketContent = `---\n${fm}\n---${body}`;
    await writeFileForce(dstTicketMd, ticketContent);
    undo.push({
      kind: 'file',
      fn: async () => {
        await writeFileForce(dstTicketMd, originalTicketBytes);
      },
    });

    const eventsPath = resolve(dstTicketDir, 'chat', 'events.jsonl');
    if (await fileExists(eventsPath)) {
      const raw = await readFile(eventsPath, 'utf-8');
      const originalEvents = raw;
      const out = raw
        .split('\n')
        .map((line) => (line.trim() ? rewriteChatEventLineForTicket(line, oldId, newId) : ''))
        .join('\n');
      await writeFileForce(eventsPath, out.endsWith('\n') || out.length === 0 ? out : `${out}\n`);
      undo.push({
        kind: 'file',
        fn: async () => {
          await writeFileForce(eventsPath, originalEvents);
        },
      });
    }

    for (const rel of ['journal.md', 'comments.md'] as const) {
      const path = resolve(dstTicketDir, rel);
      if (!(await fileExists(path))) continue;
      const original = await readFile(path, 'utf-8');
      const next = rewriteMarkerFile(original, oldId, newId);
      if (next !== original) {
        await writeFileForce(path, next);
        undo.push({
          kind: 'file',
          fn: async () => {
            await writeFileForce(path, original);
          },
        });
      }
    }

    deps.fail?.('db-rekey');
    const dbPath = resolve(home, 'syntaur.db');
    resetSessionDb();
    resetEventsDb();
    resetUsageDb();
    initSessionDb(dbPath);
    initEventsDb(dbPath);
    initUsageDb(dbPath);

    const counts = rekeyTicket(dbPath, {
      oldId,
      newId,
      oldProjectSlug: plan.srcProject,
      newProjectSlug: plan.dstProject,
    });
    undo.push({
      kind: 'db',
      fn: async () => {
        rekeyTicket(dbPath, {
          oldId: newId,
          newId: oldId,
          oldProjectSlug: plan.dstProject,
          newProjectSlug: plan.srcProject,
        });
        deleteChatItems(newId);
        await rebuildChatIndex(plan.srcTicketDir, oldId);
      },
    });

    deps.fail?.('chat-rebuild');
    await rebuildChatIndex(dstTicketDir, newId);

    const walk = await listTicketsByProject(projectsDir);
    for (const entry of walk.withTicketMd) {
      if (entry.ticketDir === dstTicketDir) continue;
      const path = resolve(entry.ticketDir, 'ticket.md');
      const original = await readFile(path, 'utf-8');
      const [fm, body] = extractFrontmatterPreservingBody(original);
      const parsed = parseTicketFrontmatter(original);
      const nextFm = patchReferencingTicketFrontmatter(
        fm,
        parsed,
        oldId,
        newId,
        `${plan.srcProject}/${plan.slug}`,
        `${plan.dstProject}/${plan.slug}`,
      );
      if (nextFm === null) continue;
      const nextContent = `---\n${nextFm}\n---${body}`;
      await writeFileForce(path, nextContent);
      undo.push({
        kind: 'file',
        fn: async () => {
          await writeFileForce(path, original);
        },
      });
    }

    deps.fail?.('home-json');
    const snoozePath = resolve(home, 'inbox-snoozes.json');
    if (await fileExists(snoozePath)) {
      const raw = await readFile(snoozePath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const next: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(parsed)) {
        next[rewriteSnoozeKey(key, oldId, newId)] = value;
      }
      await writeFileForce(snoozePath, `${JSON.stringify(next, null, 2)}\n`);
      undo.push({
        kind: 'file',
        fn: async () => {
          await writeFileForce(snoozePath, raw);
        },
      });
    }

    const [fmAfter] = extractFrontmatter(ticketContent);
    const worktree = parseNestedWorkspace(fmAfter)?.worktree;
    if (worktree) {
      const ctxPath = resolve(worktree, '.syntaur', 'context.json');
      if (await fileExists(ctxPath)) {
        const raw = await readFile(ctxPath, 'utf-8');
        const ctx = JSON.parse(raw) as { ticketId?: string; ticketDir?: string };
        if (ctx.ticketId === oldId) {
          ctx.ticketId = newId;
          ctx.ticketDir = dstTicketDir;
          const next = `${JSON.stringify(ctx, null, 2)}\n`;
          await writeFileForce(ctxPath, next);
          undo.push({
            kind: 'file',
            fn: async () => {
              await writeFileForce(ctxPath, raw);
            },
          });
        }
      }
    }

    await dstLock.release();
    await srcLock.release();
    undo.length = 0;
    return counts;
  } catch (err) {
    await rollback();
    await dstLock.release();
    await srcLock.release();
    throw err;
  }
}

function parseNestedWorkspace(fm: string): { worktree?: string | null } | null {
  const headerMatch = fm.match(/^workspace:\s*$/m);
  if (!headerMatch) return null;
  const after = fm.slice((headerMatch.index ?? 0) + headerMatch[0].length + 1);
  const out: { worktree?: string | null } = {};
  for (const line of after.split('\n')) {
    if (line.length === 0) continue;
    if (line[0] !== ' ' && line[0] !== '\t') break;
    const m = line.match(/^\s+worktree:\s*(.*)$/);
    if (m) out.worktree = m[1].trim() === 'null' ? null : m[1].trim();
  }
  return out;
}

function formatCounts(counts: TicketRekeyCounts): string {
  return [
    `events=${counts.events}`,
    `eventsSourceKey=${counts.eventsSourceKey}`,
    `engagement=${counts.engagement}`,
    `chatSessions=${counts.chatSessionsTicket}+${counts.chatSessionsKey}`,
    `usageEvents=${counts.usageEvents}`,
    `usageDaily=${counts.usageDaily}`,
  ].join(', ');
}

export interface RunMoveOptions {
  ticket?: string;
  to: string;
  allFrom?: string;
  project?: string;
  apply?: boolean;
  dir?: string;
}

export async function runMove(options: RunMoveOptions, deps?: Partial<MoveDeps>): Promise<{ lines: string[] }> {
  const config = await readConfig();
  const home = deps?.syntaurHome ?? syntaurRoot();
  const projectsDir = options.dir ? expandHome(options.dir) : config.defaultProjectDir;
  const resolvedDeps: MoveDeps = {
    syntaurHome: home,
    now: deps?.now ?? nowTimestamp,
    fail: deps?.fail,
  };
  const mode = options.apply ? '[apply] ' : '[dry-run] ';
  const lines: string[] = [];

  if (options.allFrom) {
    if (options.ticket) {
      throw new MoveRefusedError('Pass either a ticket id or --all-from, not both.');
    }
    const tickets = await listProjectTicketsSorted(projectsDir, options.allFrom);
    const plans: MoveTicketPlan[] = [];
    const refusals: string[] = [];
    for (let i = 0; i < tickets.length; i++) {
      try {
        const plan = await planMoveTicket(projectsDir, tickets[i].id, options.to, {
          previewOffset: i,
        });
        plans.push(plan);
      } catch (err) {
        refusals.push(
          `${tickets[i].id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (refusals.length > 0) {
      lines.push(`${mode}Refusing bulk move — ${refusals.length} ticket(s) would fail:`);
      for (const r of refusals) lines.push(`  ${r}`);
      throw new MoveRefusedError('Bulk move refused.', lines);
    }
    for (const plan of plans) {
      const label = plan.newIdPreview ? `${plan.newId} (preview)` : plan.newId;
      lines.push(`${mode}${plan.oldId} → ${label}  ${plan.slug}`);
    }
    lines.push(`${mode}Summary: ${plans.length} ticket(s) would move to ${options.to}.`);
    if (!options.apply) return { lines };

    const moved: string[] = [];
    for (const plan of plans) {
      try {
        const counts = await applyMove(plan, resolvedDeps);
        moved.push(`${plan.oldId} → ${plan.newId}`);
        lines.push(`${mode}${plan.oldId} → ${plan.newId}  ${plan.slug}  (${formatCounts(counts)})`);
      } catch (err) {
        const remaining = tickets.length - moved.length;
        lines.push(
          `${mode}Stopped after ${moved.length} ticket(s): ${err instanceof Error ? err.message : String(err)}`,
        );
        if (moved.length > 0) {
          lines.push(`${mode}Moved: ${moved.join(', ')}`);
        }
        lines.push(`${mode}Remaining: ${remaining} ticket(s) not moved.`);
        closeSessionDb();
        resetSessionDb();
        closeEventsDb();
        resetEventsDb();
        closeUsageDb();
        resetUsageDb();
        throw new MoveRefusedError(
          err instanceof Error ? err.message : String(err),
          lines,
        );
      }
    }
    lines.push(`${mode}Summary: moved ${moved.length} ticket(s) to ${options.to}.`);
    lines.push(`${mode}Restart the dashboard if it is running (chat broker caches ticket paths).`);
    closeSessionDb();
    resetSessionDb();
    closeEventsDb();
    resetEventsDb();
    closeUsageDb();
    resetUsageDb();
    return { lines };
  }

  if (!options.ticket) {
    throw new MoveRefusedError('Ticket id required (or use --all-from).');
  }

  const plan = await planMoveTicket(projectsDir, options.ticket, options.to, {
    srcProject: options.project,
  });
  const label = plan.newIdPreview ? `${plan.newId} (preview)` : plan.newId;
  lines.push(`${mode}${plan.oldId} → ${label}  ${plan.slug}`);
  lines.push(`${mode}Summary: 1 ticket would move to ${options.to}.`);
  if (!options.apply) return { lines };

  const counts = await applyMove(plan, resolvedDeps);
  lines[0] = `${mode}${plan.oldId} → ${plan.newId}  ${plan.slug}  (${formatCounts(counts)})`;
  lines.push(`${mode}Restart the dashboard if it is running (chat broker caches ticket paths).`);
  closeSessionDb();
  resetSessionDb();
  closeEventsDb();
  resetEventsDb();
  closeUsageDb();
  resetUsageDb();
  return { lines };
}

export const moveCommand = new Command('move')
  .description('Move a ticket to another project (new id, old id kept as alias)')
  .argument('[ticket]', 'Ticket id to move')
  .requiredOption('--to <project>', 'Destination project slug')
  .option('--all-from <project>', 'Move every ticket from a source project')
  .option('--project <slug>', 'Source project slug (when resolving by old id)')
  .option('--apply', 'Apply the move (default is dry-run)')
  .option('--dir <path>', 'Override default project directory');
