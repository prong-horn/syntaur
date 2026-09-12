import { resolve } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { expandHome, ticketsDir as getStandaloneDir } from '../utils/paths.js';
import { fileExists } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import { parseTicketFull, type ParsedTicketFull } from '../dashboard/parser.js';
import {
  initEventsDb,
  getEventsDb,
  recordEvent,
} from '../db/events-db.js';

export interface MigrateEventsOptions {
  dir?: string;
  apply?: boolean;
}

/** A backfilled event synthesized from frontmatter (statusHistory / planApproval). */
interface SynthEvent {
  type: string;
  at: string;
  actor: string;
  details: Record<string, unknown>;
  sourceKey: string;
}

interface EventTarget {
  display: string;
  ticketId: string;
  projectSlug: string | null;
  events: SynthEvent[];
}

async function parseSafe(path: string): Promise<ParsedTicketFull | null> {
  try {
    return parseTicketFull(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Synthesize the backfill events for one ticket from its frontmatter. Each
 * event carries a DETERMINISTIC `sourceKey` so re-running `--apply` inserts 0
 * (idempotency is per-event via `INSERT OR IGNORE` on `source_key`, NOT a
 * per-ticket skip):
 *   - one `status-change` per `statusHistory` entry whose `from !== to` —
 *     `backfill:<id>:status:<index>` (same-status entries are skipped, matching
 *     the live emit's from!==to guard; index stays the ORIGINAL one for idempotency)
 *   - one `plan-approval` if `planApproval` is present — `backfill:<id>:plan-approval`
 */
function synthesizeEvents(fm: ParsedTicketFull): SynthEvent[] {
  const events: SynthEvent[] = [];

  fm.statusHistory.forEach((entry, index) => {
    // Skip same-status entries (e.g. a derived draft→draft seed). The live emit
    // path guards on from!==to (event-emit.ts); backfill must match (FIX 3).
    // Keep the sourceKey indexed by the ORIGINAL statusHistory index so re-runs
    // stay idempotent — never renumber after skipping.
    if (entry.from === entry.to) return;
    events.push({
      type: 'status-change',
      at: entry.at,
      actor: entry.by ?? 'system',
      details: { from: entry.from, to: entry.to, command: entry.command },
      sourceKey: `backfill:${fm.id}:status:${index}`,
    });
  });

  if (fm.planApproval) {
    events.push({
      type: 'plan-approval',
      at: fm.planApproval.at || fm.updated,
      actor: fm.planApproval.by ?? 'system',
      details: { file: fm.planApproval.file, digest: fm.planApproval.digest },
      sourceKey: `backfill:${fm.id}:plan-approval`,
    });
  }

  return events;
}

/**
 * Scan the projects base + the standalone base for tickets and synthesize
 * their backfill events. Mirrors `migrate-status-history.collectTargets`:
 * handles the standalone shape (`baseDir/<uuid>/ticket.md`, `projectSlug`
 * null) AND the nested shape (`baseDir/<project>/tickets/<slug>/ticket.md`).
 */
async function collectTargets(baseDirs: string[]): Promise<EventTarget[]> {
  const targets: EventTarget[] = [];
  const seen = new Set<string>();
  for (const baseDir of baseDirs) {
    if (!(await fileExists(baseDir))) continue;
    const entries = await readdir(baseDir, { withFileTypes: true });
    for (const m of entries) {
      if (!m.isDirectory()) continue;
      if (m.name.startsWith('.') || m.name.startsWith('_')) continue;

      // Standalone shape: baseDir/<uuid>/ticket.md (v1) or ticket.md (Phase A)
      const directTicketMd = resolve(baseDir, m.name, 'ticket.md');
      const directLegacyTicketMd = resolve(baseDir, m.name, 'assignment.md');
      const standaloneMd = (await fileExists(directTicketMd))
        ? directTicketMd
        : (await fileExists(directLegacyTicketMd))
          ? directLegacyTicketMd
          : null;
      if (standaloneMd) {
        if (seen.has(standaloneMd)) continue;
        seen.add(standaloneMd);
        const fm = await parseSafe(standaloneMd);
        if (fm && fm.id) {
          const events = synthesizeEvents(fm);
          if (events.length > 0) {
            targets.push({
              display: `standalone/${m.name}`,
              ticketId: fm.id,
              projectSlug: null,
              events,
            });
          }
        }
        continue;
      }

      // Project shape (v1): baseDir/<project>/tickets/<slug>/ticket.md
      const legacyTicketsDir = resolve(baseDir, m.name, 'assignments');
      if (await fileExists(legacyTicketsDir)) {
        const slugs = await readdir(legacyTicketsDir, { withFileTypes: true });
        for (const a of slugs) {
          if (!a.isDirectory()) continue;
          if (a.name.startsWith('.') || a.name.startsWith('_')) continue;
          const ticketMd = resolve(legacyTicketsDir, a.name, 'assignment.md');
          if (!(await fileExists(ticketMd))) continue;
          if (seen.has(ticketMd)) continue;
          seen.add(ticketMd);
          const fm = await parseSafe(ticketMd);
          if (!fm || !fm.id) continue;
          const events = synthesizeEvents(fm);
          if (events.length === 0) continue;
          targets.push({
            display: `${m.name}/${a.name}`,
            ticketId: fm.id,
            projectSlug: m.name,
            events,
          });
        }
      }

      // Project shape (Phase A): baseDir/<project>/tickets/<slug>/ticket.md
      const ticketsBase = resolve(baseDir, m.name, 'tickets');
      if (await fileExists(ticketsBase)) {
        const ticketSlugs = await readdir(ticketsBase, { withFileTypes: true });
        for (const a of ticketSlugs) {
          if (!a.isDirectory()) continue;
          if (a.name.startsWith('.') || a.name.startsWith('_')) continue;
          const ticketMd = resolve(ticketsBase, a.name, 'ticket.md');
          if (!(await fileExists(ticketMd))) continue;
          if (seen.has(ticketMd)) continue;
          seen.add(ticketMd);
          const fm = await parseSafe(ticketMd);
          if (!fm || !fm.id) continue;
          const events = synthesizeEvents(fm);
          if (events.length === 0) continue;
          targets.push({
            display: `${m.name}/${a.name}`,
            ticketId: fm.id,
            projectSlug: m.name,
            events,
          });
        }
      }
    }
  }
  return targets;
}

/**
 * One-time backfill: synthesize append-only `events` rows from each
 * ticket's `statusHistory` + `planApproval` frontmatter. Dry-run by
 * default; `--apply` writes. Idempotency is per-EVENT via a deterministic
 * `source_key` + `INSERT OR IGNORE` (re-running `--apply` inserts 0 rows;
 * survives partial failures; concurrency-safe) — NOT a per-ticket skip.
 * Each ticket's inserts run in a single events-db transaction.
 */
export async function migrateEventsCommand(
  options: MigrateEventsOptions,
): Promise<void> {
  const config = await readConfig();
  const projectsBase = options.dir ? expandHome(options.dir) : config.defaultProjectDir;
  const standaloneBase = getStandaloneDir();

  const targets = await collectTargets([projectsBase, standaloneBase]);

  const totalEvents = targets.reduce((sum, t) => sum + t.events.length, 0);

  if (targets.length === 0) {
    console.log('No tickets with statusHistory/planApproval to backfill.');
    return;
  }

  console.log(
    `Found ${targets.length} ticket${targets.length === 1 ? '' : 's'} with ${totalEvents} event${
      totalEvents === 1 ? '' : 's'
    } to backfill ${options.apply ? '(applying)' : '(dry-run; use --apply to write)'}:`,
  );
  console.log('');
  for (const t of targets) {
    console.log(`  ${t.display}: ${t.events.length} event${t.events.length === 1 ? '' : 's'}`);
  }
  console.log('');

  if (!options.apply) {
    console.log(
      `Re-run with --apply to backfill ${totalEvents} event${totalEvents === 1 ? '' : 's'}.`,
    );
    return;
  }

  initEventsDb();
  const db = getEventsDb();

  let inserted = 0;
  for (const t of targets) {
    const countBefore = countEvents(t.ticketId);
    const writeAll = db.transaction(() => {
      for (const e of t.events) {
        recordEvent({
          ticketId: t.ticketId,
          projectSlug: t.projectSlug,
          type: e.type,
          details: e.details,
          actor: e.actor,
          at: e.at,
          sourceKey: e.sourceKey,
        });
      }
    });
    writeAll();
    inserted += countEvents(t.ticketId) - countBefore;
  }

  console.log(
    `Backfilled ${inserted} new event${inserted === 1 ? '' : 's'} (${
      totalEvents - inserted
    } already present, skipped via source_key).`,
  );
}

/** Count events for an ticket (used to measure inserts before/after apply). */
function countEvents(ticketId: string): number {
  const row = getEventsDb()
    .prepare('SELECT COUNT(*) AS n FROM events WHERE assignment_id = ?')
    .get(ticketId) as { n: number };
  return row.n;
}
