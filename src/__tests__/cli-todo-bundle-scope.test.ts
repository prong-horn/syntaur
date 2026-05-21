import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile, access } from 'node:fs/promises';
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
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => { resolvePromise({ code: code ?? -1, stdout, stderr }); });
  });
}

async function pathExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

let syntaurHome: string;
let projectsDir: string;

beforeEach(async () => {
  syntaurHome = await mkdtemp(join(tmpdir(), 'syntaur-bundle-'));
  projectsDir = resolve(syntaurHome, 'projects');
  await mkdir(projectsDir, { recursive: true });
  await writeFile(
    resolve(syntaurHome, 'config.md'),
    `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\nonboarding:\n  completed: true\n---\n`,
  );
});

afterEach(async () => {
  await rm(syntaurHome, { recursive: true, force: true });
});

async function seedProject(slug: string): Promise<void> {
  await mkdir(resolve(projectsDir, slug), { recursive: true });
  await writeFile(
    resolve(projectsDir, slug, 'project.md'),
    `---\nid: ${slug}-id\nslug: ${slug}\ntitle: ${slug}\n---\n# ${slug}\n`,
  );
}

async function addTodos(count: number, scope: 'global' | { project: string } | { workspace: string } = 'global'): Promise<string[]> {
  const flags: string[] = [];
  if (typeof scope === 'object') {
    if ('project' in scope) flags.push('--project', scope.project);
    if ('workspace' in scope) flags.push('--workspace', scope.workspace);
  }
  for (let i = 0; i < count; i++) {
    const res = await runCli(['todo', 'add', `item-${i}`, ...flags], syntaurHome);
    expect(res.code).toBe(0);
  }
  let listPath: string;
  if (typeof scope === 'object' && 'project' in scope) {
    listPath = resolve(projectsDir, scope.project, 'todos', `${scope.project}.md`);
  } else if (typeof scope === 'object' && 'workspace' in scope) {
    listPath = resolve(syntaurHome, 'todos', `${scope.workspace}.md`);
  } else {
    listPath = resolve(syntaurHome, 'todos', '_global.md');
  }
  const content = await readFile(listPath, 'utf-8');
  const ids = [...content.matchAll(/\[t:([a-f0-9]{4})\]/g)].map((m) => m[1]);
  return ids;
}

