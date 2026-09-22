import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  _closeCoordinationDb,
  acquireLockRecordSerialized,
  recoverStaleLockRecordSerialized,
  releaseLockRecordSerialized,
} from '../utils/lock-coordination.js';

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

describe('lock-coordination fresh DB init', () => {
  let root: string;

  afterEach(async () => {
    if (root) {
      _closeCoordinationDb(root);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('waits out a RESERVED holder on a fresh coordination DB', async () => {
    root = await mkdtemp(join(tmpdir(), 'sv18-coord-'));
    mkdirSync(join(root, 'runtime'), { recursive: true });
    const dbPath = join(root, 'runtime', 'lock-coord.db');

    const child = spawn(process.execPath, ['-e', HOLDER_SCRIPT, betterSqlite3Path, dbPath], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    try {
      await waitForHolderReady(child);

      const ownerPath = join(root, 'runtime', 'broker-owner');
      const start = Date.now();
      const recovered = recoverStaleLockRecordSerialized(ownerPath, () => false, root);
      const elapsed = Date.now() - start;

      expect(recovered).toBe(false);
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(journalModeWal(dbPath)).toBe('wal');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    }
  });

  it('single-process acquire and release unchanged on a fresh root', () => {
    root = mkdtempSync(join(tmpdir(), 'sv18-coord-'));
    mkdirSync(join(root, 'runtime'), { recursive: true });
    const ownerPath = join(root, 'runtime', 'broker-owner');
    const dbPath = join(root, 'runtime', 'lock-coord.db');
    const payload = JSON.stringify({ ownerToken: 'tok-1', pid: process.pid });

    acquireLockRecordSerialized(ownerPath, payload, () => false, root);

    const released = releaseLockRecordSerialized(
      ownerPath,
      'tok-1',
      process.pid,
      (raw) => JSON.parse(raw) as { ownerToken: string; pid: number },
      root,
    );

    expect(released).toBe(true);
    expect(journalModeWal(dbPath)).toBe('wal');
  });
});
