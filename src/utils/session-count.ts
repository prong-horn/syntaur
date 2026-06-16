import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

/**
 * Count agent-session rows whose recorded `path` matches any of `paths`.
 *
 * READ-ONLY by construction: opens the DB with `{ readonly: true, fileMustExist:
 * true }` and NEVER creates or migrates it (do not route this through
 * `initSessionDb`, which would create `syntaur.db`). Degrades to `0` if the DB is
 * absent, the `sessions` table is missing, or any error occurs. Callers should
 * pass a pre-filtered, de-duplicated list of truthy paths.
 */
export function countSessionsByPath(dbPath: string, paths: string[]): number {
  if (paths.length === 0) return 0;
  if (!existsSync(dbPath)) return 0;
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const placeholders = paths.map(() => '?').join(',');
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM sessions WHERE path IN (${placeholders})`)
        .get(...paths) as { n: number } | undefined;
      return row?.n ?? 0;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}
