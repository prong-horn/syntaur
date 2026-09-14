import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseTicketFrontmatter } from '../lifecycle/frontmatter.js';
import { resolveTicketById } from '../utils/ticket-resolver.js';
import { syntaurRoot } from '../utils/paths.js';
import { fileExists } from '../utils/fs.js';
import { markdownBody } from './content.js';
import {
  type GateContext,
  type MovedEvent,
  resolveDependencyStage,
} from './gates.js';
import { listEventsByTicket } from '../db/events-db.js';
import { logRoleFile } from './manifest.js';
import type { StageId } from './manifest.js';
import { loadTemplate, resolveTemplateForTicket } from './registry.js';
import { parseLogEntries, type LogEntry } from './log-reader.js';

async function loadDependencyStages(
  root: string,
  depends: string[],
): Promise<Map<string, StageId | 'dropped'>> {
  const projectsDir = resolve(root, 'projects');
  const map = new Map<string, StageId | 'dropped'>();
  for (const dep of depends) {
    const resolved = await resolveTicketById(projectsDir, dep);
    if (!resolved) {
      map.set(dep, 'backlog');
      continue;
    }
    try {
      const content = await readFile(resolve(resolved.ticketDir, 'ticket.md'), 'utf-8');
      const fm = parseTicketFrontmatter(content);
      map.set(dep, resolveDependencyStage(fm.status));
    } catch {
      map.set(dep, 'backlog');
    }
  }
  return map;
}

function loadMovedEvents(ticketId: string): MovedEvent[] {
  try {
    const rows = listEventsByTicket(ticketId, { types: ['moved'] });
    const moves: MovedEvent[] = [];
    for (const row of rows) {
      try {
        const details = JSON.parse(row.details ?? '{}') as Record<string, unknown>;
        moves.push({
          at: row.at,
          from: String(details.from ?? ''),
          to: String(details.to ?? ''),
          verb: String(details.verb ?? ''),
        });
      } catch {
        /* skip malformed row */
      }
    }
    moves.sort((a, b) => b.at.localeCompare(a.at));
    return moves;
  } catch {
    return [];
  }
}

async function loadLogEntries(
  ticketDir: string,
  manifest: Awaited<ReturnType<typeof loadTemplate>>,
): Promise<LogEntry[]> {
  const logRole = logRoleFile(manifest);
  if (!logRole) return [];
  const path = resolve(ticketDir, logRole.path);
  if (!(await fileExists(path))) return [];
  const content = await readFile(path, 'utf-8');
  return parseLogEntries(content);
}

/** Build the gate-evaluation context for one ticket directory. */
export async function buildGateContext(ticketDir: string): Promise<GateContext> {
  const root = syntaurRoot();
  const ticketMdPath = resolve(ticketDir, 'ticket.md');
  const content = await readFile(ticketMdPath, 'utf-8');
  const fm = parseTicketFrontmatter(content);
  const body = markdownBody(content);
  const templateId = resolveTemplateForTicket(fm);
  const manifest = await loadTemplate(root, templateId);
  const [logEntries, dependencyStages] = await Promise.all([
    loadLogEntries(ticketDir, manifest),
    loadDependencyStages(root, fm.depends_on),
  ]);
  const moves = loadMovedEvents(fm.id);

  return {
    ticketDir,
    fm,
    manifest,
    ticketBody: body,
    logEntries,
    dependencyStages,
    moves,
  };
}
