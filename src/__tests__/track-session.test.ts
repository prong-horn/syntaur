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
import { getSessionDb } from '../dashboard/session-db.js';
import { seedMissingBuiltins } from '../ticket-templates/builtins.js';
import { trackSessionCommand } from '../commands/track-session.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const CLI_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'syntaur.js');

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
      { agent: 'claude', sessionId: 'track-id-1', path: testDir, dir: projectsDir, project: 'proj', ticket: 'ASGN-1' },
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
      { agent: 'claude', path: testDir, ticket: 'ASGN-1', dir: projectsDir, project: 'proj' },
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

async function writePairTickets(projectsDir: string): Promise<void> {
  const aDir = resolve(projectsDir, 'proj', 'tickets', 'ASGN-1-asgn');
  const bDir = resolve(projectsDir, 'proj', 'tickets', 'ASGN-2-asgn');
  await mkdir(aDir, { recursive: true });
  await mkdir(bDir, { recursive: true });
  await writeFile(
    resolve(projectsDir, 'proj', 'project.md'),
    `---\nslug: proj\ntitle: proj\ncreated: "2026-01-01"\nupdated: "2026-01-01"\n---\n# proj\n`,
  );
  await writeFile(
    resolve(aDir, 'ticket.md'),
    `---\nid: ASGN-1\nslug: asgn\ntitle: Ticket A\nstatus: review\n---\n# A\n`,
  );
  await writeFile(
    resolve(bDir, 'ticket.md'),
    `---\nid: ASGN-2\nslug: asgn2\ntitle: Ticket B\nstatus: planning\n---\n# B\n`,
  );
}

describe('trackSessionCommand explicit --ticket re-bind', () => {
  beforeEach(() => {
    resetSessionDb();
    initSessionDb(resolve(testDir, 'syntaur.db'));
  });

  it('switches the open engagement when tracking a different ticket', async () => {
    const projectsDir = resolve(testDir, 'projects');
    await writePairTickets(projectsDir);
    const prevHome = process.env.SYNTAUR_HOME;
    process.env.SYNTAUR_HOME = testDir;
    await writeFile(
      resolve(testDir, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\n---\n`,
    );
    try {
      await trackSessionCommand(
        {
          agent: 'claude',
          sessionId: 'rebind-1',
          path: testDir,
          dir: projectsDir,
          project: 'proj',
          ticket: 'ASGN-1',
        },
        { fallbackPid: () => null },
      );
      expect(getOpenEngagement('rebind-1')?.ticket_id).toBe('ASGN-1');

      await trackSessionCommand(
        {
          agent: 'claude',
          sessionId: 'rebind-1',
          path: testDir,
          dir: projectsDir,
          project: 'proj',
          ticket: 'ASGN-2',
        },
        { fallbackPid: () => null },
      );

      const open = getOpenEngagement('rebind-1');
      expect(open?.ticket_id).toBe('ASGN-2');
      expect(open?.stage).toBe('planning');

      const rows = getSessionDb()
        .prepare(
          'SELECT ticket_id, ended_at IS NOT NULL AS closed FROM engagement WHERE session_id = ? ORDER BY started_at',
        )
        .all('rebind-1') as Array<{ ticket_id: string | null; closed: number }>;
      expect(rows).toHaveLength(2);
      expect(rows[0].ticket_id).toBe('ASGN-1');
      expect(rows[0].closed).toBe(1);
      expect(rows[1].ticket_id).toBe('ASGN-2');
      expect(rows[1].closed).toBe(0);
    } finally {
      if (prevHome === undefined) delete process.env.SYNTAUR_HOME;
      else process.env.SYNTAUR_HOME = prevHome;
    }
  });

  it('does not split the engagement when tracking the same ticket again', async () => {
    const projectsDir = resolve(testDir, 'projects');
    await writePairTickets(projectsDir);
    const prevHome = process.env.SYNTAUR_HOME;
    process.env.SYNTAUR_HOME = testDir;
    await writeFile(
      resolve(testDir, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\n---\n`,
    );
    try {
      const opts = {
        agent: 'claude',
        sessionId: 'rebind-2',
        path: testDir,
        dir: projectsDir,
        project: 'proj',
        ticket: 'ASGN-1',
      };
      await trackSessionCommand(opts, { fallbackPid: () => null });
      const firstOpenId = getOpenEngagement('rebind-2')!.id;
      await trackSessionCommand(opts, { fallbackPid: () => null });
      expect(getOpenEngagement('rebind-2')!.id).toBe(firstOpenId);
      const count = getSessionDb()
        .prepare('SELECT COUNT(*) AS n FROM engagement WHERE session_id = ?')
        .get('rebind-2') as { n: number };
      expect(count.n).toBe(1);
    } finally {
      if (prevHome === undefined) delete process.env.SYNTAUR_HOME;
      else process.env.SYNTAUR_HOME = prevHome;
    }
  });

  it('session context prints the re-bound ticket', async () => {
    const projectsDir = resolve(testDir, 'projects');
    await writePairTickets(projectsDir);
    const prevHome = process.env.SYNTAUR_HOME;
    process.env.SYNTAUR_HOME = testDir;
    await writeFile(
      resolve(testDir, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\n---\n`,
    );
    await seedMissingBuiltins(testDir);
    try {
      await trackSessionCommand(
        {
          agent: 'claude',
          sessionId: 'rebind-3',
          path: testDir,
          dir: projectsDir,
          project: 'proj',
          ticket: 'ASGN-1',
        },
        { fallbackPid: () => null },
      );
      await trackSessionCommand(
        {
          agent: 'claude',
          sessionId: 'rebind-3',
          path: testDir,
          dir: projectsDir,
          project: 'proj',
          ticket: 'ASGN-2',
        },
        { fallbackPid: () => null },
      );

      const stdout = await new Promise<string>((resolvePromise, reject) => {
        const child = spawn(
          process.execPath,
          [CLI_ENTRY, 'session', 'context', '--session-id', 'rebind-3', '--cwd', testDir],
          { env: { ...process.env, SYNTAUR_HOME: testDir, HOME: testDir } },
        );
        let out = '';
        child.stdout.on('data', (d) => (out += d.toString()));
        child.on('close', (code) => {
          if (code === 0) resolvePromise(out);
          else reject(new Error(`exit ${code}`));
        });
      });
      expect(stdout).toContain('Ticket: ASGN-2');
    } finally {
      if (prevHome === undefined) delete process.env.SYNTAUR_HOME;
      else process.env.SYNTAUR_HOME = prevHome;
    }
  });
});
