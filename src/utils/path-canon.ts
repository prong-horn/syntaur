import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Canonicalize a filesystem path for reliable comparison. When the path exists,
 * resolves symlinks (handles macOS `/var` vs `/private/var`); otherwise returns
 * the absolute path with any trailing slash stripped. Never throws — used to key
 * the worktree→assignment reverse map, where both sides must canonicalize the
 * same way regardless of whether the dir is currently present on disk.
 */
export function canonicalPath(p: string): string {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p).replace(/\/+$/, '');
  }
}
