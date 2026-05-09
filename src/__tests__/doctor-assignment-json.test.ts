import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const CLI_ENTRY = resolve(__dirname, '..', '..', 'bin', 'syntaur.js');

interface RunResult { code: number; stdout: string; stderr: string }

async function runCli(args: string[], syntaurHome: string): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env: { ...process.env, SYNTAUR_HOME: syntaurHome },
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

const VALID_ASSIGNMENT = `---
id: abc-1
slug: demo
title: "Demo"
project: p
type: feature
status: in_progress
priority: medium
created: "2026-04-23T12:00:00Z"
updated: "2026-04-23T12:00:00Z"
workspace:
  repository: /tmp/x
  worktreePath: /tmp/x
  branch: main
  parentBranch: main
tags: []
---

Body.
`;

const MISSING_SLUG = VALID_ASSIGNMENT.replace('slug: demo\n', '');
const MISSING_WORKSPACE = `---
id: abc-1
slug: demo
title: "Demo"
project: p
status: in_progress
priority: medium
created: "2026-04-23T12:00:00Z"
updated: "2026-04-23T12:00:00Z"
workspace:
  repository: /tmp/x
tags: []
---

Body.
`;

describe('syntaur doctor --assignment --json', () => {
  let syntaurHome: string;
  let scratch: string;

  beforeEach(async () => {
    syntaurHome = await mkdtemp(join(tmpdir(), 'syntaur-da-'));
    await mkdir(resolve(syntaurHome, 'projects'), { recursive: true });
    await writeFile(
      resolve(syntaurHome, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(syntaurHome, 'projects')}\nonboarding:\n  completed: true\n---\n`,
    );
    scratch = await mkdtemp(join(tmpdir(), 'syntaur-da-scratch-'));
  });

  afterEach(async () => {
    await rm(syntaurHome, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });

  it('returns ok:true with no errors for a valid assignment.md', async () => {
    const path = resolve(scratch, 'assignment.md');
    await writeFile(path, VALID_ASSIGNMENT);
    const r = await runCli(['doctor', '--assignment', path, '--json'], syntaurHome);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.ok).toBe(true);
    expect(data.errors).toEqual([]);
    expect(data.path).toBe(path);
  });

  it('returns ok:false when slug is missing', async () => {
    const path = resolve(scratch, 'assignment.md');
    await writeFile(path, MISSING_SLUG);
    const r = await runCli(['doctor', '--assignment', path, '--json'], syntaurHome);
    expect(r.code).toBe(1);
    const data = JSON.parse(r.stdout);
    expect(data.ok).toBe(false);
    expect(data.errors.some((e: string) => e.includes('slug'))).toBe(true);
  });

  it('returns ok:false when workspace block is missing required fields', async () => {
    const path = resolve(scratch, 'assignment.md');
    await writeFile(path, MISSING_WORKSPACE);
    const r = await runCli(['doctor', '--assignment', path, '--json'], syntaurHome);
    expect(r.code).toBe(1);
    const data = JSON.parse(r.stdout);
    expect(data.ok).toBe(false);
    expect(
      data.errors.some((e: string) => /worktreePath|branch|parentBranch/.test(e)),
    ).toBe(true);
  });

  it('returns ok:false when the file does not exist', async () => {
    const r = await runCli(['doctor', '--assignment', '/no/such/file.md', '--json'], syntaurHome);
    expect(r.code).toBe(1);
    const data = JSON.parse(r.stdout);
    expect(data.ok).toBe(false);
    expect(data.errors[0]).toContain('does not exist');
  });
});
