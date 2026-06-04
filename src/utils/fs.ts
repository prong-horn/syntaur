import { mkdir, writeFile, readFile, access, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function writeFileSafe(
  filePath: string,
  content: string,
): Promise<boolean> {
  if (await fileExists(filePath)) {
    return false;
  }
  await ensureDir(dirname(filePath));
  await writeFile(filePath, content, 'utf-8');
  return true;
}

export async function writeFileForce(
  filePath: string,
  content: string,
): Promise<void> {
  const dir = dirname(filePath);
  const tempPath = join(
    dir,
    `.${Math.random().toString(36).slice(2)}.${Date.now()}.tmp`,
  );
  await ensureDir(dir);
  await writeFile(tempPath, content, 'utf-8');
  await rename(tempPath, filePath);
}

export type WriteReportStatus =
  | 'written'
  | 'already-current'
  | 'differs-preserved'
  | 'overwritten';

/**
 * Content-aware idempotent write. Unlike `writeFileSafe` (which skips on mere
 * existence), this compares the on-disk content:
 *   - missing            → write          → 'written'
 *   - present & equal    → no-op          → 'already-current'
 *   - present & differs  → keep (no force)→ 'differs-preserved'
 *   - present & differs  → overwrite      → 'overwritten' (force)
 * Mirrors the skill-install status vocabulary so adapter writes report honestly.
 */
export async function writeFileReport(
  filePath: string,
  content: string,
  options: { force?: boolean } = {},
): Promise<WriteReportStatus> {
  if (!(await fileExists(filePath))) {
    await ensureDir(dirname(filePath));
    await writeFile(filePath, content, 'utf-8');
    return 'written';
  }
  const current = await readFile(filePath, 'utf-8').catch(() => null);
  if (current === content) {
    return 'already-current';
  }
  if (!options.force) {
    return 'differs-preserved';
  }
  await writeFileForce(filePath, content);
  return 'overwritten';
}
