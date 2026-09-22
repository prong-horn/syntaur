import Database from 'better-sqlite3';

const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const INIT_RETRY_BACKOFF_MS = 5;

export function isSqliteBusy(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) {
    return false;
  }
  const code = (err as { code: unknown }).code;
  return typeof code === 'string' && code.startsWith('SQLITE_BUSY');
}

export function sleepSync(ms: number): void {
  const buf = new SharedArrayBuffer(4);
  const arr = new Int32Array(buf);
  Atomics.wait(arr, 0, 0, ms);
}

function initializeWalDatabase(
  db: Database.Database,
  deadline: number,
  init?: (db: Database.Database) => void,
): void {
  for (;;) {
    try {
      db.pragma('journal_mode = WAL');
      if (init) {
        init(db);
      }
      return;
    } catch (err) {
      if (isSqliteBusy(err) && Date.now() < deadline) {
        sleepSync(INIT_RETRY_BACKOFF_MS);
        continue;
      }
      throw err;
    }
  }
}

export type OpenWalDatabaseOptions = {
  busyTimeoutMs?: number;
  foreignKeys?: boolean;
  /**
   * Optional idempotent initializer invoked inside the WAL-switch retry loop
   * (together with `journal_mode = WAL`). Must be safe to run more than once
   * if SQLITE_BUSY retries occur. Only lock-coordination passes this today.
   */
  init?: (db: Database.Database) => void;
};

/**
 * Open a SQLite database with `busy_timeout` set first, then WAL journal mode
 * with a bounded retry on SQLITE_BUSY* (WAL switch is not covered by busy_timeout).
 * Optionally enables foreign keys after a successful WAL switch.
 */
export function openWalDatabase(
  path: string,
  options?: OpenWalDatabaseOptions,
): Database.Database {
  const busyTimeoutMs = options?.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  const db = new Database(path);
  try {
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    const deadline = Date.now() + busyTimeoutMs;
    initializeWalDatabase(db, deadline, options?.init);
    if (options?.foreignKeys) {
      db.pragma('foreign_keys = ON');
    }
    return db;
  } catch (err) {
    try {
      db.close();
    } catch {
      /* best effort */
    }
    throw err;
  }
}
