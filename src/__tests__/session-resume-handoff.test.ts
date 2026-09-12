import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(
  args: string[],
  cwd: string,
  syntaurHome: string,
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const env: NodeJS.ProcessEnv = { ...process.env, SYNTAUR_HOME: syntaurHome, HOME: syntaurHome };
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.OPENCODE_SESSION_ID;
    delete env.PI_SESSION_ID;
    Object.assign(env, extraEnv);
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

function seedOpenEngagement(home: string, sessionId: string): void {
  resetSessionDb();
  initSessionDb(resolve(home, 'syntaur.db'));
  try {
    openEngagement({
      sessionId,
      ticketId: 'x',
      projectSlug: 'p',
      ticketSlug: 'demo',
      startedAt: '2026-01-01T00:00:00Z',
    });
  } finally {
    closeSessionDb();
  }
}

describe('syntaur session resume (handoff-only)', () => {
  let syntaurHome: string;
  let workspaceRoot: string;
  let ticketDir: string;
  const SID = 'resume-handoff-1';

  beforeEach(async () => {
    syntaurHome = await mkdtemp(join(tmpdir(), 'syntaur-resume-handoff-'));
    await writeFile(
      resolve(syntaurHome, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(syntaurHome, 'projects')}\nonboarding:\n  completed: true\n---\n`,
    );
    workspaceRoot = await mkdtemp(join(tmpdir(), 'syntaur-resume-handoff-wkspc-'));
    ticketDir = resolve(syntaurHome, 'projects', 'p', 'tickets', 'demo');
    await mkdir(ticketDir, { recursive: true });
    await writeFile(
      resolve(ticketDir, 'ticket.md'),
      '---\nid: x\nslug: demo\ntitle: Demo\nstatus: in_progress\n---\n# Demo\n',
    );
  });

  afterEach(async () => {
    await rm(syntaurHome, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('prints an open handoff when no session summary exists on disk', async () => {
    seedOpenEngagement(syntaurHome, SID);
    const handoffPath = resolve(ticketDir, 'handoff.md');
    await writeFile(
      handoffPath,
      `---\nassignment: demo\nhandoffCount: 1\n---\n\n## Handoff 1: 2026-05-08T12:00:00Z\n\nReal content.\n`,
    );

    const human = await runCli(['session', 'resume'], workspaceRoot, syntaurHome, {
      CLAUDE_CODE_SESSION_ID: SID,
    });
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain('Open handoff');
    expect(human.stdout).toContain(handoffPath);
    expect(human.stdout).not.toContain('session summary');

    const json = await runCli(['session', 'resume', '--json'], workspaceRoot, syntaurHome, {
      CLAUDE_CODE_SESSION_ID: SID,
    });
    expect(json.code, json.stderr).toBe(0);
    const data = JSON.parse(json.stdout);
    expect(data.openHandoff).toBe(handoffPath);
    expect(data).not.toHaveProperty('latestSession');
  });
});
