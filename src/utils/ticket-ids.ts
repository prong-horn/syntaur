import { constants } from 'node:fs';
import { open, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileExists } from './fs.js';

const TICKET_ID_RE = /^[A-Z]{2,5}-\d+$/;
const LOCK_STALE_MS = 30_000;
const LOCK_MAX_WAIT_MS = 5_000;

export interface ParsedTicketId {
  prefix: string;
  number: number;
}

export function isTicketId(value: string): boolean {
  return TICKET_ID_RE.test(value);
}

export function parseTicketId(value: string): ParsedTicketId | null {
  const match = value.match(/^([A-Z]{2,5})-(\d+)$/);
  if (!match) return null;
  return { prefix: match[1], number: Number.parseInt(match[2], 10) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/**
 * Derive a project ticket prefix from its slug. Multi-word slugs use initials;
 * single-word slugs use the first three letters. Padded to two characters from
 * the first word when shorter, capped at five. When `existingPrefixes` already
 * contains the candidate, append the next unused letter from the slug.
 */
export function derivePrefix(
  slug: string,
  existingPrefixes: Iterable<string> = [],
): string {
  const used = new Set(existingPrefixes);
  const words = slug.split('-').filter(Boolean);
  if (words.length === 0) {
    throw new Error('Cannot derive prefix from empty slug.');
  }

  let base: string;
  if (words.length === 1) {
    base = words[0].slice(0, 3).toUpperCase();
  } else {
    base = words.map((word) => word[0]?.toUpperCase() ?? '').join('');
  }

  const firstWord = words[0].toUpperCase();
  let i = base.length;
  while (base.length < 2 && i < firstWord.length) {
    base += firstWord[i];
    i += 1;
  }

  base = base.slice(0, 5);

  const slugLetters = slug.replace(/-/g, '').toUpperCase();
  let prefix = base;
  let letterIndex = base.length;

  while (used.has(prefix)) {
    while (letterIndex < slugLetters.length) {
      const letter = slugLetters[letterIndex];
      letterIndex += 1;
      if (!prefix.includes(letter)) {
        prefix = `${prefix}${letter}`.slice(0, 5);
        break;
      }
    }
    if (used.has(prefix)) {
      // Exhausted slug letters — extend with the next alphabetic suffix.
      for (let n = 0; n < 26; n += 1) {
        const candidate = `${base}${String.fromCharCode(65 + n)}`.slice(0, 5);
        if (!used.has(candidate)) {
          prefix = candidate;
          break;
        }
      }
    }
    if (used.has(prefix)) {
      throw new Error(`Unable to derive a unique prefix for slug "${slug}".`);
    }
  }

  return prefix;
}

function parseScalar(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'null' || trimmed === '~') return null;
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function getFrontmatterField(frontmatter: string, key: string): string | null {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  return match ? parseScalar(match[1]) : null;
}

export async function readProjectTicketCounter(
  projectDir: string,
): Promise<{ prefix: string; nextTicket: number }> {
  const projectMd = resolve(projectDir, 'project.md');
  const content = await readFile(projectMd, 'utf-8');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    throw new Error(`Invalid project.md at ${projectMd}`);
  }
  const prefix = getFrontmatterField(fmMatch[1], 'prefix');
  const nextRaw = getFrontmatterField(fmMatch[1], 'nextTicket');
  if (!prefix) {
    throw new Error(`Project at ${projectDir} is missing prefix in project.md`);
  }
  const nextTicket = Number.parseInt(nextRaw ?? '1', 10);
  if (!Number.isFinite(nextTicket) || nextTicket < 1) {
    throw new Error(`Project at ${projectDir} has invalid nextTicket: ${nextRaw}`);
  }
  return { prefix, nextTicket };
}

/**
 * Deviation (Phase B): lazily writes `prefix`/`nextTicket` only when `prefix` is
 * absent — never rewrites an existing prefix. Production homes get prefixes from
 * `migrate v2` (Task 9); this path is for legacy/test project.md only.
 */
async function ensureProjectTicketCounter(
  projectDir: string,
): Promise<{ prefix: string; nextTicket: number }> {
  try {
    return await readProjectTicketCounter(projectDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('missing prefix')) {
      throw err;
    }
    const projectMd = resolve(projectDir, 'project.md');
    const content = await readFile(projectMd, 'utf-8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) {
      throw new Error(`Invalid project.md at ${projectMd}`);
    }
    const slug =
      getFrontmatterField(fmMatch[1], 'slug') ??
      getFrontmatterField(fmMatch[1], 'mission') ??
      basename(projectDir);
    const projectsDir = dirname(projectDir);
    const existing = await collectExistingPrefixes(projectsDir);
    const prefix = derivePrefix(slug, existing);
    const nextTicket = 1;
    const body = content.slice(fmMatch[0].length);
    let frontmatter = fmMatch[1];
    frontmatter = `${frontmatter}\nprefix: ${prefix}\nnextTicket: ${nextTicket}\ndefaultTemplate: feature`;
    await writeFile(projectMd, `---\n${frontmatter}\n---${body}`, 'utf-8');
    return { prefix, nextTicket };
  }
}

async function writeProjectNextTicket(
  projectDir: string,
  nextTicket: number,
): Promise<void> {
  const projectMd = resolve(projectDir, 'project.md');
  const content = await readFile(projectMd, 'utf-8');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    throw new Error(`Invalid project.md at ${projectMd}`);
  }
  const body = content.slice(fmMatch[0].length);
  let frontmatter = fmMatch[1];
  if (/^nextTicket:\s*/m.test(frontmatter)) {
    frontmatter = frontmatter.replace(/^nextTicket:\s*.*$/m, `nextTicket: ${nextTicket}`);
  } else {
    frontmatter = `${frontmatter}\nnextTicket: ${nextTicket}`;
  }
  await writeFile(projectMd, `---\n${frontmatter}\n---${body}`, 'utf-8');
}