describe('syntaur todo bundle new', () => {
  it('creates a bundle from 2+ global todos and tags each member with the bundle id', async () => {
    const [a, b] = await addTodos(2);
    const res = await runCli(['todo', 'bundle', 'new', a, b], syntaurHome);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/Created bundle b:[a-f0-9]{4}/);
    const bid = res.stdout.match(/b:([a-f0-9]{4})/)![1];
    // bundles/index.md exists at <todosDir>/bundles/index.md
    expect(await pathExists(resolve(syntaurHome, 'todos', 'bundles', 'index.md'))).toBe(true);
    // global checklist still exists, NOT a 'bundles' workspace
    expect(await pathExists(resolve(syntaurHome, 'todos', 'bundles.md'))).toBe(false);
    // member meta tokens contain bn=<bid>
    const content = await readFile(resolve(syntaurHome, 'todos', '_global.md'), 'utf-8');
    expect(content).toMatch(new RegExp(`bn=${bid}`));
  });

  it('rejects with fewer than 2 ids', async () => {
    const [a] = await addTodos(1);
    const res = await runCli(['todo', 'bundle', 'new', a], syntaurHome);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/at least 2 todos/i);
  });

  it('rejects duplicate ids in input', async () => {
    const [a, b] = await addTodos(2);
    const res = await runCli(['todo', 'bundle', 'new', a, b, a], syntaurHome);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/Duplicate/i);
  });

  it('rejects an id that is already part of another bundle', async () => {
    const [a, b, c] = await addTodos(3);
    const first = await runCli(['todo', 'bundle', 'new', a, b], syntaurHome);
    expect(first.code).toBe(0);
    const second = await runCli(['todo', 'bundle', 'new', a, c], syntaurHome);
    expect(second.code).not.toBe(0);
    expect(second.stderr).toMatch(/already part of bundle/i);
  });

  it('rejects an unknown id', async () => {
    const [a] = await addTodos(1);
    const res = await runCli(['todo', 'bundle', 'new', a, 'dead'], syntaurHome);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/not found/i);
  });

  it('rejects a completed member', async () => {
    const [a, b] = await addTodos(2);
    expect((await runCli(['todo', 'complete', b], syntaurHome)).code).toBe(0);
    const res = await runCli(['todo', 'bundle', 'new', a, b], syntaurHome);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/already completed/i);
  });

  it('rejects duplicate slug in the same scope', async () => {
    const ids = await addTodos(4);
    expect((await runCli(['todo', 'bundle', 'new', ids[0], ids[1], '--slug', 'auth'], syntaurHome)).code).toBe(0);
    const res = await runCli(['todo', 'bundle', 'new', ids[2], ids[3], '--slug', 'auth'], syntaurHome);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/already exists/i);
  });

  it('rejects an invalid slug (underscores not allowed)', async () => {
    const [a, b] = await addTodos(2);
    const res = await runCli(['todo', 'bundle', 'new', a, b, '--slug', 'bad_slug'], syntaurHome);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/Invalid bundle slug/i);
  });

  it('works in project scope', async () => {
    await seedProject('alpha');
    const ids = await addTodos(2, { project: 'alpha' });
    const res = await runCli(['todo', 'bundle', 'new', ids[0], ids[1], '--project', 'alpha'], syntaurHome);
    expect(res.code).toBe(0);
    expect(await pathExists(resolve(projectsDir, 'alpha', 'todos', 'bundles', 'index.md'))).toBe(true);
  });

  it('--branch presets the bundle.branch field and member branches', async () => {
    const [a, b] = await addTodos(2);
    const res = await runCli(['todo', 'bundle', 'new', a, b, '--branch', 'feat/preset'], syntaurHome);
    expect(res.code).toBe(0);
    const bundles = await readFile(resolve(syntaurHome, 'todos', 'bundles', 'index.md'), 'utf-8');
    expect(bundles).toContain('branch=feat/preset');
    const checklist = await readFile(resolve(syntaurHome, 'todos', '_global.md'), 'utf-8');
    // Members should have b=feat/preset on their meta tokens.
    expect((checklist.match(/b=feat\/preset/g) ?? []).length).toBe(2);
  });

  it('--plan creates plan.md immediately and prints its path on stdout', async () => {
    const [a, b] = await addTodos(2);
    const res = await runCli(['todo', 'bundle', 'new', a, b, '--plan'], syntaurHome);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/Created bundle b:[a-f0-9]{4}/);
    // The plan path is printed after the create line.
    const bid = res.stdout.match(/b:([a-f0-9]{4})/)![1];
    const expected = resolve(syntaurHome, 'todos', 'plans', '_global', 'bundles', bid, 'plan.md');
    expect(res.stdout).toContain(expected);
    expect(await pathExists(expected)).toBe(true);
  });
});

