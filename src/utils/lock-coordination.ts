import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { openWalDatabase } from '../db/open-sqlite.js';
import { canonicalPath } from './path-canon.js';
import { syntaurRoot } from './paths.js';

const COORD_SCHEMA = `CREATE TABLE IF NOT EXISTS lock_recovery (
  lock_key TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL
)`;

const coordDbs = new Map<string, Database.Database>();

function coordinationRoot(root?: string): string {
  return root ?? syntaurRoot();
}

function coordinationDb(root?: string): Database.Database {
  const base = coordinationRoot(root);
  const dbPath = resolve(base, 'runtime', 'lock-coord.db');
  const existing = coordDbs.get(dbPath);
  if (existing) return existing;
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openWalDatabase(dbPath, { init: (handle) => handle.exec(COORD_SCHEMA) });
  coordDbs.set(dbPath, db);
  return db;
}

export function canonicalLockPath(lockPath: string): string {
  return canonicalPath(resolve(lockPath));
}

function lockKey(lockPath: string): string {
  return createHash('sha256').update(canonicalLockPath(lockPath)).digest('hex');
}

/**
 * Serialize every mutation of one filesystem lock/owner record across processes.
 * Callbacks must be synchronous and only touch the named lock file (plus its
 * temp publish sibling). Uses BEGIN IMMEDIATE so writers exclude each other.
 */
export function withLockRecordCoordination<T>(
  lockPath: string,
  fn: () => T,
  root?: string,
): T {
  const canonical = canonicalLockPath(lockPath);
  const db = coordinationDb(root);
  const key = lockKey(canonical);
  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO lock_recovery(lock_key, updated_at) VALUES (?, ?)
       ON CONFLICT(lock_key) DO UPDATE SET updated_at = excluded.updated_at`,
    ).run(key, Date.now());
    return fn();
  });
  return run.immediate();
}

function eexist(message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = 'EEXIST';
  return err;
}

function writeInitializedTempSync(tmpPath: string, payload: string): void {
  const fd = openSync(tmpPath, 'w');
  try {
    const buf = Buffer.from(payload, 'utf-8');
    writeSync(fd, buf, 0, buf.length);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Publish a fully initialized record via temp file + atomic rename.
 * Caller must already hold the per-path coordination transaction.
 */
function publishLockRecordSync(lockPath: string, payload: string): void {
  const canonical = canonicalLockPath(lockPath);
  mkdirSync(dirname(canonical), { recursive: true });
  if (existsSync(canonical)) {
    throw eexist(`Lock record already held at ${canonical}`);
  }
  const tmp = `${canonical}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  writeInitializedTempSync(tmp, payload);
  try {
    renameSync(tmp, canonical);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
}

function readLockPayloadSync(lockPath: string): string | null {
  const canonical = canonicalLockPath(lockPath);
  try {
    return readFileSync(canonical, 'utf-8');
  } catch {
    return null;
  }
}

function unlinkLockRecordSync(lockPath: string): void {
  const canonical = canonicalLockPath(lockPath);
  try {
    unlinkSync(canonical);
  } catch {
    /* best effort */
  }
}

/**
 * Compare-and-delete stale lock/owner records under cross-process serialization.
 */
export function recoverStaleLockRecordSerialized(
  lockPath: string,
  isDefinitelyStale: (raw: string) => boolean,
  root?: string,
): boolean {
  return withLockRecordCoordination(
    lockPath,
    () => {
      const raw = readLockPayloadSync(lockPath);
      if (!raw || !isDefinitelyStale(raw)) return false;
      unlinkLockRecordSync(lockPath);
      return true;
    },
    root,
  );
}

/**
 * Recover (if stale) then exclusively publish a new lock record.
 * Throws EEXIST when a live record remains.
 */
export function acquireLockRecordSerialized(
  lockPath: string,
  payload: string,
  isDefinitelyStale: (raw: string) => boolean,
  root?: string,
): void {
  withLockRecordCoordination(
    lockPath,
    () => {
      const raw = readLockPayloadSync(lockPath);
      if (raw) {
        if (isDefinitelyStale(raw)) {
          unlinkLockRecordSync(lockPath);
        } else {
          throw eexist(`Lock record already held at ${canonicalLockPath(lockPath)}`);
        }
      }
      publishLockRecordSync(lockPath, payload);
    },
    root,
  );
}

/**
 * Token-checked release under the same coordination mutex as acquire/recover.
 */
export function releaseLockRecordSerialized(
  lockPath: string,
  ownerToken: string,
  pid: number,
  parse: (raw: string) => { ownerToken: string; pid: number } | null,
  root?: string,
): boolean {
  return withLockRecordCoordination(
    lockPath,
    () => {
      const raw = readLockPayloadSync(lockPath);
      if (!raw) return false;
      const parsed = parse(raw);
      if (!parsed || parsed.ownerToken !== ownerToken || parsed.pid !== pid) {
        return false;
      }
      unlinkLockRecordSync(lockPath);
      return true;
    },
    root,
  );
}

/** @internal */
export function _closeCoordinationDb(root?: string): void {
  const base = coordinationRoot(root);
  const dbPath = resolve(base, 'runtime', 'lock-coord.db');
  const db = coordDbs.get(dbPath);
  if (db) {
    db.close();
    coordDbs.delete(dbPath);
  }
}
