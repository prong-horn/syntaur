import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
} from '../dashboard/session-db.js';
import { getSessionById } from '../dashboard/agent-sessions.js';
import { trackSessionCommand } from '../commands/track-session.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-track-test-'));
  resetSessionDb();
  initSessionDb(resolve(testDir, 'test.db'));
});

afterEach(async () => {
  closeSessionDb();
  await rm(testDir, { recursive: true, force: true });
});

describe('trackSessionCommand session-id self-resolution', () => {
  it('uses the explicit --session-id when provided', async () => {
    await trackSessionCommand(
      { agent: 'claude', sessionId: 'explicit-id-1', path: testDir },
      { resolveSessionId: async () => 'should-not-be-used', fallbackPid: () => null },
    );
    expect(getSessionById('explicit-id-1')).not.toBeNull();
  });

  it('self-resolves the calling session id when --session-id is omitted', async () => {
    await trackSessionCommand(
      { agent: 'claude', path: testDir },
      { resolveSessionId: async () => 'resolved-from-process', fallbackPid: () => null },
    );
    const row = getSessionById('resolved-from-process');
    expect(row).not.toBeNull();
    expect(row!.agent).toBe('claude');
    expect(row!.status).toBe('active');
  });

  it('throws a descriptive error when no id can be resolved', async () => {
    await expect(
      trackSessionCommand(
        { agent: 'claude', path: testDir },
        { resolveSessionId: async () => undefined, fallbackPid: () => null },
      ),
    ).rejects.toThrow(/Could not resolve a session id/);
  });

  it('defaults the owning pid via the fallback when --pid is omitted', async () => {
    await trackSessionCommand(
      { agent: 'claude', sessionId: 'pid-default-1', path: testDir },
      { fallbackPid: () => 31337 },
    );
    expect(getSessionById('pid-default-1')!.pid).toBe(31337);
  });

  it('prefers an explicit --pid over the fallback', async () => {
    await trackSessionCommand(
      { agent: 'claude', sessionId: 'pid-explicit-1', path: testDir, pid: 100 },
      { fallbackPid: () => 31337 },
    );
    expect(getSessionById('pid-explicit-1')!.pid).toBe(100);
  });
});
