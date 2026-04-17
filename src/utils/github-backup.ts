import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, rm, readFile, writeFile, unlink, stat, open, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { syntaurRoot, playbooksDir, todosDir, serversDir } from './paths.js';
import { ensureDir, fileExists } from './fs.js';
import { readConfig, updateBackupConfig, type BackupConfig } from './config.js';

const exec = promisify(execFile);

export const VALID_CATEGORIES = ['missions', 'playbooks', 'todos', 'servers', 'config'] as const;
export type BackupCategory = (typeof VALID_CATEGORIES)[number];

const LOCK_FILE_NAME = '.backup-lock';

export function parseCategories(csv: string): BackupCategory[] {
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is BackupCategory => (VALID_CATEGORIES as readonly string[]).includes(s));
}

export function validateCategories(cats: string[]): BackupCategory[] {
  const valid: BackupCategory[] = [];
  for (const cat of cats) {
    if ((VALID_CATEGORIES as readonly string[]).includes(cat)) {
      valid.push(cat as BackupCategory);
    } else {
      console.warn(`Warning: unknown backup category "${cat}", skipping`);
    }
  }
  return valid;
}

export function parseCategoriesStrict(cats: string[]): BackupCategory[] {
  const unknown: string[] = [];
  const valid: BackupCategory[] = [];
  for (const cat of cats) {
    if ((VALID_CATEGORIES as readonly string[]).includes(cat)) {
      valid.push(cat as BackupCategory);
    } else {
      unknown.push(cat);
    }
  }
  if (unknown.length > 0) {
    throw new Error(
      `Unknown categor${unknown.length === 1 ? 'y' : 'ies'}: ${unknown.map((c) => `"${c}"`).join(', ')}. Valid: ${VALID_CATEGORIES.join(', ')}`,
    );
  }
  return valid;
}

export function validateRepoUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  return trimmed.startsWith('https://') || trimmed.startsWith('git@');
}

export async function resolveCategoryPath(
  category: BackupCategory,
): Promise<{ sourcePath: string; repoPath: string; isFile: boolean }> {
  switch (category) {
    case 'missions': {
      const config = await readConfig();
      return { sourcePath: config.defaultMissionDir, repoPath: 'missions', isFile: false };
    }
    case 'playbooks':
      return { sourcePath: playbooksDir(), repoPath: 'playbooks', isFile: false };
    case 'todos':
      return { sourcePath: todosDir(), repoPath: 'todos', isFile: false };
    case 'servers':
      return { sourcePath: serversDir(), repoPath: 'servers', isFile: false };
    case 'config':
      return { sourcePath: resolve(syntaurRoot(), 'config.md'), repoPath: 'config.md', isFile: true };
  }
}

async function checkGitInstalled(): Promise<void> {
  try {
    await exec('git', ['--version']);
  } catch {
    throw new Error('git is not installed or not on PATH. Install git and try again.');
  }
}

async function acquireLock(): Promise<string> {
  const lockPath = resolve(syntaurRoot(), LOCK_FILE_NAME);
  await ensureDir(syntaurRoot());
  try {
    const handle = await open(lockPath, 'wx');
    await handle.write(String(process.pid));
    await handle.close();
    return lockPath;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      const pid = await readFile(lockPath, 'utf-8').catch(() => '');
      throw new Error(
        `Backup operation already in progress (lock file at ${lockPath}, pid ${pid.trim() || 'unknown'}). If stale, delete the file and retry.`,
      );
    }
    throw err;
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch {
    // ignore
  }
}

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return exec('git', args, { cwd });
}

async function cloneOrInit(repoUrl: string, destDir: string): Promise<void> {
  try {
    await exec('git', ['clone', '--depth', '1', repoUrl, destDir]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Repository not found') || message.includes('does not appear to be a git repository')) {
      throw new Error(`Repository not found or inaccessible: ${repoUrl}. Check URL and credentials.`);
    }
    if (message.includes('Authentication failed') || message.includes('could not read Username')) {
      throw new Error(`Authentication failed for ${repoUrl}. Check SSH keys or credentials.`);
    }
    throw new Error(`git clone failed: ${message}`);
  }
}

async function copyRecursive(src: string, dest: string): Promise<void> {
  if (!(await fileExists(src))) return;
  const s = await stat(src);
  if (s.isDirectory()) {
    await ensureDir(dest);
    await cp(src, dest, { recursive: true, force: true });
  } else {
    await ensureDir(resolve(dest, '..'));
    await cp(src, dest, { force: true });
  }
}

export interface BackupResult {
  success: boolean;
  timestamp: string;
  message: string;
  committed: boolean;
}

function resolveCategoriesStrict(csv: string): BackupCategory[] {
  const parts = csv.split(',').map((s) => s.trim()).filter(Boolean);
  return parseCategoriesStrict(parts);
}

