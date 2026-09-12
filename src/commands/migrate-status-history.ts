import { resolve } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { expandHome, ticketsDir as getStandaloneDir } from '../utils/paths.js';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { readConfig, type SyntaurConfig } from '../utils/config.js';
import { appendStatusHistoryEntry, parseTicketFrontmatter } from '../lifecycle/frontmatter.js';
import { withSuppressedEvents } from '../lifecycle/event-emit.js';
import { TERMINAL_STATUSES } from '../lifecycle/types.js';
import type { TicketFrontmatter } from '../lifecycle/types.js';

export interface MigrateStatusHistoryOptions {
  dir?: string;
  apply?: boolean;
}

interface SeedTarget {
  display: string;
  ticketMd: string;
  status: string;
  seedAt: string;
}

async function parseSafe(path: string): Promise<TicketFrontmatter | null> {
  try {
    return parseTicketFrontmatter(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Resolve the terminal status set from config. Mirrors getStatusConfig in the
 * dashboard: honor a custom `statuses:` block's `terminal` flags, falling back
 * to the lifecycle default ({ completed, failed }) when none are configured.
 */
function resolveTerminalSet(config: SyntaurConfig): ReadonlySet<string> {
  if (config.statuses) {
    const set = new Set(
      config.statuses.statuses.filter((s) => s.terminal).map((s) => s.id),
    );
    if (set.size > 0) return set;
  }
  return TERMINAL_STATUSES;
}

/**
 * The synthetic seed timestamp. Pre-migration history is unrecoverable, so we
 * pick the best available anchor: for currently-terminal items use `updated`
 * (an approximation of completion time, making the derived `completedAt`
 * roughly correct); for everything else use `created` (the creation anchor).
 */
function seedAtFor(fm: TicketFrontmatter, terminalStatuses: ReadonlySet<string>): string {
  const anchor = terminalStatuses.has(fm.status) ? fm.updated : fm.created;
  return anchor || fm.created || fm.updated || '';
}

async function collectTargets(
  baseDirs: string[],
  terminalStatuses: ReadonlySet<string>,
): Promise<SeedTarget[]> {
  const targets: SeedTarget[] = [];
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
        const fm = await parseSafe(standaloneMd);
        if (fm && fm.statusHistory.length === 0) {
          seen.add(standaloneMd);
          targets.push({
            display: `standalone/${m.name}`,
            ticketMd: standaloneMd,
            status: fm.status,
            seedAt: seedAtFor(fm, terminalStatuses),
          });
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
          const fm = await parseSafe(ticketMd);
          if (!fm || fm.statusHistory.length > 0) continue;
          seen.add(ticketMd);
          targets.push({
            display: `${m.name}/${a.name}`,
            ticketMd,
            status: fm.status,
            seedAt: seedAtFor(fm, terminalStatuses),
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
          const fm = await parseSafe(ticketMd);
          if (!fm || fm.statusHistory.length > 0) continue;
          seen.add(ticketMd);
          targets.push({
            display: `${m.name}/${a.name}`,
            ticketMd: ticketMd,
            status: fm.status,
            seedAt: seedAtFor(fm, terminalStatuses),
          });
        }
      }
    }
  }
  return targets;
}

/**
 * One-time migration: seed a single synthetic `statusHistory` entry on every
 * ticket.md that lacks one. Dry-run by default; `--apply` writes. Idempotent
 * (skips files that already have history) and never throws per file. Mirrors the
 * scan/apply shape of `migrate-statuses`.
 */
export async function migrateStatusHistoryCommand(
  options: MigrateStatusHistoryOptions,
): Promise<void> {
  const config = await readConfig();
  const projectsBase = options.dir ? expandHome(options.dir) : config.defaultProjectDir;
  const standaloneBase = getStandaloneDir();
  const terminalStatuses = resolveTerminalSet(config);

  const targets = await collectTargets([projectsBase, standaloneBase], terminalStatuses);

  if (targets.length === 0) {
    console.log('No tickets need a statusHistory seed — all up to date.');
    return;
  }

  console.log(
    `Found ${targets.length} ticket${targets.length === 1 ? '' : 's'} lacking statusHistory ${
      options.apply ? '(applying)' : '(dry-run; use --apply to write)'
    }:`,
  );
  console.log('');
  for (const t of targets) {
    console.log(`  ${t.display}: seed { to: ${t.status}, at: ${t.seedAt}, command: seed }`);
  }
  console.log('');

  if (!options.apply) {
    console.log('Re-run with --apply to perform the migration.');
    return;
  }

  let seeded = 0;
  let failed = 0;
  // Suppress live audit events — seeding statusHistory is a migration, not a
  // real status transition.
  await withSuppressedEvents(async () => {
    for (const t of targets) {
      try {
        const content = await readFile(t.ticketMd, 'utf-8');
        // Re-check idempotency in case the file changed since the scan.
        if (parseTicketFrontmatter(content).statusHistory.length > 0) continue;
        const seededContent = appendStatusHistoryEntry(content, {
          at: t.seedAt,
          from: null,
          to: t.status,
          command: 'seed',
          by: null,
        });
        await writeFileForce(t.ticketMd, seededContent);
        seeded += 1;
      } catch (err) {
        failed += 1;
        console.warn(`  ! skipped ${t.display}: ${(err as Error).message}`);
      }
    }
  });
  console.log(
    `Seeded ${seeded} ticket${seeded === 1 ? '' : 's'}${failed > 0 ? `, ${failed} skipped` : ''}.`,
  );
}
