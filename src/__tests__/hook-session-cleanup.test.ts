import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const hookPath = resolve(
  here,
  '../../platforms/claude-code/hooks/session-cleanup.sh',
);

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-hook-cleanup-'));
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

function runHook(stdinJson: string, env: Record<string, string> = {}) {
  return spawnSync('bash', [hookPath], {
    input: stdinJson,
    encoding: 'utf-8',
    env: { ...process.env, HOME: sandbox, ...env },
  });
}

async function makeRecordingSyntaur(recordDir: string): Promise<string> {
  const binDir = await mkdtemp(join(tmpdir(), 'syntaur-fakebin-'));
  const p = join(binDir, 'syntaur');
  await writeFile(
    p,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${recordDir}/argv"\ncat >> "${recordDir}/stdin"\nexit 0\n`,
  );
  await chmod(p, 0o755);
  return binDir;
}

// The ending-session-id RESOLUTION rules (stdin id wins over the clobberable
// context.json scalar; fallback only when stdin has no id) are unit-tested in
// session-register.test.ts against runSessionStop — the hook just pipes the
// payload through.
describe('claude-code session-cleanup.sh (thin wrapper)', () => {
  it('invokes `syntaur session stop --from-hook` with the payload on stdin', async () => {
    const recordDir = await mkdtemp(join(tmpdir(), 'syntaur-record-'));
    const binDir = await makeRecordingSyntaur(recordDir);
    const payload = JSON.stringify({ session_id: 'ending-1', cwd: '/tmp/some-cwd' });
    try {
      const res = runHook(payload, { PATH: `${binDir}:${process.env.PATH}` });
      expect(res.status).toBe(0);

      const argv = await readFile(join(recordDir, 'argv'), 'utf-8');
      expect(argv).toContain('session stop --from-hook');

      const stdin = await readFile(join(recordDir, 'stdin'), 'utf-8');
      expect(JSON.parse(stdin)).toEqual(JSON.parse(payload));
    } finally {
      await rm(binDir, { recursive: true, force: true });
      await rm(recordDir, { recursive: true, force: true });
    }
  });

  it('exits 0 when `syntaur` is not on PATH', async () => {
    const tmpbin = join(sandbox, 'bin');
    await mkdir(tmpbin, { recursive: true });
    const jqPath = spawnSync('sh', ['-c', 'command -v jq'], { encoding: 'utf-8' }).stdout.trim();
    expect(jqPath).toBeTruthy();
    await writeFile(join(tmpbin, 'jq'), `#!/bin/sh\nexec "${jqPath}" "$@"\n`);
    await chmod(join(tmpbin, 'jq'), 0o755);

    const res = runHook(JSON.stringify({ session_id: 's1', cwd: '/tmp' }), {
      PATH: `${tmpbin}:/usr/bin:/bin`,
    });
    expect(res.status).toBe(0);
  });

  it('exits 0 on empty stdin', async () => {
    const res = runHook('');
    expect(res.status).toBe(0);
  });

  it('bounds a hanging CLI and still exits 0', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'syntaur-hangbin-'));
    await writeFile(join(binDir, 'syntaur'), `#!/bin/sh\ntrap '' TERM\nsleep 10\n`);
    await chmod(join(binDir, 'syntaur'), 0o755);
    try {
      const start = Date.now();
      const res = spawnSync('bash', [hookPath], {
        input: JSON.stringify({ session_id: 'hang-1', cwd: '/tmp' }),
        encoding: 'utf-8',
        timeout: 10_000,
        env: { ...process.env, HOME: sandbox, PATH: `${binDir}:${process.env.PATH}` },
      });
      const elapsed = Date.now() - start;
      expect(res.status).toBe(0);
      expect(res.signal).toBeNull();
      expect(elapsed).toBeLessThan(8_000); // ~4s watchdog, well under the 10s hang
    } finally {
      await rm(binDir, { recursive: true, force: true });
    }
  }, 12_000);
});
