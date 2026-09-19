import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const hookPath = resolve(here, '../../hooks/session-start.sh');
const libPath = resolve(here, '../../hooks/lib.sh');

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-hook-start-'));
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

function runHook(stdinJson: string, env: Record<string, string> = {}) {
  return spawnSync('bash', [hookPath], {
    input: stdinJson,
    encoding: 'utf-8',
    // Point HOME at an isolated sandbox so hook tests do not read the real home.
    env: {
      ...process.env,
      HOME: sandbox,
      ...env,
    },
  });
}

/**
 * A fake `syntaur` that records its argv and stdin under $SYNTAUR_TEST_RECORD
 * and prints a version (so the drift check also works against it).
 */
async function makeRecordingSyntaur(recordDir: string, version = '0.0.1'): Promise<string> {
  const binDir = await mkdtemp(join(tmpdir(), 'syntaur-fakebin-'));
  const p = join(binDir, 'syntaur');
  await writeFile(
    p,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${recordDir}/argv"\ncat >> "${recordDir}/stdin"\necho "${version}"\n`,
  );
  await chmod(p, 0o755);
  return binDir;
}

// A `syntaur` that hangs — to prove the hook's portable watchdog bounds it.
async function makeHangingSyntaur(): Promise<string> {
  const binDir = await mkdtemp(join(tmpdir(), 'syntaur-hangbin-'));
  const p = join(binDir, 'syntaur');
  await writeFile(p, `#!/bin/sh\nsleep 10\necho 9.9.9\n`);
  await chmod(p, 0o755);
  return binDir;
}

// A `syntaur` that IGNORES SIGTERM and hangs — proves the watchdog's SIGKILL
// deadline bounds even a TERM-trapping CLI.
async function makeTermIgnoringSyntaur(): Promise<string> {
  const binDir = await mkdtemp(join(tmpdir(), 'syntaur-trapbin-'));
  const p = join(binDir, 'syntaur');
  await writeFile(p, `#!/bin/sh\ntrap '' TERM\nsleep 10\necho 9.9.9\n`);
  await chmod(p, 0o755);
  return binDir;
}

const STDIN = JSON.stringify({
  session_id: 'sess-thin-1',
  transcript_path: '/tmp/transcripts/sess-thin-1.jsonl',
  cwd: '/tmp/no-syntaur-context-xyz',
});

describe('session-start.sh (thin wrapper)', () => {
  it('sources lib.sh for syntaur_bounded', async () => {
    const body = await readFile(hookPath, 'utf-8');
    expect(body).toContain('. "${BASH_SOURCE[0]%/*}/lib.sh"');
    const lib = await readFile(libPath, 'utf-8');
    expect(lib).toContain('syntaur_bounded()');
  });

  it('invokes `syntaur session register --from-hook` with the payload on stdin — no context.json required', async () => {
    const recordDir = await mkdtemp(join(tmpdir(), 'syntaur-record-'));
    const binDir = await makeRecordingSyntaur(recordDir);
    try {
      // cwd deliberately has NO .syntaur/context.json — the old gate is gone.
      const res = runHook(STDIN, { PATH: `${binDir}:${process.env.PATH}` });
      expect(res.status).toBe(0);

      const argv = await readFile(join(recordDir, 'argv'), 'utf-8');
      expect(argv).toContain('session register --from-hook');
      // `--pid` is gone: `sessions.pid` was dropped in schema v11 and liveness
      // is `status === 'active'` plus the stale sweep (phase 4, Decision 4).
      expect(argv).not.toMatch(/--pid/);

      const stdin = await readFile(join(recordDir, 'stdin'), 'utf-8');
      expect(JSON.parse(stdin)).toEqual(JSON.parse(STDIN));
    } finally {
      await rm(binDir, { recursive: true, force: true });
      await rm(recordDir, { recursive: true, force: true });
    }
  });

  it('exits 0 and does nothing when `syntaur` is not on PATH', async () => {
    // Minimal PATH: system dirs (jq lives elsewhere on Homebrew Macs, so link
    // it in explicitly) and definitely no `syntaur`.
    const tmpbin = join(sandbox, 'bin');
    await mkdir(tmpbin, { recursive: true });
    const jqPath = spawnSync('sh', ['-c', 'command -v jq'], { encoding: 'utf-8' }).stdout.trim();
    expect(jqPath).toBeTruthy();
    await writeFile(join(tmpbin, 'jq'), `#!/bin/sh\nexec "${jqPath}" "$@"\n`);
    await chmod(join(tmpbin, 'jq'), 0o755);

    const res = runHook(STDIN, { PATH: `${tmpbin}:/usr/bin:/bin` });
    expect(res.status).toBe(0);
  });

  it('exits 0 on empty stdin', async () => {
    const res = runHook('');
    expect(res.status).toBe(0);
  });

  it('never creates .syntaur/ itself (that responsibility moved to the CLI)', async () => {
    const cwd = join(sandbox, 'workspace');
    await mkdir(cwd, { recursive: true });
    // No syntaur on PATH → the hook is a no-op beyond reading stdin.
    const tmpbin = join(sandbox, 'bin');
    await mkdir(tmpbin, { recursive: true });
    const jqPath = spawnSync('sh', ['-c', 'command -v jq'], { encoding: 'utf-8' }).stdout.trim();
    await writeFile(join(tmpbin, 'jq'), `#!/bin/sh\nexec "${jqPath}" "$@"\n`);
    await chmod(join(tmpbin, 'jq'), 0o755);

    const res = runHook(JSON.stringify({ session_id: 's1', cwd }), {
      PATH: `${tmpbin}:/usr/bin:/bin`,
    });
    expect(res.status).toBe(0);
    expect(existsSync(join(cwd, '.syntaur'))).toBe(false);
  });

  it('bounds a hanging CLI with the SIGKILL watchdog and still exits 0', async () => {
    const binDir = await makeHangingSyntaur();
    try {
      const start = Date.now();
      const res = spawnSync('bash', [hookPath], {
        input: STDIN,
        encoding: 'utf-8',
        timeout: 12_000,
        env: {
          ...process.env,
          HOME: sandbox,
          PATH: `${binDir}:${process.env.PATH}`,
        },
      });
      const elapsed = Date.now() - start;
      expect(res.status).toBe(0);
      expect(res.signal).toBeNull();
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      await rm(binDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('bounds a SIGTERM-ignoring CLI via SIGKILL and still exits 0', async () => {
    const binDir = await makeTermIgnoringSyntaur();
    try {
      const start = Date.now();
      const res = spawnSync('bash', [hookPath], {
        input: STDIN,
        encoding: 'utf-8',
        timeout: 12_000,
        env: {
          ...process.env,
          HOME: sandbox,
          PATH: `${binDir}:${process.env.PATH}`,
        },
      });
      const elapsed = Date.now() - start;
      expect(res.status).toBe(0);
      expect(res.signal).toBeNull();
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      await rm(binDir, { recursive: true, force: true });
    }
  }, 15_000);
});
