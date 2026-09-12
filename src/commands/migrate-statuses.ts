import { resolve } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { expandHome, ticketsDir as getStandaloneDir } from '../utils/paths.js';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import {
  appendStatusHistoryEntry,
  parseTicketFrontmatter,
  updateTicketFile,
} from '../lifecycle/frontmatter.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { withSuppressedEvents } from '../lifecycle/event-emit.js';
import type { TicketFrontmatter } from '../lifecycle/types.js';

export interface MigrateStatusesOptions {
  dir?: string;
  apply?: boolean;
}

interface Candidate {
  projectSlug: string | null;
  ticketSlug: string;
  ticketMd: string;
  fromStatus: string;
  toStatus: string;
}

const PROMOTABLE_STATUSES = new Set(['pending']);

function objectiveIsFleshedOut(content: string): boolean {
  const match = content.match(/##\s+Objective\s*\n([\s\S]*?)(?=\n##\s+|$)/);
  if (!match) return false;
  const body = match[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^<!--[\s\S]*-->$/.test(l))
    .join('\n')
    .trim();
  return body.length > 0;
}

function hasAcceptanceCriteria(content: string): boolean {
  const match = content.match(/##\s+Acceptance Criteria\s*\n([\s\S]*?)(?=\n##\s+|$)/);
  if (!match) return false;
  const acItems = match[1].match(/^-\s*\[[ x]\]\s+(?!<!--)/gm);
  return (acItems?.length ?? 0) > 0;
}

async function collectCandidates(baseDirs: string[]): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  for (const baseDir of baseDirs) {
    if (!(await fileExists(baseDir))) continue;
    const projects = await readdir(baseDir, { withFileTypes: true });
    for (const m of projects) {
      if (!m.isDirectory()) continue;
      if (m.name.startsWith('.') || m.name.startsWith('_')) continue;

      const pushCandidate = async (
        projectSlug: string | null,
        ticketSlug: string,
        ticketMd: string,
      ): Promise<void> => {
        const fm = await parseSafe(ticketMd);
        if (!fm || !PROMOTABLE_STATUSES.has(fm.status)) return;
        const content = await readFile(ticketMd, 'utf-8');
        if (!objectiveIsFleshedOut(content) || !hasAcceptanceCriteria(content)) return;
        candidates.push({
          projectSlug,
          ticketSlug,
          ticketMd,
          fromStatus: fm.status,
          toStatus: 'ready_for_planning',
        });
      };

      // Standalone shape (v1): baseDir/<uuid>/assignment.md
      const directLegacyTicketMd = resolve(baseDir, m.name, 'assignment.md');
      if (await fileExists(directLegacyTicketMd)) {
        await pushCandidate(null, m.name, directLegacyTicketMd);
        continue;
      }

      // Standalone shape (Phase A): baseDir/<uuid>/ticket.md
      const directTicketMd = resolve(baseDir, m.name, 'ticket.md');
      if (await fileExists(directTicketMd)) {
        await pushCandidate(null, m.name, directTicketMd);
        continue;
      }

      // Project shape (v1): baseDir/<project>/assignments/<slug>/assignment.md
      const legacyTicketsDir = resolve(baseDir, m.name, 'assignments');
      if (await fileExists(legacyTicketsDir)) {
        const entries = await readdir(legacyTicketsDir, { withFileTypes: true });
        for (const a of entries) {
          if (!a.isDirectory()) continue;
          if (a.name.startsWith('.') || a.name.startsWith('_')) continue;
          const ticketMd = resolve(legacyTicketsDir, a.name, 'assignment.md');
          if (!(await fileExists(ticketMd))) continue;
          await pushCandidate(m.name, a.name, ticketMd);
        }
      }

      // Project shape (Phase A): baseDir/<project>/tickets/<slug>/ticket.md
      const ticketsBase = resolve(baseDir, m.name, 'tickets');
      if (!(await fileExists(ticketsBase))) continue;
      const entries = await readdir(ticketsBase, { withFileTypes: true });
      for (const a of entries) {
        if (!a.isDirectory()) continue;
        if (a.name.startsWith('.') || a.name.startsWith('_')) continue;
        const ticketMd = resolve(ticketsBase, a.name, 'ticket.md');
        if (!(await fileExists(ticketMd))) continue;
        await pushCandidate(m.name, a.name, ticketMd);
      }
    }
  }
  return candidates;
}

async function parseSafe(path: string): Promise<TicketFrontmatter | null> {
  try {
    const content = await readFile(path, 'utf-8');
    return parseTicketFrontmatter(content);
  } catch {
    return null;
  }
}

export async function migrateStatusesCommand(
  options: MigrateStatusesOptions,
): Promise<void> {
  const config = await readConfig();
  const projectsBase = options.dir ? expandHome(options.dir) : config.defaultProjectDir;
  const standaloneBase = getStandaloneDir();

  const candidates = await collectCandidates([projectsBase, standaloneBase]);

  if (candidates.length === 0) {
    console.log('No promotion candidates found. (Looking for pending tickets with a fleshed-out Objective and at least one Acceptance Criterion.)');
    return;
  }

  console.log(`Found ${candidates.length} candidate${candidates.length === 1 ? '' : 's'} for promotion ${options.apply ? '(applying)' : '(dry-run; use --apply to write)'}:`);
  console.log('');
  for (const c of candidates) {
    const label = c.projectSlug ? `${c.projectSlug}/${c.ticketSlug}` : `standalone/${c.ticketSlug}`;
    console.log(`  ${label}: ${c.fromStatus} -> ${c.toStatus}`);
  }
  console.log('');

  if (!options.apply) {
    console.log('Re-run with --apply to perform the migration.');
    return;
  }

  const now = nowTimestamp();
  let migrated = 0;
  // Suppress live audit events: seeded statusHistory writes are a migration,
  // not a real transition. (These writes don't currently flow through an
  // instrumented path, but the guard keeps them no-emit defensively.)
  await withSuppressedEvents(async () => {
    for (const c of candidates) {
      const content = await readFile(c.ticketMd, 'utf-8');
      const updated = appendStatusHistoryEntry(
        updateTicketFile(content, {
          status: c.toStatus,
          updated: now,
        }),
        { at: now, from: c.fromStatus, to: c.toStatus, command: 'promote', by: null },
      );
      await writeFileForce(c.ticketMd, updated);
      migrated += 1;
    }
  });
  console.log(`Migrated ${migrated} ticket${migrated === 1 ? '' : 's'}.`);
}
