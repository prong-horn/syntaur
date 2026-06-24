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

/**
 * Run the CLI hermetically: pin HOME + SYNTAUR_HOME to the sandbox so the
 * session-id resolver's ancestor-pid (`~/.claude/sessions`) and transcript-scan
 * layers see an empty home, and scrub any inherited *_SESSION_ID env so the
 * test process's own real session id can't leak into layer 2. Tests opt into
 * env vars (e.g. CLAUDE_CODE_SESSION_ID) explicitly via `extraEnv`.
 */
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

/**
 * Seed an OPEN engagement in `$SYNTAUR_HOME/syntaur.db` bound to project `p` /
 * assignment `demo`, so a spawned `session resume` whose session resolves to
 * `sessionId` (STRONG via injected CLAUDE_CODE_SESSION_ID) resolves that
 * assignment. The demoted context.json assignment scalars are no longer a
 * resolution source — the open engagement is.
 */
function seedOpenEngagement(home: string, sessionId: string): void {
  resetSessionDb();
  initSessionDb(resolve(home, 'syntaur.db'));
  try {
    openEngagement({
      sessionId,
      assignmentId: 'x',
      projectSlug: 'p',
      assignmentSlug: 'demo',
      startedAt: '2026-01-01T00:00:00Z',
    });
  } finally {
    closeSessionDb();
  }
}

describe('syntaur session resume', () => {
  let syntaurHome: string;
  let workspaceRoot: string;
  let assignmentDir: string;
  const SID = 'resume-session-1';

  beforeEach(async () => {
    syntaurHome = await mkdtemp(join(tmpdir(), 'syntaur-resume-'));
    await writeFile(
      resolve(syntaurHome, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(syntaurHome, 'projects')}\nonboarding:\n  completed: true\n---\n`,
    );
    workspaceRoot = await mkdtemp(join(tmpdir(), 'syntaur-resume-wkspc-'));
    assignmentDir = resolve(syntaurHome, 'projects', 'p', 'assignments', 'demo');
    await mkdir(assignmentDir, { recursive: true });
    // The engagement resolver requires assignment.md to exist at the
    // reconstructed dir, so scaffold a minimal one.
    await writeFile(
      resolve(assignmentDir, 'assignment.md'),
      '---\nid: x\nslug: demo\ntitle: Demo\nstatus: in_progress\n---\n# Demo\n',
    );
  });

  afterEach(async () => {
    await rm(syntaurHome, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('aborts with exit 1 when the session has no open engagement', async () => {
    // No engagement seeded → no active assignment to resume.
    const result = await runCli(['session', 'resume'], workspaceRoot, syntaurHome, {
      CLAUDE_CODE_SESSION_ID: SID,
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Cannot resume');
    expect(result.stdout).toContain('No active assignment');
    expect(result.stdout).toContain('grab-assignment');
  });

  it('emits human-readable orientation resolved from the open engagement (+ context markers)', async () => {
    seedOpenEngagement(syntaurHome, SID);
    // context.json now carries only workspace markers (branch). The assignment
    // comes from the open engagement, not these scalars.
    await mkdir(resolve(workspaceRoot, '.syntaur'), { recursive: true });
    await writeFile(
      resolve(workspaceRoot, '.syntaur', 'context.json'),
      JSON.stringify({ branch: 'feat/demo' }),
    );
    const summarySid = '11111111-1111-1111-1111-111111111111';
    await mkdir(resolve(assignmentDir, 'sessions', summarySid), { recursive: true });
    await writeFile(
      resolve(assignmentDir, 'sessions', summarySid, 'summary.md'),
      `---\nassignment: demo\nsessionId: ${summarySid}\n---\n\n## Snapshot\n\nDoing the thing.\n`,
    );
    const result = await runCli(['session', 'resume'], workspaceRoot, syntaurHome, {
      CLAUDE_CODE_SESSION_ID: SID,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Resuming Syntaur session');
    expect(result.stdout).toContain('demo'); // assignment slug from engagement
    expect(result.stdout).toContain('Demo'); // title from assignment.md frontmatter
    expect(result.stdout).toContain('feat/demo'); // branch marker from context.json
    expect(result.stdout).toContain('Latest session summary');
    expect(result.stdout).toContain(summarySid);
  });

  it('resolves the assignment from the engagement even with NO context.json', async () => {
    seedOpenEngagement(syntaurHome, SID);
    const result = await runCli(['session', 'resume', '--json'], workspaceRoot, syntaurHome, {
      CLAUDE_CODE_SESSION_ID: SID,
    });
    expect(result.code, result.stderr).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.ok).toBe(true);
    expect(data.assignment.assignmentSlug).toBe('demo');
    expect(data.assignment.projectSlug).toBe('p');
    expect(data.assignment.assignmentDir).toBe(assignmentDir);
  });

  it('reports the canonical root handoff.md when its body is written', async () => {
    seedOpenEngagement(syntaurHome, SID);
    await writeFile(
      resolve(assignmentDir, 'handoff.md'),
      `---\nassignment: demo\nhandoffCount: 1\n---\n\n## Handoff 1: 2026-05-08T12:00:00Z\n\nReal content.\n`,
    );
    const result = await runCli(['session', 'resume', '--json'], workspaceRoot, syntaurHome, {
      CLAUDE_CODE_SESSION_ID: SID,
    });
    expect(result.code, result.stderr).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.openHandoff).toBe(resolve(assignmentDir, 'handoff.md'));
  });

  it('ignores a placeholder-only handoff.md', async () => {
    seedOpenEngagement(syntaurHome, SID);
    await writeFile(
      resolve(assignmentDir, 'handoff.md'),
      `---\nassignment: demo\nhandoffCount: 0\n---\n\n<!-- Placeholder for cross-ticket handoff. -->`,
    );
    const result = await runCli(['session', 'resume', '--json'], workspaceRoot, syntaurHome, {
      CLAUDE_CODE_SESSION_ID: SID,
    });
    expect(result.code, result.stderr).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.openHandoff).toBeNull();
  });

  it('is idempotent — running twice produces the same output and does not mutate state', async () => {
    seedOpenEngagement(syntaurHome, SID);
    const r1 = await runCli(['session', 'resume', '--json'], workspaceRoot, syntaurHome, {
      CLAUDE_CODE_SESSION_ID: SID,
    });
    const r2 = await runCli(['session', 'resume', '--json'], workspaceRoot, syntaurHome, {
      CLAUDE_CODE_SESSION_ID: SID,
    });
    expect(r1.code).toBe(0);
    expect(r2.code).toBe(0);
    expect(r1.stdout).toBe(r2.stdout);
  });
});