/**
 * Read config.md and return a version with lastBackup/lastRestore set to null.
 * This is the copy that goes into the backup repo, so those timestamps — which
 * mutate on every local operation — never cause a self-diff on subsequent backups.
 */
export async function readSanitizedConfig(configPath: string): Promise<string> {
  const content = await readFile(configPath, 'utf-8');
  return content
    .replace(/^(\s*lastBackup:\s*).*$/m, '$1null')
    .replace(/^(\s*lastRestore:\s*).*$/m, '$1null');
}

export async function backupToGithub(overrides?: {
  repo?: string;
  categories?: BackupCategory[];
}): Promise<BackupResult> {
  await checkGitInstalled();
  const config = await readConfig();
  const rawRepo = overrides?.repo ?? config.backup?.repo ?? null;
  if (!rawRepo) {
    throw new Error('No backup repo configured. Set it via `syntaur backup config --repo <url>` or the dashboard.');
  }
  const repo = rawRepo.trim();
  if (!validateRepoUrl(repo)) {
    throw new Error(`Invalid repo URL: "${rawRepo}". Must start with https:// or git@.`);
  }

  const categoriesCsv = config.backup?.categories ?? 'missions, playbooks, todos, servers, config';
  const categories = overrides?.categories ?? resolveCategoriesStrict(categoriesCsv);
  if (categories.length === 0) {
    throw new Error('No valid backup categories selected.');
  }

  const lockPath = await acquireLock();
  let tmpDir: string | null = null;
  const timestamp = new Date().toISOString();

  try {
    tmpDir = await mkdtemp(join(tmpdir(), 'syntaur-backup-'));
    await cloneOrInit(repo, tmpDir);

    // Copy each selected category into the repo clone.
    // Always clear the destination first so local deletions propagate to the repo.
    for (const category of categories) {
      const { sourcePath, repoPath, isFile } = await resolveCategoryPath(category);
      const destPath = join(tmpDir, repoPath);

      if (isFile) {
        await rm(destPath, { force: true });
      } else {
        await rm(destPath, { recursive: true, force: true });
      }

      if (!(await fileExists(sourcePath))) {
        console.warn(`Category "${category}": no local data at ${sourcePath}; backup will reflect deletion.`);
        continue;
      }

      if (category === 'config') {
        // Sanitize config.md before writing to the repo: strip lastBackup/lastRestore
        // timestamps so they don't cause a self-diff on every backup.
        const sanitized = await readSanitizedConfig(sourcePath);
        await ensureDir(resolve(destPath, '..'));
        await writeFile(destPath, sanitized, 'utf-8');
      } else {
        await copyRecursive(sourcePath, destPath);
      }
    }

    // Stage and check for changes
    await runGit(['add', '-A'], tmpDir);
    const { stdout: status } = await runGit(['status', '--porcelain'], tmpDir);
    if (!status.trim()) {
      // No-op but successful: persist timestamp so UI reflects the completed check
      await updateBackupConfig({ lastBackup: timestamp }).catch(() => {});
      return {
        success: true,
        timestamp,
        message: 'No changes to back up.',
        committed: false,
      };
    }

    // Configure committer if unset (best-effort; user may have global config)
    try {
      await runGit(['config', 'user.email', 'syntaur@local'], tmpDir);
      await runGit(['config', 'user.name', 'Syntaur Backup'], tmpDir);
    } catch {
      // ignore
    }

    await runGit(['commit', '-m', `Syntaur backup ${timestamp}`], tmpDir);

    try {
      await runGit(['push'], tmpDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('non-fast-forward') || message.includes('rejected')) {
        throw new Error('Push rejected (non-fast-forward). Pull and resolve manually, or delete remote contents.');
      }
      if (message.includes('Authentication') || message.includes('could not read Username')) {
        throw new Error('Push authentication failed. Check SSH keys or credentials.');
      }
      throw new Error(`git push failed: ${message}`);
    }

    // Push succeeded: persist timestamp
    await updateBackupConfig({ lastBackup: timestamp }).catch(() => {});

    return {
      success: true,
      timestamp,
      message: `Backed up ${categories.length} categor${categories.length === 1 ? 'y' : 'ies'} to ${repo}.`,
      committed: true,
    };
  } finally {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
    await releaseLock(lockPath);
  }
}

