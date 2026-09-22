import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openWalDatabase } from '../db/open-sqlite.js';

const require = createRequire(import.meta.url);
const betterSqlite3Path = require.resolve('better-sqlite3');

const HOLDER_SCRIPT = `
const Database = require(process.argv[1]);
const dbPath = process.argv[2];
const db = new Database(dbPath);
db.exec('BEGIN IMMEDIATE');
process.stdout.write('held\\n');
setTimeout(() => {
  db.exec('COMMIT');
  db.close();
  process.exit(0);
}, 300);
`;

function journalModeWal(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.pragma('journal_mode', { simple: true }) as string;
    return row;
  } finally {
    db.close();
  }
}

async function waitForHolderReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  let held = false;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('timed out waiting for holder to print held'));
    }, 5000);

    const finish = (err?: Error) => {
      clearTimeout(timeout);
      if (err) reject(err);
      else resolve();
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (held) return;
      if (chunk.toString().includes('held')) {
        held = true;
        finish();
      }
    });

    child.on('error', (err) => finish(err));

    child.on('close', (code, signal) => {
      if (held) return;
      finish(
        new Error(
          `holder exited before held (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
        ),
      );
    });
  });
}

describe('openWalDatabase', () => {
  let scratchRoot: string | undefined;

  afterEach(async () => {
    if (scratchRoot) {
      await rm(scratchRoot, { recursive: true, force: true });
      scratchRoot = undefined;
    }
  });

  it('waits out a RESERVED holder on a fresh database file', async () => {
    scratchRoot = await mkdtemp(join(tmpdir(), 'sv23-open-wal-'));
    const dbPath = join(scratchRoot, 'test.db');

    const child = spawn(process.execPath, ['-e', HOLDER_SCRIPT, betterSqlite3Path, dbPath], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    try {
      await waitForHolderReady(child);

      const start = Date.now();
      const db = openWalDatabase(dbPath);
      const elapsed = Date.now() - start;
      try {
        expect(elapsed).toBeGreaterThanOrEqual(100);
        expect(journalModeWal(dbPath)).toBe('wal');
      } finally {
        db.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    }
  });

  it('runs init inside the retry loop and leaves schema in place', () => {
    scratchRoot = mkdtempSync(join(tmpdir(), 'sv23-open-wal-'));
    const dbPath = join(scratchRoot, 'init.db');

    const db = openWalDatabase(dbPath, {
      init: (handle) => {
        handle.exec('CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY)');
      },
    });
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM probe').get() as { n: number };
      expect(row.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('enables foreign keys when foreignKeys is true', () => {
    scratchRoot = mkdtempSync(join(tmpdir(), 'sv23-open-wal-'));
    const dbPath = join(scratchRoot, 'fk.db');

    const db = openWalDatabase(dbPath, { foreignKeys: true });
    try {
      const fk = db.pragma('foreign_keys', { simple: true });
      expect(fk).toBe(1);
    } finally {
      db.close();
    }
  });

  it('throws SQLITE_CANTOPEN when the path cannot be opened, then opens a valid path', () => {
    scratchRoot = mkdtempSync(join(tmpdir(), 'sv23-open-wal-'));
    const badPath = join(scratchRoot, 'missing', 'deeper', 'x.db');
    mkdirSync(badPath, { recursive: true });

    let caught: unknown;
    try {
      openWalDatabase(badPath);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Database.SqliteError);
    expect((caught as Database.SqliteError).code).toBe('SQLITE_CANTOPEN');

    const goodPath = join(scratchRoot, 'good.db');
    const db = openWalDatabase(goodPath);
    try {
      expect(journalModeWal(goodPath)).toBe('wal');
    } finally {
      db.close();
    }
  });
});
