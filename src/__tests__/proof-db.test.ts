import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  initProofDb,
  getProofDb,
  closeProofDb,
  resetProofDb,
  insertArtifact,
  listArtifactsByAssignment,
  getArtifactById,
} from '../db/proof-db.js';
import { initSessionDb, closeSessionDb, resetSessionDb } from '../dashboard/session-db.js';

let testDir: string;
let dbPath: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-proof-db-test-'));
  dbPath = resolve(testDir, 'syntaur.db');
  resetProofDb();
  resetSessionDb();
});

afterEach(async () => {
  closeProofDb();
  closeSessionDb();
  await rm(testDir, { recursive: true, force: true });
});

describe('initProofDb', () => {
  it('creates the artifacts table and seeds proof_schema_version', () => {
    const db = initProofDb(dbPath);
    const schema = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
    const names = schema.map((s) => s.name);
    expect(names).toContain('artifacts');
    expect(names).toContain('meta');

    const version = db.prepare("SELECT value FROM meta WHERE key = 'proof_schema_version'").get() as { value: string } | undefined;
    expect(version?.value).toBe('1');
  });

  it('returns the same singleton on repeat calls', () => {
    const a = initProofDb(dbPath);
    const b = initProofDb(dbPath);
    expect(a).toBe(b);
  });

  it('uses WAL journal mode', () => {
    const db = initProofDb(dbPath);
    const mode = db.pragma('journal_mode', { simple: true });
    expect(mode).toBe('wal');
  });
});

describe('getProofDb', () => {
  it('throws before init', () => {
    expect(() => getProofDb()).toThrow(/not initialized/);
  });

  it('returns the handle after init', () => {
    initProofDb(dbPath);
    expect(getProofDb()).toBeDefined();
  });
});

describe('insertArtifact + listArtifactsByAssignment', () => {
  beforeEach(() => {
    initProofDb(dbPath);
  });

  it('round-trips a tagged artifact', () => {
    insertArtifact({
      id: 'art-1',
      assignmentId: 'asn-1',
      assignmentDir: '/some/dir',
      criterionIndex: 0,
      kind: 'screenshot',
      filePath: 'proof/0/art-1.png',
      note: null,
    });

    const rows = listArtifactsByAssignment('asn-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('art-1');
    expect(rows[0].criterion_index).toBe(0);
    expect(rows[0].kind).toBe('screenshot');
    expect(rows[0].file_path).toBe('proof/0/art-1.png');
    expect(rows[0].note).toBeNull();
    expect(rows[0].created_at).toBeTruthy();
  });

  it('round-trips an untagged text artifact', () => {
    insertArtifact({
      id: 'art-2',
      assignmentId: 'asn-1',
      assignmentDir: '/some/dir',
      criterionIndex: null,
      kind: 'text',
      filePath: null,
      note: 'just a note',
    });

    const rows = listArtifactsByAssignment('asn-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].criterion_index).toBeNull();
    expect(rows[0].note).toBe('just a note');
  });

  it('orders by criterion (tagged ascending, untagged last) then created_at', async () => {
    insertArtifact({ id: 'a', assignmentId: 'x', assignmentDir: '/d', criterionIndex: null, kind: 'text', filePath: null, note: 'untagged' });
    // Force a small wait so created_at ordering is deterministic
    await new Promise((r) => setTimeout(r, 1100));
    insertArtifact({ id: 'b', assignmentId: 'x', assignmentDir: '/d', criterionIndex: 2, kind: 'text', filePath: null, note: 'crit-2' });
    insertArtifact({ id: 'c', assignmentId: 'x', assignmentDir: '/d', criterionIndex: 0, kind: 'text', filePath: null, note: 'crit-0' });

    const rows = listArtifactsByAssignment('x');
    expect(rows.map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });

  it('isolates artifacts by assignment_id', () => {
    insertArtifact({ id: 'a', assignmentId: 'x', assignmentDir: '/d', criterionIndex: 0, kind: 'text', filePath: null, note: 'x' });
    insertArtifact({ id: 'b', assignmentId: 'y', assignmentDir: '/d', criterionIndex: 0, kind: 'text', filePath: null, note: 'y' });

    expect(listArtifactsByAssignment('x')).toHaveLength(1);
    expect(listArtifactsByAssignment('y')).toHaveLength(1);
  });

  it('rejects duplicate primary key', () => {
    insertArtifact({ id: 'dup', assignmentId: 'x', assignmentDir: '/d', criterionIndex: 0, kind: 'text', filePath: null, note: 'first' });
    expect(() =>
      insertArtifact({ id: 'dup', assignmentId: 'x', assignmentDir: '/d', criterionIndex: 0, kind: 'text', filePath: null, note: 'second' }),
    ).toThrow();
  });
});

describe('getArtifactById', () => {
  beforeEach(() => initProofDb(dbPath));

  it('returns the row for an existing id', () => {
    insertArtifact({ id: 'lookup', assignmentId: 'x', assignmentDir: '/d', criterionIndex: null, kind: 'text', filePath: null, note: 'hi' });
    expect(getArtifactById('lookup')?.id).toBe('lookup');
  });

  it('returns null for missing id', () => {
    expect(getArtifactById('nope')).toBeNull();
  });
});

describe('shared syntaur.db with session-db', () => {
  it('proof and session schemas coexist on the same file with distinct meta keys', async () => {
    initProofDb(dbPath);
    initSessionDb(dbPath);

    insertArtifact({ id: 'art', assignmentId: 'asn', assignmentDir: '/d', criterionIndex: 0, kind: 'text', filePath: null, note: 'hi' });

    const sessionDb = (await import('../dashboard/session-db.js')).getSessionDb();
    const sessionVer = sessionDb.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    const proofVer = sessionDb.prepare("SELECT value FROM meta WHERE key = 'proof_schema_version'").get() as { value: string } | undefined;

    expect(sessionVer?.value).toBeTruthy();
    expect(proofVer?.value).toBe('1');
    expect(listArtifactsByAssignment('asn')).toHaveLength(1);
  });
});
