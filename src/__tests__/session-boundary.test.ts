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
 * session-id resolver's ancestor-pid + transcript-scan layers see an empty home,
 * and scrub inherited *_SESSION_ID env so the test process's own id can't leak.
 * Tests opt into a session id via CLAUDE_CODE_SESSION_ID in `extraEnv`.
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

/** Seed an OPEN engagement for `sessionId` bound to project `p` / assignment `demo`. */
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

/** Seed an OPEN engagement for a STANDALONE assignment (no project slug). */
function seedStandaloneEngagement(home: string, sessionId: string, assignmentId: string): void {
  resetSessionDb();
  initSessionDb(resolve(home, 'syntaur.db'));
  try {
    openEngagement({
      sessionId,
      assignmentId,
      projectSlug: null,
      assignmentSlug: null,
      startedAt: '2026-01-01T00:00:00Z',
    });
  } finally {
    closeSessionDb();
  }
}

describe('syntaur session boundary', () => {
  let syntaurHome: string;
  let workspaceRoot: string;
  let assignmentDir: string;
  const SID = 'boundary-session-1';

  beforeEach(async () => {
    syntaurHome = await mkdtemp(join(tmpdir(), 'syntaur-boundary-'));
    await writeFile(
      resolve(syntaurHome, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(syntaurHome, 'projects')}\nonboarding:\n  completed: true\n---\n`,
    );
    workspaceRoot = await mkdtemp(join(tmpdir(), 'syntaur-boundary-wkspc-'));
    assignmentDir = resolve(syntaurHome, 'projects', 'p', 'assignments', 'demo');
    await mkdir(assignmentDir, { recursive: true });
    await writeFile(
      resolve(assignmentDir, 'assignment.md'),
      '---\nid: x\nslug: demo\ntitle: Demo\nstatus: in_progress\n---\n# Demo\n',
    );
  });

  afterEach(async () => {
    await rm(syntaurHome, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('resolves assignmentDir + projectDir from the open engagement (+ workspace marker)', async () => {
    seedOpenEngagement(syntaurHome, SID);
    await mkdir(resolve(workspaceRoot, '.syntaur'), { recursive: true });
    await writeFile(
      resolve(workspaceRoot, '.syntaur', 'context.json'),
      JSON.stringify({ workspaceRoot, branch: 'feat/demo' }),
    );
    const result = await runCli(['session', 'boundary', '--json'], workspaceRoot, syntaurHome, {
      CLAUDE_CODE_SESSION_ID: SID,
    });
    expect(result.code, result.stderr).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.assignmentDir).toBe(assignmentDir);
    // projectDir = parent of `assignments/demo` → the project root.
    expect(data.projectDir).toBe(resolve(syntaurHome, 'projects', 'p'));
    expect(data.workspaceRoot).toBe(workspaceRoot);
  });

  it('honors an EXPLICIT --session-id over self-resolution', async () => {
    seedOpenEngagement(syntaurHome, 'explicit-sid');
    const result = await runCli(
      ['session', 'boundary', '--json', '--session-id', 'explicit-sid'],
      workspaceRoot,
      syntaurHome,
      // Deliberately inject a DIFFERENT env id; --session-id must win.
      { CLAUDE_CODE_SESSION_ID: 'some-other-id' },
    );
    expect(result.code, result.stderr).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.assignmentDir).toBe(assignmentDir);
    expect(data.projectDir).toBe(resolve(syntaurHome, 'projects', 'p'));
  });

  it('returns null assignment/project (with workspaceRoot) when the session has NO open engagement', async () => {
    // No engagement seeded. The CLI must still exit 0 and emit a parseable object.
    await mkdir(resolve(workspaceRoot, '.syntaur'), { recursive: true });
    await writeFile(
      resolve(workspaceRoot, '.syntaur', 'context.json'),
      JSON.stringify({ workspaceRoot }),
    );
    const result = await runCli(['session', 'boundary', '--json'], workspaceRoot, syntaurHome, {
      CLAUDE_CODE_SESSION_ID: SID,
    });
    expect(result.code, result.stderr).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.assignmentDir).toBeNull();
    expect(data.projectDir).toBeNull();
    // The workspace marker is still surfaced so the hook enforces workspace-only.
    expect(data.workspaceRoot).toBe(workspaceRoot);
  });

  it('emits an all-null object (never throws) when the session id cannot be resolved', async () => {
    // No env id, empty sandbox home → no session id resolves at all.
    const result = await runCli(['session', 'boundary', '--json'], workspaceRoot, syntaurHome);
    expect(result.code, result.stderr).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.assignmentDir).toBeNull();
    expect(data.projectDir).toBeNull();
    // No context.json → no workspace marker either.
    expect(data.workspaceRoot).toBeNull();
  });

  it('returns null projectDir for a STANDALONE engagement (no project nesting)', async () => {
    const standaloneId = '22222222-2222-2222-2222-222222222222';
    const standaloneDir = resolve(syntaurHome, 'assignments', standaloneId);
    await mkdir(standaloneDir, { recursive: true });
    await writeFile(
      resolve(standaloneDir, 'assignment.md'),
      `---\nid: ${standaloneId}\ntitle: Solo\nstatus: in_progress\n---\n# Solo\n`,
    );
    seedStandaloneEngagement(syntaurHome, SID, standaloneId);
    const result = await runCli(['session', 'boundary', '--json'], workspaceRoot, syntaurHome, {
      CLAUDE_CODE_SESSION_ID: SID,
    });
    expect(result.code, result.stderr).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.assignmentDir).toBe(standaloneDir);
    expect(data.projectDir).toBeNull(); // standalone → no project resources dir
  });
});
