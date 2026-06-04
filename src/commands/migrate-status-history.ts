import { resolve } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { expandHome, assignmentsDir as getStandaloneDir } from '../utils/paths.js';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { readConfig, type SyntaurConfig } from '../utils/config.js';
import { appendStatusHistoryEntry, parseAssignmentFrontmatter } from '../lifecycle/frontmatter.js';
import { TERMINAL_STATUSES } from '../lifecycle/types.js';
import type { AssignmentFrontmatter } from '../lifecycle/types.js';

export interface MigrateStatusHistoryOptions {
  dir?: string;
  apply?: boolean;
}

interface SeedTarget {
  display: string;
  assignmentMd: string;
  status: string;
  seedAt: string;
}

async function parseSafe(path: string): Promise<AssignmentFrontmatter | null> {
  try {
    return parseAssignmentFrontmatter(await readFile(path, 'utf-8'));
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
function seedAtFor(fm: AssignmentFrontmatter, terminalStatuses: ReadonlySet<string>): string {
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

      // Standalone shape: baseDir/<uuid>/assignment.md
      const directAssignmentMd = resolve(baseDir, m.name, 'assignment.md');
      if (await fileExists(directAssignmentMd)) {
        if (seen.has(directAssignmentMd)) continue;
        const fm = await parseSafe(directAssignmentMd);
        if (fm && fm.statusHistory.length === 0) {
          seen.add(directAssignmentMd);
          targets.push({
            display: `standalone/${m.name}`,
            assignmentMd: directAssignmentMd,
            status: fm.status,
            seedAt: seedAtFor(fm, terminalStatuses),
          });
        }
        continue;
      }

      // Project shape: baseDir/<project>/assignments/<slug>/assignment.md
      const assignmentsBase = resolve(baseDir, m.name, 'assignments');
      if (!(await fileExists(assignmentsBase))) continue;
      const slugs = await readdir(assignmentsBase, { withFileTypes: true });
      for (const a of slugs) {
        if (!a.isDirectory()) continue;
        if (a.name.startsWith('.') || a.name.startsWith('_')) continue;
        const assignmentMd = resolve(assignmentsBase, a.name, 'assignment.md');
        if (!(await fileExists(assignmentMd))) continue;
        if (seen.has(assignmentMd)) continue;
        const fm = await parseSafe(assignmentMd);
        if (!fm || fm.statusHistory.length > 0) continue;
        seen.add(assignmentMd);
        targets.push({
          display: `${m.name}/${a.name}`,
          assignmentMd,
          status: fm.status,
          seedAt: seedAtFor(fm, terminalStatuses),
        });
      }
    }
  }
  return targets;
}

/**
 * One-time migration: seed a single synthetic `statusHistory` entry on every
 * assignment.md that lacks one. Dry-run by default; `--apply` writes. Idempotent
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
    console.log('No assignments need a statusHistory seed — all up to date.');
    return;
  }

  console.log(
    `Found ${targets.length} assignment${targets.length === 1 ? '' : 's'} lacking statusHistory ${
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
  for (const t of targets) {
    try {
      const content = await readFile(t.assignmentMd, 'utf-8');
      // Re-check idempotency in case the file changed since the scan.
      if (parseAssignmentFrontmatter(content).statusHistory.length > 0) continue;
      const seededContent = appendStatusHistoryEntry(content, {
        at: t.seedAt,
        from: null,
        to: t.status,
        command: 'seed',
        by: null,
      });
      await writeFileForce(t.assignmentMd, seededContent);
      seeded += 1;
    } catch (err) {
      failed += 1;
      console.warn(`  ! skipped ${t.display}: ${(err as Error).message}`);
    }
  }
  console.log(
    `Seeded ${seeded} assignment${seeded === 1 ? '' : 's'}${failed > 0 ? `, ${failed} skipped` : ''}.`,
  );
}