describe('syntaur todo bundle list / show', () => {
  it('list returns "No bundles found" on empty', async () => {
    const res = await runCli(['todo', 'bundle', 'list'], syntaurHome);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/No bundles found/);
  });

  it('list shows derived status open for all-open members', async () => {
    const [a, b] = await addTodos(2);
    expect((await runCli(['todo', 'bundle', 'new', a, b], syntaurHome)).code).toBe(0);
    const res = await runCli(['todo', 'bundle', 'list'], syntaurHome);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/\[ \] b:[a-f0-9]{4}/);
    expect(res.stdout).toMatch(/0\/2 done/);
  });

  it('list shows mixed status when one member is completed', async () => {
    const [a, b] = await addTodos(2);
    expect((await runCli(['todo', 'bundle', 'new', a, b], syntaurHome)).code).toBe(0);
    expect((await runCli(['todo', 'complete', a], syntaurHome)).code).toBe(0);
    const res = await runCli(['todo', 'bundle', 'list'], syntaurHome);
    expect(res.stdout).toMatch(/\[~\] /);
    expect(res.stdout).toMatch(/1\/2 done/);
  });

  it('show prints bundle metadata + members', async () => {
    const [a, b] = await addTodos(2);
    const create = await runCli(['todo', 'bundle', 'new', a, b, '--slug', 'foo'], syntaurHome);
    const bid = create.stdout.match(/b:([a-f0-9]{4})/)![1];
    const res = await runCli(['todo', 'bundle', 'show', bid], syntaurHome);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(`Bundle b:${bid}`);
    expect(res.stdout).toMatch(/Slug: foo/);
    expect(res.stdout).toMatch(/Members \(2\):/);
  });

  it('show accepts b: prefix on the id', async () => {
    const [a, b] = await addTodos(2);
    const create = await runCli(['todo', 'bundle', 'new', a, b], syntaurHome);
    const bid = create.stdout.match(/b:([a-f0-9]{4})/)![1];
    const res = await runCli(['todo', 'bundle', 'show', `b:${bid}`], syntaurHome);
    expect(res.code).toBe(0);
  });

  it('show errors on unknown bundle id', async () => {
    const res = await runCli(['todo', 'bundle', 'show', 'dead'], syntaurHome);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/not found/i);
  });
});

describe('syntaur todo bundle plan', () => {
  it('first call creates plan.md and updates each member planDir', async () => {
    const [a, b] = await addTodos(2);
    const create = await runCli(['todo', 'bundle', 'new', a, b], syntaurHome);
    const bid = create.stdout.match(/b:([a-f0-9]{4})/)![1];
    const res = await runCli(['todo', 'bundle', 'plan', bid], syntaurHome);
    expect(res.code).toBe(0);
    const expected = resolve(syntaurHome, 'todos', 'plans', '_global', 'bundles', bid, 'plan.md');
    expect(res.stdout.trim()).toBe(expected);
    expect(await pathExists(expected)).toBe(true);
    const content = await readFile(resolve(syntaurHome, 'todos', '_global.md'), 'utf-8');
    expect(content).toContain(`p=${resolve(syntaurHome, 'todos', 'plans', '_global', 'bundles', bid)}`);
  });

  it('second call creates plan-v2.md', async () => {
    const [a, b] = await addTodos(2);
    const create = await runCli(['todo', 'bundle', 'new', a, b], syntaurHome);
    const bid = create.stdout.match(/b:([a-f0-9]{4})/)![1];
    expect((await runCli(['todo', 'bundle', 'plan', bid], syntaurHome)).code).toBe(0);
    const res = await runCli(['todo', 'bundle', 'plan', bid], syntaurHome);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toMatch(/plan-v2\.md$/);
  });
});

