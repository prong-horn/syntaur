import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stalenessChecks } from '../utils/doctor/checks/staleness.js';
import type { CheckContext } from '../utils/doctor/types.js';
import type { SyntaurConfig } from '../utils/config.js';

let root: string;

function ctxFor(): CheckContext {
  return {
    config: {} as SyntaurConfig, // the check reads config.md by path, not ctx.config
    syntaurRoot: root,
    db: null,
    dbError: null,
    cwd: root,
    now: new Date('2026-06-18T00:00:00Z'),
  };
}

async function writeConfig(body: string): Promise<void> {
  await writeFile(resolve(root, 'config.md'), `---\nversion: "2.0"\n${body}\n---\n# C\n`);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'syntaur-doc-stale-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('doctor: staleness.valid', () => {
  const check = stalenessChecks[0];

  it('skips when there is no staleness block', async () => {
    await writeConfig('defaultProjectDir: /tmp/x');
    const r = await check.run(ctxFor());
    expect(Array.isArray(r) ? r[0].status : r.status).toBe('skipped');
  });

  it('passes for a valid staleness block', async () => {
    await writeConfig('staleness:\n  reviewAging: 2d\n  inProgressNoActivity: 14d');
    const r = await check.run(ctxFor());
    expect(Array.isArray(r) ? r[0].status : r.status).toBe('pass');
  });

  it('warns (never errors) on unknown keys / bad durations', async () => {
    await writeConfig('staleness:\n  bogusKey: 9d\n  blockedAging: nope');
    const result = await check.run(ctxFor());
    const r = Array.isArray(result) ? result[0] : result;
    expect(r.status).toBe('warn');
    expect(r.affected).toHaveLength(2);
  });
});
