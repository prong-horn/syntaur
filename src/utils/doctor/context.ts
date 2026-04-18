import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { readConfig } from '../config.js';
import { syntaurRoot } from '../paths.js';
import { fileExists } from '../fs.js';
import type { CheckContext } from './types.js';

export async function buildCheckContext(cwd: string = process.cwd()): Promise<CheckContext> {
  const config = await readConfig();
  const root = syntaurRoot();
  const dbPath = resolve(root, 'syntaur.db');

  let db: Database.Database | null = null;
  let dbError: string | null = null;

  if (await fileExists(dbPath)) {
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch (err) {
      dbError = err instanceof Error ? err.message : String(err);
      db = null;
    }
  } else {
    dbError = `database file not found at ${dbPath}`;
  }

  return {
    config,
    syntaurRoot: root,
    db,
    dbError,
    cwd,
    now: new Date(),
  };
}

export function closeCheckContext(ctx: CheckContext): void {
  if (ctx.db) {
    try {
      ctx.db.close();
    } catch {
      // ignore — read-only close errors are not actionable
    }
  }
}