export async function safeRestoreCategory(
  localPath: string,
  repoSrcPath: string,
  isFile: boolean,
): Promise<void> {
  if (isFile) {
    // Single file: cp handles atomic rename internally. No staging needed.
    await ensureDir(resolve(localPath, '..'));
    await cp(repoSrcPath, localPath, { force: true });
    return;
  }

  // Directory: stage, then swap.
  const stagingPath = `${localPath}.syntaur-restore-staging`;
  const backupPath = `${localPath}.syntaur-restore-backup`;

  // Stale staging from a crashed run is always safe to discard.
  await rm(stagingPath, { recursive: true, force: true });

  // A pre-existing backup dir means a prior run crashed mid-swap and it may contain
  // the only copy of the user's original data. Do NOT delete it blindly.
  const backupExistsBefore = await fileExists(backupPath);
  const localExistsBefore = await fileExists(localPath);
  if (backupExistsBefore) {
    if (!localExistsBefore) {
      // Prior crash left the backup as the only copy. Restore it first.
      await rename(backupPath, localPath);
    } else {
      // Both exist — we can't tell which is authoritative. Bail out.
      throw new Error(
        `Cannot restore "${localPath}": a stale crash-recovery backup exists at ${backupPath} while the current path also exists. ` +
          `Inspect both and remove the one you don't need, then retry.`,
      );
    }
  }

  let localMovedAside = false;
  try {
    // Copy repo contents into staging. If this fails, local is untouched.
    await cp(repoSrcPath, stagingPath, { recursive: true, force: true });

    // Move current local aside (if it exists).
    const localExists = await fileExists(localPath);
    if (localExists) {
      await rename(localPath, backupPath);
      localMovedAside = true;
    }

    // Swap staging into place.
    await rename(stagingPath, localPath);

    // Success: remove the old data.
    await rm(backupPath, { recursive: true, force: true }).catch(() => {});
  } catch (err) {
    // Roll back: restore original if we moved it aside.
    if (localMovedAside && (await fileExists(backupPath))) {
      await rename(backupPath, localPath).catch(() => {});
    }
    // Always clean up staging (may or may not exist depending on where we failed).
    await rm(stagingPath, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

export async function restoreFromGithub(overrides?: {
  repo?: string;
  categories?: BackupCategory[];
}): Promise<BackupResult> {
  await checkGitInstalled();
  const config = await readConfig();
  const rawRepo = overrides?.repo ?? config.backup?.repo ?? null;
  if (!rawRepo) {
    throw new Error('No backup repo configured.');
  }
  const repo = rawRepo.trim();
  if (!validateRepoUrl(repo)) {
    throw new Error(`Invalid repo URL: "${rawRepo}".`);
  }

  const categoriesCsv = config.backup?.categories ?? 'missions, playbooks, todos, servers, config';
  const categories = overrides?.categories ?? resolveCategoriesStrict(categoriesCsv);
  if (categories.length === 0) {
    throw new Error('No valid restore categories selected.');
  }

  const lockPath = await acquireLock();
  let tmpDir: string | null = null;
  const restored: string[] = [];
  const failed: string[] = [];
  const timestamp = new Date().toISOString();

  try {
    // Persist timestamp before work so UI reflects the attempt even on partial failure.
    // Inside try so lock is released even if config write fails.
    await updateBackupConfig({ lastRestore: timestamp });

    tmpDir = await mkdtemp(join(tmpdir(), 'syntaur-restore-'));
    await cloneOrInit(repo, tmpDir);

    for (const category of categories) {
      // Never overwrite config.md on restore — would clobber backup settings
      if (category === 'config') {
        console.warn('Skipping "config" on restore (would overwrite local backup settings).');
        continue;
      }
      try {
        const { sourcePath: localPath, repoPath, isFile } = await resolveCategoryPath(category);
        const repoSrcPath = join(tmpDir, repoPath);
        if (!(await fileExists(repoSrcPath))) {
          console.warn(`Category "${category}" not found in backup repo, skipping.`);
          continue;
        }
        await safeRestoreCategory(localPath, repoSrcPath, isFile);
        restored.push(category);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`Failed to restore "${category}": ${msg}`);
        failed.push(category);
      }
    }

    const success = failed.length === 0;
    return {
      success,
      timestamp,
      message: success
        ? `Restored ${restored.length} categor${restored.length === 1 ? 'y' : 'ies'} from ${repo}.`
        : `Partial restore: ${restored.length} succeeded, ${failed.length} failed (${failed.join(', ')}).`,
      committed: false,
    };
  } finally {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
    await releaseLock(lockPath);
  }
}

export async function getBackupStatus(): Promise<{
  repo: string | null;
  categories: string;
  lastBackup: string | null;
  lastRestore: string | null;
  locked: boolean;
}> {
  const config = await readConfig();
  const lockPath = resolve(syntaurRoot(), LOCK_FILE_NAME);
  const locked = await fileExists(lockPath);
  return {
    repo: config.backup?.repo ?? null,
    categories: config.backup?.categories ?? 'missions, playbooks, todos, servers, config',
    lastBackup: config.backup?.lastBackup ?? null,
    lastRestore: config.backup?.lastRestore ?? null,
    locked,
  };
}
