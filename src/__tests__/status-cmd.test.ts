import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
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
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

describe('syntaur status', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-status-'));
    // defaultProjectDir must point at THIS temp home so remove/rename scans
    // resolve the fixture assignments (the CLI scans config.defaultProjectDir).
    await writeFile(
      resolve(home, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(home, 'projects')}\n---\n`,
      'utf-8',
    );
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function writeAssignment(slug: string, status: string): Promise<string> {
    const dir = resolve(home, 'projects', 'p', 'assignments', slug);
    await mkdir(dir, { recursive: true });
    const path = resolve(dir, 'assignment.md');
    await writeFile(
      path,
      `---\nid: 1111-${slug}\nslug: ${slug}\nstatus: ${status}\nproject: p\nupdated: "2026-01-01T00:00:00Z"\n---\n# ${slug}\n`,
      'utf-8',
    );
    return path;
  }

  async function list(): Promise<{
    statuses: { id: string; label: string; terminal?: boolean }[];
    order: string[];
    transitions: { from: string; command: string; to: string }[];
    source: 'config' | 'default';
  }> {
    const r = await runCli(['status', 'list', '--json'], home);
    expect(r.code, r.stderr).toBe(0);
    return JSON.parse(r.stdout);
  }

  it('list reports source: default before init, source: config after', async () => {
    expect((await list()).source).toBe('default');
    const init = await runCli(['status', 'init'], home);
    expect(init.code, init.stderr).toBe(0);
    const after = await list();
    expect(after.source).toBe('config');
    expect(after.statuses.length).toBeGreaterThan(0);
  });

  it('every documented invocation is a known command (no "unknown command")', async () => {
    await runCli(['status', 'init'], home);
    const invocations = [
      ['status', 'list'],
      ['status', 'add', 'x', '--label', 'X', '--dry-run'],
      ['status', 'set', '--id', 'pending', '--label', 'Pending2', '--dry-run'],
      ['status', 'reorder', 'draft', '--dry-run'], // intentionally invalid perm → handled error, not "unknown"
      ['status', 'remove', 'pending', '--dry-run'],
      ['status', 'rename', 'pending', '--to', 'pending2', '--dry-run'],
      ['status', 'transition', 'add', '--from', 'pending', '--command', 'go', '--to', 'review', '--dry-run'],
      ['status', 'transition', 'remove', '--from', 'pending', '--command', 'go', '--dry-run'],
    ];
    for (const args of invocations) {
      const r = await runCli(args, home);
      expect(r.stderr).not.toContain('unknown command');
      expect(r.stderr).not.toContain('error: unknown');
    }
  });

  it('init refuses to overwrite an existing block without --force', async () => {
    await runCli(['status', 'init'], home);
    const again = await runCli(['status', 'init'], home);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('already exists');
    const forced = await runCli(['status', 'init', '--force'], home);
    expect(forced.code, forced.stderr).toBe(0);
  });

  it('add inserts at the requested position', async () => {
    await runCli(['status', 'init'], home);
    const r = await runCli(['status', 'add', 'needs_design', '--label', 'Needs Design', '--after', 'pending'], home);
    expect(r.code, r.stderr).toBe(0);
    const order = (await list()).order;
    expect(order[order.indexOf('pending') + 1]).toBe('needs_design');
  });

  it('--dry-run does not write', async () => {
    await runCli(['status', 'init'], home);
    const before = await list();
    const dry = await runCli(['status', 'add', 'ghost', '--label', 'Ghost', '--dry-run'], home);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain('ghost'); // diff shows the would-be addition
    const after = await list();
    expect(after.statuses.some((s) => s.id === 'ghost')).toBe(false);
    expect(after.order).toEqual(before.order);
  });

  it('set --terminal accepts literal true/false', async () => {
    await runCli(['status', 'init'], home);
    let r = await runCli(['status', 'set', '--id', 'pending', '--terminal', 'true'], home);
    expect(r.code, r.stderr).toBe(0);
    expect((await list()).statuses.find((s) => s.id === 'pending')?.terminal).toBe(true);
    r = await runCli(['status', 'set', '--id', 'pending', '--terminal', 'notabool'], home);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('true');
  });

  it('reorder rejects a non-permutation', async () => {
    await runCli(['status', 'init'], home);
    const r = await runCli(['status', 'reorder', 'draft,pending'], home);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('permutation');
  });

  it('remove without --force fails and lists the offending assignment; the file is untouched', async () => {
    await runCli(['status', 'init'], home);
    const path = await writeAssignment('a', 'in_progress');
    const r = await runCli(['status', 'remove', 'in_progress'], home);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('p/a');
    // status still present in config + assignment unchanged.
    expect((await list()).statuses.some((s) => s.id === 'in_progress')).toBe(true);
    expect(await readFile(path, 'utf-8')).toContain('status: in_progress');
  });

  it('remove --force edits config only and never deletes the affected assignment', async () => {
    await runCli(['status', 'init'], home);
    const path = await writeAssignment('a', 'in_progress');
    const r = await runCli(['status', 'remove', 'in_progress', '--force'], home);
    expect(r.code, r.stderr).toBe(0);
    const after = await list();
    expect(after.statuses.some((s) => s.id === 'in_progress')).toBe(false);
    expect(after.order).not.toContain('in_progress');
    // The transitions referencing in_progress are pruned.
    expect(after.transitions.every((t) => t.from !== 'in_progress' && t.to !== 'in_progress')).toBe(true);
    // CRITICAL: the assignment.md is left on disk with its now-invalid status.
    const content = await readFile(path, 'utf-8');
    expect(content).toContain('status: in_progress');
  });

  it('rename rewrites config.md AND every affected assignment.md atomically', async () => {
    await runCli(['status', 'init'], home);
    const a = await writeAssignment('a', 'in_progress');
    const b = await writeAssignment('b', 'in_progress');
    const c = await writeAssignment('c', 'review'); // unaffected
    const r = await runCli(['status', 'rename', 'in_progress', '--to', 'working'], home);
    expect(r.code, r.stderr).toBe(0);

    const after = await list();
    expect(after.statuses.some((s) => s.id === 'working')).toBe(true);
    expect(after.statuses.some((s) => s.id === 'in_progress')).toBe(false);
    expect(after.order).toContain('working');

    expect(await readFile(a, 'utf-8')).toContain('status: working');
    expect(await readFile(b, 'utf-8')).toContain('status: working');
    // unaffected assignment keeps its status
    expect(await readFile(c, 'utf-8')).toContain('status: review');
  });

  it('rename --dry-run shows the per-file diff and writes nothing', async () => {
    await runCli(['status', 'init'], home);
    const a = await writeAssignment('a', 'in_progress');
    const r = await runCli(['status', 'rename', 'in_progress', '--to', 'working', '--dry-run'], home);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('working');
    expect(await readFile(a, 'utf-8')).toContain('status: in_progress');
    expect((await list()).statuses.some((s) => s.id === 'in_progress')).toBe(true);
  });

  it('transition add then remove round-trips', async () => {
    await runCli(['status', 'init'], home);
    let r = await runCli(
      ['status', 'transition', 'add', '--from', 'pending', '--command', 'fast-track', '--to', 'review'],
      home,
    );
    expect(r.code, r.stderr).toBe(0);
    expect((await list()).transitions.some((t) => t.command === 'fast-track')).toBe(true);
    r = await runCli(['status', 'transition', 'remove', '--from', 'pending', '--command', 'fast-track'], home);
    expect(r.code, r.stderr).toBe(0);
    expect((await list()).transitions.some((t) => t.command === 'fast-track')).toBe(false);
  });

  it('reset removes the block (source reverts to default)', async () => {
    await runCli(['status', 'init'], home);
    expect((await list()).source).toBe('config');
    const r = await runCli(['status', 'reset'], home);
    expect(r.code, r.stderr).toBe(0);
    expect((await list()).source).toBe('default');
  });

  it('mutating a fresh config without init tells the user to init first', async () => {
    const r = await runCli(['status', 'add', 'x', '--label', 'X'], home);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('init');
  });

  it('a custom block with no transitions: list shows defaults, transition add preserves them', async () => {
    // A statuses block with definitions + order but NO transitions: block — the
    // runtime (and dashboard) materialize the default transitions for this case.
    await writeFile(
      resolve(home, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(home, 'projects')}\nstatuses:\n  definitions:\n    - id: pending\n      label: Pending\n    - id: done\n      label: Done\n      terminal: true\n  order:\n    - pending\n    - done\n---\n`,
      'utf-8',
    );
    const before = await list();
    expect(before.source).toBe('config');
    expect(before.transitions.length).toBeGreaterThan(0); // materialized defaults, not []

    const add = await runCli(
      ['status', 'transition', 'add', '--from', 'pending', '--command', 'finish', '--to', 'done'],
      home,
    );
    expect(add.code, add.stderr).toBe(0);
    const after = await list();
    // The new transition is present AND the default transitions were not wiped.
    expect(after.transitions.some((t) => t.command === 'finish')).toBe(true);
    expect(after.transitions.length).toBeGreaterThan(1);
  });
});
