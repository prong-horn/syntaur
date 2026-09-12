import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
} from '../dashboard/session-db.js';
import { getSessionById } from '../dashboard/agent-sessions.js';
import { getOpenEngagement } from '../db/engagement-db.js';
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
      { resolveSessionId: async () => ({ id: 'should-not-be-used', provenance: 'STRONG' as const }), fallbackPid: () => null },
    );
    expect(getSessionById('explicit-id-1')).not.toBeNull();
  });

  it('self-resolves the calling session id when --session-id is omitted', async () => {
    await trackSessionCommand(
      { agent: 'claude', path: testDir },
      { resolveSessionId: async () => ({ id: 'resolved-from-process', provenance: 'STRONG' as const }), fallbackPid: () => null },
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


  it('resolves and stores ticket_id on the opened engagement (M1)', async () => {
    // A project ticket with a frontmatter id under the projects dir.
    const projectsDir = resolve(testDir, 'projects');
    const asgnDir = resolve(projectsDir, 'proj', 'tickets', 'ASGN-1-asgn');
    await mkdir(asgnDir, { recursive: true });
    await writeFile(
      resolve(projectsDir, 'proj', 'project.md'),
      `---\nslug: proj\ntitle: proj\ncreated: "2026-01-01"\nupdated: "2026-01-01"\n---\n# proj\n`,
    );
    await writeFile(
      resolve(asgnDir, 'ticket.md'),
      `---\nid: ASGN-1\nslug: asgn\ntitle: asgn\nstatus: in_progress\n---\n# asgn\n`,
    );

    await trackSessionCommand(
      { agent: 'claude', sessionId: 'track-id-1', path: testDir, dir: projectsDir, project: 'proj', ticket: 'asgn' },
      { fallbackPid: () => null },
    );

    const open = getOpenEngagement('track-id-1');
    expect(open).not.toBeNull();
    expect(open!.ticket_id).toBe('ASGN-1');
  });

  it('rejects a WEAK session id with no --ticket (gate)', async () => {
    await expect(
      trackSessionCommand(
        { agent: 'claude', path: testDir },
        { resolveSessionId: async () => ({ id: 'weak-id', provenance: 'WEAK' as const }), fallbackPid: () => null },
      ),
    ).rejects.toThrow(/--ticket/);
  });

  it('accepts a WEAK session id when --ticket is provided', async () => {
    await trackSessionCommand(
      { agent: 'claude', path: testDir, ticket: 'my-ticket' },
      { resolveSessionId: async () => ({ id: 'weak-id-2', provenance: 'WEAK' as const }), fallbackPid: () => null },
    );
    expect(getSessionById('weak-id-2')).not.toBeNull();
  });

  it('accepts an EXPLICIT --session-id with no --ticket', async () => {
    await trackSessionCommand(
      { agent: 'claude', sessionId: 'explicit-id-2', path: testDir },
      { fallbackPid: () => null },
    );
    expect(getSessionById('explicit-id-2')).not.toBeNull();
  });

  it('rejects an explicit but empty --session-id instead of falling through to resolution', async () => {
    // The mock would resolve a valid STRONG id if '' wrongly fell through, so a
    // non-throw here would prove the empty explicit value was silently ignored.
    await expect(
      trackSessionCommand(
        { agent: 'claude', sessionId: '', path: testDir },
        { resolveSessionId: async () => ({ id: 'should-not-reach', provenance: 'STRONG' as const }), fallbackPid: () => null },
      ),
    ).rejects.toThrow(/do not synthesize/);
    expect(getSessionById('should-not-reach')).toBeNull();
  });
});
