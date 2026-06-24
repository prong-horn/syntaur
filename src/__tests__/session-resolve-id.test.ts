import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const CLI_ENTRY = resolve(__dirname, '..', '..', 'bin', 'syntaur.js');

interface RunResult { code: number; stdout: string; stderr: string }

async function runCli(
  args: string[],
  home: string,
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  return new Promise((res) => {
    const env: NodeJS.ProcessEnv = { ...process.env, SYNTAUR_HOME: home, HOME: home };
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.OPENCODE_SESSION_ID;
    delete env.PI_SESSION_ID;
    Object.assign(env, extraEnv);
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env,
      cwd: home,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.stdin.end();
    child.on('close', (code) => res({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

describe('syntaur session resolve-id', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-resolve-id-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('prints the bare session id (not [object Object]) when resolved via env', async () => {
    const r = await runCli(['session', 'resolve-id'], home, { CLAUDE_CODE_SESSION_ID: 'abc' });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe('abc');
  });

  it('exits 1 when no session id can be resolved', async () => {
    const r = await runCli(['session', 'resolve-id'], home);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
  });
});
