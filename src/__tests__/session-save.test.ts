import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const CLI_ENTRY = resolve(__dirname, '..', '..', 'bin', 'syntaur.js');

interface RunResult { code: number; stdout: string; stderr: string }

async function runCli(
  args: string[],
  home: string,
  stdin?: string,
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  return new Promise((res) => {
    // Hermetic env: pin HOME + SYNTAUR_HOME to the sandbox so the session-id
    // resolver's ancestor-pid (`~/.claude/sessions`) and transcript-scan layers
    // see an empty home, and scrub any inherited *_SESSION_ID env so the test
    // process's own real session id can't leak into layer 2. Tests opt into
    // env vars explicitly via `extraEnv`.
    const env: NodeJS.ProcessEnv = { ...process.env, SYNTAUR_HOME: home, HOME: home };
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.OPENCODE_SESSION_ID;
    delete env.PI_SESSION_ID;
    Object.assign(env, extraEnv);
    // cwd = home so the command never picks up the repo's own .syntaur/context.json.
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env,
      cwd: home,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
    child.on('close', (code) => res({ code: code ?? -1, stdout, stderr }));
  });
}

describe('syntaur session save', () => {
  let home: string;
  let assignmentDir: string;
  let summaryPath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-sess-'));
    assignmentDir = resolve(home, 'projects', 'p', 'assignments', 'a');
    await mkdir(assignmentDir, { recursive: true });
    await writeFile(
      resolve(assignmentDir, 'assignment.md'),
      '---\nid: x\nslug: a\nstatus: in_progress\n---\n# A\n',
      'utf-8',
    );
    summaryPath = resolve(assignmentDir, 'sessions', 'sess-1', 'summary.md');
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('writes summary.md under sessions/<id>/ with frontmatter', async () => {
    const r = await runCli(
      ['session', 'save', '--session-id', 'sess-1', '--assignment', 'a', '--project', 'p'],
      home,
      '## Snapshot\n\nWorked on it.\n',
    );
    expect(r.code, r.stderr).toBe(0);
    const content = await readFile(summaryPath, 'utf-8');
    expect(content).toContain('sessionId: sess-1');
    expect(content).toContain('assignment: a');
    expect(content).toContain('Worked on it.');
  });

  it('preserves the original created timestamp on re-save', async () => {
    await runCli(['session', 'save', '--session-id', 'sess-1', '--assignment', 'a', '--project', 'p'], home, 'first');
    const first = await readFile(summaryPath, 'utf-8');
    const created = first.match(/^created:\s*"([^"]+)"/m)?.[1];
    expect(created).toBeTruthy();
    // Re-save with new body; created must be unchanged.
    await new Promise((r) => setTimeout(r, 1100));
    await runCli(['session', 'save', '--session-id', 'sess-1', '--assignment', 'a', '--project', 'p'], home, 'second');
    const second = await readFile(summaryPath, 'utf-8');
    expect(second.match(/^created:\s*"([^"]+)"/m)?.[1]).toBe(created);
    expect(second).toContain('second');
  });

  it('writes the skeleton when no body is provided', async () => {
    const r = await runCli(
      ['session', 'save', '--session-id', 'sess-1', '--assignment', 'a', '--project', 'p'],
      home,
      '',
    );
    expect(r.code, r.stderr).toBe(0);
    const content = await readFile(summaryPath, 'utf-8');
    expect(content).toContain('## Snapshot');
    expect(content).toContain('## What Was Done');
  });

  it('does not create or touch handoff.md', async () => {
    await runCli(['session', 'save', '--session-id', 'sess-1', '--assignment', 'a', '--project', 'p'], home, 'x');
    const { fileExists } = await import('../utils/fs.js');
    expect(await fileExists(resolve(assignmentDir, 'handoff.md'))).toBe(false);
  });

  it('aborts when no session id can be resolved', async () => {
    // No --session-id and no context.json sessionId.
    const r = await runCli(['session', 'save', '--assignment', 'a', '--project', 'p'], home, 'x');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('session');
  });

  it('resolves the caller\'s OWN id from env, not a clobbered context.json scalar (the reported bug)', async () => {
    // Co-tenant scenario: agent B started in the same workspace and clobbered
    // the shared scalar to 'B'. Agent A (this process, env=A) returns and saves.
    // A's summary must land under A, never the clobbered B.
    await mkdir(resolve(home, '.syntaur'), { recursive: true });
    await writeFile(
      resolve(home, '.syntaur', 'context.json'),
      JSON.stringify({ assignmentDir, assignmentSlug: 'a', projectSlug: 'p', sessionId: 'B' }),
      'utf-8',
    );
    const r = await runCli(['session', 'save'], home, 'Agent A summary.', { CLAUDE_CODE_SESSION_ID: 'A' });
    expect(r.code, r.stderr).toBe(0);
    const aSummary = await readFile(resolve(assignmentDir, 'sessions', 'A', 'summary.md'), 'utf-8');
    expect(aSummary).toContain('sessionId: A');
    expect(aSummary).toContain('Agent A summary.');
    const { fileExists } = await import('../utils/fs.js');
    expect(await fileExists(resolve(assignmentDir, 'sessions', 'B', 'summary.md'))).toBe(false);
  });

  it('falls back to the context.json sessionId hint when no env/process id is available', async () => {
    // Back-compat: no *_SESSION_ID env, hermetic HOME (no markers/transcripts) —
    // the legacy scalar is the last-resort hint and still resolves.
    await mkdir(resolve(home, '.syntaur'), { recursive: true });
    await writeFile(
      resolve(home, '.syntaur', 'context.json'),
      JSON.stringify({ assignmentDir, assignmentSlug: 'a', projectSlug: 'p', sessionId: 'C' }),
      'utf-8',
    );
    const r = await runCli(['session', 'save'], home, 'legacy body');
    expect(r.code, r.stderr).toBe(0);
    const cSummary = await readFile(resolve(assignmentDir, 'sessions', 'C', 'summary.md'), 'utf-8');
    expect(cSummary).toContain('sessionId: C');
  });
});