async function removeStaleLock(lockPath: string): Promise<void> {
  try {
    const lockStat = await stat(lockPath);
    if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
      await unlink(lockPath);
    }
  } catch {
    // No lock file — nothing to remove.
  }
}

async function acquireTicketLock(lockPath: string): Promise<() => Promise<void>> {
  const started = Date.now();
  let backoff = 25;
  while (Date.now() - started < LOCK_MAX_WAIT_MS) {
    await removeStaleLock(lockPath);
    try {
      const handle = await open(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      );
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return async () => {
        try {
          await unlink(lockPath);
        } catch {
          // Best effort.
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 500);
    }
  }
  throw new Error(`Timed out acquiring ticket lock at ${lockPath}`);
}

/** Allocate the next `<PREFIX>-<n>` id for a project, bumping `nextTicket`. */
export async function allocateTicketId(projectDir: string): Promise<string> {
  const lockPath = resolve(projectDir, '.ticket-lock');
  const release = await acquireTicketLock(lockPath);
  try {
    const { prefix, nextTicket } = await ensureProjectTicketCounter(projectDir);
    const id = `${prefix}-${nextTicket}`;
    await writeProjectNextTicket(projectDir, nextTicket + 1);
    return id;
  } finally {
    await release();
  }
}

/** Collect prefixes from every project under `projectsDir`. */
export async function collectExistingPrefixes(projectsDir: string): Promise<Set<string>> {
  const prefixes = new Set<string>();
  if (!(await fileExists(projectsDir))) return prefixes;
  const entries = await readdir(projectsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectDir = resolve(projectsDir, entry.name);
    const projectMd = resolve(projectDir, 'project.md');
    if (!(await fileExists(projectMd))) continue;
    try {
      const { prefix } = await readProjectTicketCounter(projectDir);
      prefixes.add(prefix);
    } catch {
      // Legacy projects without prefix are ignored during derivation.
    }
  }
  return prefixes;
}
