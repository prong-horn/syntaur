import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { expandHome } from '../utils/paths.js';
import { fileExists } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import { isValidSlug } from '../utils/slug.js';
import { nowTimestamp } from '../utils/timestamp.js';

export interface ArchiveOptions {
  reason?: string;
  dir?: string;
}

export interface ArchiveResult {
  success: boolean;
  message: string;
}

function applyProjectArchiveFields(
  content: string,
  archived: boolean,
  reason: string | null,
): string {
  const ts = archived ? `"${nowTimestamp()}"` : 'null';
  const reasonVal = archived && reason ? JSON.stringify(reason) : 'null';
  let next = content.replace(/^archived:\s*.*$/m, `archived: ${archived}`);
  if (/^archivedAt:\s*/m.test(next)) {
    next = next.replace(/^archivedAt:\s*.*$/m, `archivedAt: ${ts}`);
  } else {
    next = next.replace(/^(---\n[\s\S]*?)(\n---)/, `$1\narchivedAt: ${ts}$2`);
  }
  if (/^archivedReason:\s*/m.test(next)) {
    next = next.replace(/^archivedReason:\s*.*$/m, `archivedReason: ${reasonVal}`);
  }
  next = next.replace(/^updated:\s*.*$/m, `updated: "${nowTimestamp()}"`);
  return next;
}

async function resolveProject(target: string, options: ArchiveOptions): Promise<string | null> {
  const config = await readConfig();
  const baseDir = options.dir ? expandHome(options.dir) : config.defaultProjectDir;
  if (!isValidSlug(target)) return null;
  const projectMd = resolve(baseDir, target, 'project.md');
  if (!(await fileExists(projectMd))) return null;
  return projectMd;
}

export async function archiveCommand(target: string, options: ArchiveOptions = {}): Promise<void> {
  const filePath = await resolveProject(target, options);
  if (!filePath) {
    throw new Error(`No project matched "${target}". Ticket archiving was removed in v2 — use drop instead.`);
  }
  const content = await readFile(filePath, 'utf-8');
  await writeFile(
    filePath,
    applyProjectArchiveFields(content, true, options.reason ?? null),
    'utf-8',
  );
  console.log(`Archived project "${target}".`);
}

export async function runProjectRestore(target: string, options: ArchiveOptions = {}): Promise<void> {
  const filePath = await resolveProject(target, options);
  if (!filePath) {
    throw new Error(`No project matched "${target}".`);
  }
  const content = await readFile(filePath, 'utf-8');
  await writeFile(filePath, applyProjectArchiveFields(content, false, null), 'utf-8');
  console.log(`Restored project "${target}".`);
}
