import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
} from '../dashboard/session-db.js';
import { openEngagement } from '../db/engagement-db.js';

const CLI_ENTRY = resolve(__dirname, '..', '..', 'bin', 'syntaur.js');

interface RunResult { code: number; stdout: string; stderr: string }

async function runCli(
  args: string[],
  home: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
  return new Promise((res) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env: { ...process.env, SYNTAUR_HOME: home, ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => res({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Seed an OPEN engagement in `$SYNTAUR_HOME/syntaur.db` bound to project `p` /
 * ticket `a`, so a spawned CLI process whose session resolves to `sessionId`
 * (STRONG via injected CLAUDE_CODE_SESSION_ID) targets that ticket with no
 * explicit --ticket flag. Mirrors the production session-db path.
 */
function seedOpenEngagement(home: string, sessionId: string): void {
  resetSessionDb();
  initSessionDb(resolve(home, 'syntaur.db'));
  try {
    openEngagement({
      sessionId,
      ticketId: 'PX-1',
      projectSlug: 'p',
      ticketSlug: 'a',
      startedAt: '2026-01-01T00:00:00Z',
    });
  } finally {
    closeSessionDb();
  }
}

const PROGRESS = `---
ticket: a
entryCount: 0
generated: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
---

# Progress

No progress yet.
`;

describe('syntaur progress log', () => {
  let home: string;
  let progressPath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-prog-'));
    await writeFile(
      join(home, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(home, 'projects')}\n---\n`,
    );
    const dir = resolve(home, 'projects', 'p', 'tickets', 'PX-1-a');
    await mkdir(dir, { recursive: true });
    await mkdir(resolve(home, 'projects', 'p'), { recursive: true });
    await writeFile(
      resolve(home, 'projects', 'p', 'project.md'),
      '---\nslug: p\ntitle: P\nprefix: PX\nnextTicket: 2\n---\n',
    );
    await writeFile(resolve(dir, 'ticket.md'), '---\nid: PX-1\nslug: a\nstatus: in_progress\n---\n# A\n', 'utf-8');
    progressPath = resolve(dir, 'progress.md');
    await writeFile(progressPath, PROGRESS, 'utf-8');
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('replaces the placeholder, increments entryCount, preserves ticket/generated', async () => {
    const r = await runCli(['progress', 'log', 'First entry', '--ticket', 'PX-1', '--project', 'p'], home);
    expect(r.code, r.stderr).toBe(0);
    const content = await readFile(progressPath, 'utf-8');
    expect(content).not.toContain('No progress yet.');
    expect(content).toContain('First entry');
    expect(content).toContain('entryCount: 1');
    expect(content).toContain('ticket: a'); // preserved
    expect(content).toContain('generated: "2026-01-01T00:00:00Z"'); // preserved
    expect(content).not.toContain('updated: "2026-01-01T00:00:00Z"'); // bumped
  });

  it('keeps entries reverse-chronological (newest right after the H1)', async () => {
    await runCli(['progress', 'log', 'OLDER', '--ticket', 'PX-1', '--project', 'p'], home);
    await runCli(['progress', 'log', 'NEWER', '--ticket', 'PX-1', '--project', 'p'], home);
    const content = await readFile(progressPath, 'utf-8');
    expect(content).toContain('entryCount: 2');
    const h1 = content.indexOf('# Progress');
    expect(content.indexOf('NEWER')).toBeGreaterThan(h1);
    expect(content.indexOf('NEWER')).toBeLessThan(content.indexOf('OLDER'));
  });

  it('resolves the ticket from the session OPEN engagement when no --ticket is given', async () => {
    const sessionId = 'sess-engagement-1';
    seedOpenEngagement(home, sessionId);
    const r = await runCli(['progress', 'log', 'From engagement'], home, {
      CLAUDE_CODE_SESSION_ID: sessionId, // STRONG provenance → passes the mutation gate
    });
    expect(r.code, r.stderr).toBe(0);
    const content = await readFile(progressPath, 'utf-8');
    expect(content).toContain('From engagement');
    expect(content).toContain('entryCount: 1');
  });

  it('errors with no explicit target and no open engagement', async () => {
    const r = await runCli(['progress', 'log', 'orphan'], home, {
      CLAUDE_CODE_SESSION_ID: 'sess-no-engagement', // STRONG, but no engagement open
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('No open engagement');
  });
});
