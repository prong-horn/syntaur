import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const CLI_ENTRY = resolve(__dirname, '..', '..', 'bin', 'syntaur.js');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], syntaurHome: string): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env: { ...process.env, SYNTAUR_HOME: syntaurHome },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) =>
      resolvePromise({ code: code ?? -1, stdout, stderr }),
    );
  });
}

describe('syntaur doctor --fix honesty (U7)', () => {
  let syntaurHome: string;

  beforeEach(async () => {
    syntaurHome = await mkdtemp(join(tmpdir(), 'syntaur-fixnoop-'));
    await mkdir(resolve(syntaurHome, 'projects'), { recursive: true });
    await writeFile(
      resolve(syntaurHome, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(syntaurHome, 'projects')}\nonboarding:\n  completed: true\n---\n`,
    );
  });

  afterEach(async () => {
    await rm(syntaurHome, { recursive: true, force: true });
  });

  it('surfaces the --fix no-op in JSON and on stderr', async () => {
    const r = await runCli(['doctor', '--fix', '--json'], syntaurHome);
    const data = JSON.parse(r.stdout);
    // Explicit no-op marker in the JSON envelope.
    expect(data.fix).toBeDefined();
    expect(data.fix.fixApplied).toBe(false);
    expect(typeof data.fix.note).toBe('string');
    expect(data.fix.note.length).toBeGreaterThan(0);
    // The note is also emitted to stderr so a scripted caller in --json mode
    // never mistakes --fix for a remediation that ran.
    expect(r.stderr).toContain('--fix is reserved');
  });

  it('omits the fix field when --fix is not passed', async () => {
    const r = await runCli(['doctor', '--json'], syntaurHome);
    const data = JSON.parse(r.stdout);
    expect('fix' in data).toBe(false);
    expect(r.stderr).not.toContain('--fix is reserved');
  });
});
