import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const hookPath = resolve(here, '../../hooks/prompt-context.sh');

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-hook-prompt-'));
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
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${recordDir}/argv"\ncat >> "${recordDir}/stdin"\n`,
  );
  await chmod(p, 0o755);
  return binDir;
}

const STDIN = JSON.stringify({ session_id: 'sess-prompt-1', cwd: '/tmp' });

describe('prompt-context.sh', () => {
  it('sources lib.sh', async () => {
    const body = await readFile(hookPath, 'utf-8');
    expect(body).toContain('lib.sh');
  });

  it('forwards stdin to session context --from-hook', async () => {
    const recordDir = await mkdtemp(join(tmpdir(), 'syntaur-record-'));
    const binDir = await makeRecordingSyntaur(recordDir);
    try {
      const res = runHook(STDIN, { PATH: `${binDir}:${process.env.PATH}` });
      expect(res.status).toBe(0);
      const argv = await readFile(join(recordDir, 'argv'), 'utf-8');
      expect(argv).toContain('session context --from-hook');
    } finally {
      await rm(binDir, { recursive: true, force: true });
      await rm(recordDir, { recursive: true, force: true });
    }
  });

  it('exits 0 without syntaur on PATH', () => {
    expect(runHook(STDIN, { PATH: '/usr/bin:/bin' }).status).toBe(0);
  });

  it('exits 0 on empty stdin', () => {
    expect(runHook('').status).toBe(0);
  });

  it('completes within 10s when syntaur hangs', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'syntaur-hangbin-'));
    const p = join(binDir, 'syntaur');
    await writeFile(p, `#!/bin/sh\nsleep 10\n`);
    await chmod(p, 0o755);
    try {
      const start = Date.now();
      const res = spawnSync('bash', [hookPath], {
        input: STDIN,
        encoding: 'utf-8',
        timeout: 12_000,
        env: { ...process.env, HOME: sandbox, PATH: `${binDir}:${process.env.PATH}` },
      });
      expect(Date.now() - start).toBeLessThan(10_000);
      expect(res.status).toBe(0);
    } finally {
      await rm(binDir, { recursive: true, force: true });
    }
  }, 15_000);
});
