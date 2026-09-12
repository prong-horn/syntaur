import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { expandHome, ticketsDir as ticketsDirFn } from '../utils/paths.js';
import { fileExists } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import { isValidSlug } from '../utils/slug.js';
import { updateTicketFile, parseTicketFrontmatter } from '../lifecycle/frontmatter.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { resolveTicketById } from '../utils/ticket-resolver.js';
import { emitEvent } from '../lifecycle/event-emit.js';

export interface ArchiveOptions {
  project?: string;
  reason?: string;
  dir?: string;
}

export interface ArchiveResult {
  success: boolean;
  message: string;
}

type TargetKind = 'ticket' | 'project';

interface ResolvedTarget {
  kind: TargetKind;
  /** Path to the frontmatter file to mutate (ticket.md or project.md). */
  filePath: string;
  /** Human-readable label for messages. */
  label: string;
}

/**
 * Resolve an `archive`/`restore` target to a concrete frontmatter file.
 * Order (see plan D4): `--project <slug>` → project-scoped ticket; else a
 * UUID/standalone via resolveTicketById; else treat `target` as a project
 * slug; else `null`.
 */
async function resolveTarget(target: string, options: ArchiveOptions): Promise<ResolvedTarget | null> {
  const config = await readConfig();
  const baseDir = options.dir ? expandHome(options.dir) : config.defaultProjectDir;

  // 1. Project-scoped ticket via --project.
  if (options.project) {
    if (!isValidSlug(options.project)) {
      throw new Error(`Invalid project slug "${options.project}".`);
    }
    if (!isValidSlug(target)) {
      throw new Error(`Invalid ticket slug "${target}".`);
    }
    const ticketMd = resolve(baseDir, options.project, 'tickets', target, 'ticket.md');
    if (!(await fileExists(ticketMd))) {
      throw new Error(`Ticket "${target}" not found in project "${options.project}".`);
    }
    return { kind: 'ticket', filePath: ticketMd, label: `ticket "${options.project}/${target}"` };
  }

  // 2. Ticket by UUID (standalone or project-nested).
  const resolved = await resolveTicketById(baseDir, ticketsDirFn(), target);
  if (resolved) {
    return {
      kind: 'ticket',
      filePath: resolve(resolved.ticketDir, 'ticket.md'),
      label: resolved.projectSlug
        ? `ticket "${resolved.projectSlug}/${resolved.ticketSlug}"`
        : `ticket "${target}"`,
    };
  }

  // 3. Project slug.
  const projectMd = resolve(baseDir, target, 'project.md');
  if (await fileExists(projectMd)) {
    return { kind: 'project', filePath: projectMd, label: `project "${target}"` };
  }

  return null;
}

async function writeArchiveState(
  filePath: string,
  archived: boolean,
  reason: string | null,
): Promise<void> {
  const content = await readFile(filePath, 'utf-8');
  const updated = updateTicketFile(content, {
    archived,
    archivedAt: archived ? nowTimestamp() : null,
    archivedReason: archived ? reason : null,
    updated: nowTimestamp(),
  });
  await writeFile(filePath, updated, 'utf-8');
}

/**
 * Emit an `archived`/`restored` audit event for an TICKET target only
 * (project archives have no ticket id and are out of v1 scope). Reads the
 * id + project slug off the freshly-written frontmatter. Best-effort.
 */
async function emitArchiveEvent(
  resolved: ResolvedTarget,
  type: 'archived' | 'restored',
  reason: string | null,
): Promise<void> {
  if (resolved.kind !== 'ticket') return;
  try {
    const fm = parseTicketFrontmatter(await readFile(resolved.filePath, 'utf-8'));
    emitEvent({
      ticketId: fm.id,
      projectSlug: fm.project,
      type,
      actor: 'human',
      details: reason ? { reason } : {},
    });
  } catch {
    /* best-effort */
  }
}

export async function runArchive(target: string, options: ArchiveOptions = {}): Promise<ArchiveResult> {
  const resolved = await resolveTarget(target, options);
  if (!resolved) {
    return { success: false, message: `No ticket or project matched "${target}".` };
  }
  await writeArchiveState(resolved.filePath, true, options.reason ?? null);
  await emitArchiveEvent(resolved, 'archived', options.reason ?? null);
  return { success: true, message: `Archived ${resolved.label}.` };
}

export async function runRestore(target: string, options: ArchiveOptions = {}): Promise<ArchiveResult> {
  const resolved = await resolveTarget(target, options);
  if (!resolved) {
    return { success: false, message: `No ticket or project matched "${target}".` };
  }
  await writeArchiveState(resolved.filePath, false, null);
  await emitArchiveEvent(resolved, 'restored', null);
  return { success: true, message: `Restored ${resolved.label}.` };
}

export function reportArchiveResult(result: ArchiveResult): void {
  if (!result.success) {
    throw new Error(result.message);
  }
  console.log(result.message);
}
