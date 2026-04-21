import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(
  here,
  '../../platforms/codex/scripts/resolve-session.sh',
);

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-codex-resolver-'));
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function writeRollout(
  relPath: string,
  payload: { id: string; cwd: string },
) {
  const absPath = resolve(sandbox, relPath);
  await mkdir(dirname(absPath), { recursive: true });
  const firstLine = JSON.stringify({
    type: 'session_meta',
    timestamp: new Date().toISOString(),
    payload,
  });
  await writeFile(absPath, firstLine + '\n{"event":"user_message"}\n');
  return absPath;
}

function run(targetCwd: string) {
  return spawnSync('bash', [scriptPath, targetCwd], {
    env: { ...process.env, CODEX_SESSIONS_DIR: sandbox },
    encoding: 'utf-8',
  });
}

describe('codex resolve-session.sh', () => {
  it('emits session_id + transcript_path for the matching rollout', async () => {
    const file = await writeRollout(
      '2026/04/20/rollout-2026-04-20T00-00-00-abc.jsonl',
      {
        id: '019d8738-1168-7040-9a75-f6b5573959af',
        cwd: '/fake/cwd',
      },
    );

    const res = run('/fake/cwd');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(
      'session_id=019d8738-1168-7040-9a75-f6b5573959af',
    );
    expect(res.stdout).toContain(`transcript_path=${file}`);
  });

  it('exits non-zero with empty stdout when no rollout matches the cwd', async () => {
    await writeRollout(
      '2026/04/20/rollout-2026-04-20T00-00-00-abc.jsonl',
      { id: 'some-id', cwd: '/other/cwd' },
    );
    const res = run('/does/not/match');
    expect(res.status).not.toBe(0);
    expect(res.stdout).toBe('');
  });

  it('exits non-zero with empty stdout when the sessions root has no rollout files at all', async () => {
    // sandbox is intentionally empty — no YYYY/MM/DD/rollout-*.jsonl anywhere.
    const res = run('/any/cwd');
    expect(res.status).not.toBe(0);
    expect(res.stdout).toBe('');
  });

  it('picks the newest rollout by mtime when multiple match the same cwd', async () => {
    const older = await writeRollout(
      '2026/04/19/rollout-2026-04-19T12-00-00-old.jsonl',
      { id: 'older-id', cwd: '/shared/cwd' },
    );
    const newer = await writeRollout(
      '2026/04/20/rollout-2026-04-20T12-00-00-new.jsonl',
      { id: 'newer-id', cwd: '/shared/cwd' },
    );
    const tsOld = new Date('2026-04-19T12:00:00Z');
    const tsNew = new Date('2026-04-20T12:00:00Z');
    await utimes(older, tsOld, tsOld);
    await utimes(newer, tsNew, tsNew);

    const res = run('/shared/cwd');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('session_id=newer-id');
    expect(res.stdout).toContain(`transcript_path=${newer}`);
  });
});