describe('syntaur todo bundle add / remove', () => {
  it('add appends ids and tags each member', async () => {
    const [a, b, c] = await addTodos(3);
    const create = await runCli(['todo', 'bundle', 'new', a, b], syntaurHome);
    const bid = create.stdout.match(/b:([a-f0-9]{4})/)![1];
    const res = await runCli(['todo', 'bundle', 'add', bid, c], syntaurHome);
    expect(res.code).toBe(0);
    const show = await runCli(['todo', 'bundle', 'show', bid], syntaurHome);
    expect(show.stdout).toMatch(/Members \(3\):/);
  });

  it('remove refuses to leave fewer than 2 members', async () => {
    const [a, b] = await addTodos(2);
    const create = await runCli(['todo', 'bundle', 'new', a, b], syntaurHome);
    const bid = create.stdout.match(/b:([a-f0-9]{4})/)![1];
    const res = await runCli(['todo', 'bundle', 'remove', bid, a], syntaurHome);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/fewer than 2 members/i);
    expect(res.stderr).toMatch(/dissolve/);
  });

  it('remove allowed when 3+ members → 2', async () => {
    const [a, b, c] = await addTodos(3);
    const create = await runCli(['todo', 'bundle', 'new', a, b, c], syntaurHome);
    const bid = create.stdout.match(/b:([a-f0-9]{4})/)![1];
    const res = await runCli(['todo', 'bundle', 'remove', bid, a], syntaurHome);
    expect(res.code).toBe(0);
    const show = await runCli(['todo', 'bundle', 'show', bid], syntaurHome);
    expect(show.stdout).toMatch(/Members \(2\):/);
  });

  it('remove rejects a non-member', async () => {
    const [a, b, c] = await addTodos(3);
    const create = await runCli(['todo', 'bundle', 'new', a, b], syntaurHome);
    const bid = create.stdout.match(/b:([a-f0-9]{4})/)![1];
    const res = await runCli(['todo', 'bundle', 'remove', bid, c], syntaurHome);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/not a member/i);
  });
});

describe('syntaur todo bundle dissolve', () => {
  it('clears each member bundleId and removes the bundle, preserving in_progress status', async () => {
    const [a, b] = await addTodos(2);
    const create = await runCli(['todo', 'bundle', 'new', a, b], syntaurHome);
    const bid = create.stdout.match(/b:([a-f0-9]{4})/)![1];
    // Put one member in_progress with a session.
    expect((await runCli(['todo', 'start', a, '--session', 'sess-x'], syntaurHome)).code).toBe(0);
    const before = await readFile(resolve(syntaurHome, 'todos', '_global.md'), 'utf-8');
    expect(before).toContain('[>:sess-x]');
    expect(before).toMatch(new RegExp(`bn=${bid}`));

    const res = await runCli(['todo', 'bundle', 'dissolve', bid], syntaurHome);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/Dissolved bundle/);

    const after = await readFile(resolve(syntaurHome, 'todos', '_global.md'), 'utf-8');
    // bundleId cleared but session+status preserved.
    expect(after).not.toMatch(new RegExp(`bn=${bid}`));
    expect(after).toContain('[>:sess-x]');

    // Bundles file now has zero bundles (header + frontmatter only).
    const bundleContent = await readFile(resolve(syntaurHome, 'todos', 'bundles', 'index.md'), 'utf-8');
    expect(bundleContent).not.toMatch(new RegExp(`b:${bid}`));
  });
});

describe('syntaur todo bundle complete', () => {
  it('marks each open member completed and writes a log entry per newly-completed member', async () => {
    const [a, b] = await addTodos(2);
    const create = await runCli(['todo', 'bundle', 'new', a, b], syntaurHome);
    const bid = create.stdout.match(/b:([a-f0-9]{4})/)![1];
    const res = await runCli(['todo', 'bundle', 'complete', bid, '--summary', 'all done'], syntaurHome);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/2 newly completed/);

    const checklist = await readFile(resolve(syntaurHome, 'todos', '_global.md'), 'utf-8');
    // Both lines should be `[x]`.
    expect(checklist.match(/^- \[x\]/gm)?.length).toBe(2);

    const log = await readFile(resolve(syntaurHome, 'todos', '_global-log.md'), 'utf-8');
    expect(log).toContain('all done');
  });

  it('skips already-completed members (no duplicate log entries)', async () => {
    const [a, b] = await addTodos(2);
    const create = await runCli(['todo', 'bundle', 'new', a, b], syntaurHome);
    const bid = create.stdout.match(/b:([a-f0-9]{4})/)![1];
    expect((await runCli(['todo', 'complete', a], syntaurHome)).code).toBe(0);
    const res = await runCli(['todo', 'bundle', 'complete', bid], syntaurHome);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/1 newly completed/);
    expect(res.stdout).toMatch(/1 already done/);
  });
});
