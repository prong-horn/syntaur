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
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('close', (code) => {
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

let syntaurHome: string;
let projectsDir: string;

beforeEach(async () => {
  syntaurHome = await mkdtemp(join(tmpdir(), 'syntaur-cli-todo-'));
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

describe('syntaur todo CLI scope resolution', () => {
  it('(g) no-flag default writes to <SYNTAUR_HOME>/todos/_global.md', async () => {
    const res = await runCli(['todo', 'add', 'no-flag-default'], syntaurHome);
    expect(res.code).toBe(0);
    const content = await readFile(resolve(syntaurHome, 'todos', '_global.md'), 'utf-8');
    expect(content).toContain('no-flag-default');
    expect(content).toMatch(/^---\nworkspace: _global\n/m);
  });

  it('(h) --project ghost (no directory) fails without creating it', async () => {
    const res = await runCli(['todo', 'add', 'x', '--project', 'ghost'], syntaurHome);
    expect(res.code).not.toBe(0);
    expect(res.stderr + res.stdout).toMatch(/not found/i);
    expect(await pathExists(resolve(projectsDir, 'ghost'))).toBe(false);
  });

  it('(i) --project + --workspace errors with "at most one"', async () => {
    await seedProject('alpha');
    const res = await runCli(
      ['todo', 'add', 'x', '--project', 'alpha', '--workspace', 'wsname'],
      syntaurHome,
    );
    expect(res.code).not.toBe(0);
    expect(res.stderr + res.stdout).toMatch(/at most one/i);
  });

  it('(j) empty dir with no project.md still rejects as not found (does not create todos/)', async () => {
    await mkdir(resolve(projectsDir, 'empty-shell'), { recursive: true });
    const res = await runCli(['todo', 'add', 'x', '--project', 'empty-shell'], syntaurHome);
    expect(res.code).not.toBe(0);
    expect(res.stderr + res.stdout).toMatch(/not found/i);
    expect(await pathExists(resolve(projectsDir, 'empty-shell', 'todos'))).toBe(false);
  });

  it('--project <valid> writes under <projectsDir>/<slug>/todos/<slug>.md', async () => {
    await seedProject('alpha');
    const res = await runCli(['todo', 'add', 'first', '--project', 'alpha'], syntaurHome);
    expect(res.code).toBe(0);
    const content = await readFile(
      resolve(projectsDir, 'alpha', 'todos', 'alpha.md'),
      'utf-8',
    );
    expect(content).toContain('first');
    expect(content).toMatch(/^---\nworkspace: alpha\n/m);
  });

  it('todo add records createdAt/updatedAt meta token on the line', async () => {
    const res = await runCli(['todo', 'add', 'with-times'], syntaurHome);
    expect(res.code).toBe(0);
    const content = await readFile(resolve(syntaurHome, 'todos', '_global.md'), 'utf-8');
    expect(content).toMatch(/<.*c=\d{4}-\d{2}-\d{2}T.*;u=\d{4}-\d{2}-\d{2}T.*>/);
  });

  it('todo start --branch foo --worktree /tmp/wt persists branch and worktreePath', async () => {
    const addRes = await runCli(['todo', 'add', 'start-branch'], syntaurHome);
    expect(addRes.code).toBe(0);
    const before = await readFile(resolve(syntaurHome, 'todos', '_global.md'), 'utf-8');
    const idMatch = before.match(/\[t:([a-f0-9]{4})\]/);
    expect(idMatch).not.toBeNull();
    const id = idMatch![1];

    const startRes = await runCli(
      ['todo', 'start', id, '--branch', 'feat/promote-test', '--worktree', '/tmp/wt'],
      syntaurHome,
    );
    expect(startRes.code).toBe(0);
    const after = await readFile(resolve(syntaurHome, 'todos', '_global.md'), 'utf-8');
    expect(after).toContain('b=feat/promote-test');
    expect(after).toContain('w=/tmp/wt');
  });
});

describe('syntaur todo promote --new-assignment', () => {
  it('creates a new assignment from a single todo and marks it completed', async () => {
    await seedProject('alpha');
    const addRes = await runCli(['todo', 'add', 'rewrite the README'], syntaurHome);
    expect(addRes.code).toBe(0);
    const before = await readFile(resolve(syntaurHome, 'todos', '_global.md'), 'utf-8');
    const id = before.match(/\[t:([a-f0-9]{4})\]/)![1];

    const res = await runCli(
      ['todo', 'promote', id, '--new-assignment', '--to-project', 'alpha', '--type', 'feature'],
      syntaurHome,
    );
    expect(res.code).toBe(0);

    const after = await readFile(resolve(syntaurHome, 'todos', '_global.md'), 'utf-8');
    expect(after).toMatch(new RegExp(`- \\[x\\] rewrite the README .*\\[t:${id}\\]`));

    const log = await readFile(resolve(syntaurHome, 'todos', '_global-log.md'), 'utf-8');
    expect(log).toContain('Promoted to assignment alpha/');

    const assignmentsRoot = resolve(projectsDir, 'alpha', 'assignments');
    const { readdir } = await import('node:fs/promises');
    const dirs = await readdir(assignmentsRoot);
    expect(dirs.length).toBe(1);
    const assignmentMd = await readFile(
      resolve(assignmentsRoot, dirs[0], 'assignment.md'),
      'utf-8',
    );
    expect(assignmentMd).toContain('## Todos');
    expect(assignmentMd).toContain('- [ ] rewrite the README');
    expect(assignmentMd).toContain(`promoted from t:${id}`);
  });

  it('requires --title when promoting multiple todos', async () => {
    await seedProject('alpha');
    await runCli(['todo', 'add', 'one'], syntaurHome);
    await runCli(['todo', 'add', 'two'], syntaurHome);
    const list = await readFile(resolve(syntaurHome, 'todos', '_global.md'), 'utf-8');
    const ids = [...list.matchAll(/\[t:([a-f0-9]{4})\]/g)].map((m) => m[1]);
    expect(ids.length).toBe(2);

    const res = await runCli(
      ['todo', 'promote', ids[0], ids[1], '--new-assignment', '--to-project', 'alpha'],
      syntaurHome,
    );
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/--title is required/);
  });

  it('promotes multiple todos to one assignment with --title', async () => {
    await seedProject('alpha');
    await runCli(['todo', 'add', 'first task'], syntaurHome);
    await runCli(['todo', 'add', 'second task'], syntaurHome);
    const list = await readFile(resolve(syntaurHome, 'todos', '_global.md'), 'utf-8');
    const ids = [...list.matchAll(/\[t:([a-f0-9]{4})\]/g)].map((m) => m[1]);

    const res = await runCli(
      ['todo', 'promote', ids[0], ids[1], '--new-assignment', '--to-project', 'alpha', '--title', 'combined work'],
      syntaurHome,
    );
    expect(res.code).toBe(0);

    const assignmentsRoot = resolve(projectsDir, 'alpha', 'assignments');
    const { readdir } = await import('node:fs/promises');
    const dirs = await readdir(assignmentsRoot);
    expect(dirs.length).toBe(1);
    const assignmentMd = await readFile(
      resolve(assignmentsRoot, dirs[0], 'assignment.md'),
      'utf-8',
    );
    expect(assignmentMd).toContain('- [ ] first task');
    expect(assignmentMd).toContain('- [ ] second task');
  });

  it('--keep-source leaves source todos open', async () => {
    await seedProject('alpha');
    await runCli(['todo', 'add', 'keep me'], syntaurHome);
    const list = await readFile(resolve(syntaurHome, 'todos', '_global.md'), 'utf-8');
    const id = list.match(/\[t:([a-f0-9]{4})\]/)![1];

    const res = await runCli(
      ['todo', 'promote', id, '--new-assignment', '--to-project', 'alpha', '--keep-source'],
      syntaurHome,
    );
    expect(res.code).toBe(0);
    const after = await readFile(resolve(syntaurHome, 'todos', '_global.md'), 'utf-8');
    expect(after).toMatch(new RegExp(`- \\[ \\] keep me .*\\[t:${id}\\]`));
  });

  it('rejects when target project does not exist', async () => {
    await runCli(['todo', 'add', 'orphan'], syntaurHome);
    const list = await readFile(resolve(syntaurHome, 'todos', '_global.md'), 'utf-8');
    const id = list.match(/\[t:([a-f0-9]{4})\]/)![1];

    const res = await runCli(
      ['todo', 'promote', id, '--new-assignment', '--to-project', 'ghost'],
      syntaurHome,
    );
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/not found/i);
  });
});

describe('syntaur todo plan', () => {
  it('first call creates plan.md, sets planDir, prints path', async () => {
    await runCli(['todo', 'add', 'plannable'], syntaurHome);
    const list = await readFile(resolve(syntaurHome, 'todos', '_global.md'), 'utf-8');
    const id = list.match(/\[t:([a-f0-9]{4})\]/)![1];

    const res = await runCli(['todo', 'plan', id], syntaurHome);
    expect(res.code).toBe(0);
    const expected = resolve(syntaurHome, 'todos', 'plans', '_global', id, 'plan.md');
    expect(res.stdout.trim()).toBe(expected);
    expect(await pathExists(expected)).toBe(true);

    const checklist = await readFile(resolve(syntaurHome, 'todos', '_global.md'), 'utf-8');
    expect(checklist).toContain(`p=${resolve(syntaurHome, 'todos', 'plans', '_global', id)}`);
  });

  it('second call creates plan-v2.md', async () => {
    await runCli(['todo', 'add', 'multi-plan'], syntaurHome);
    const list = await readFile(resolve(syntaurHome, 'todos', '_global.md'), 'utf-8');
    const id = list.match(/\[t:([a-f0-9]{4})\]/)![1];

    await runCli(['todo', 'plan', id], syntaurHome);
    const res2 = await runCli(['todo', 'plan', id], syntaurHome);
    expect(res2.code).toBe(0);
    const expected2 = resolve(syntaurHome, 'todos', 'plans', '_global', id, 'plan-v2.md');
    expect(res2.stdout.trim()).toBe(expected2);
    expect(await pathExists(expected2)).toBe(true);
  });
});

describe('syntaur todo promote --to-assignment', () => {
  async function seedAssignment(projectSlug: string, assignmentSlug: string): Promise<void> {
    const aDir = resolve(projectsDir, projectSlug, 'assignments', assignmentSlug);
    await mkdir(aDir, { recursive: true });
    await writeFile(
      resolve(aDir, 'assignment.md'),
      `---\nid: a-id\nslug: ${assignmentSlug}\ntitle: existing\nproject: ${projectSlug}\nstatus: in_progress\nupdated: "2026-01-01T00:00:00Z"\n---\n\n# Existing\n\n## Objective\n\nfoo\n\n## Todos\n\n- [x] already done [t:0001]\n\n## Context\n\nbar\n`,
    );
  }

  it('appends todos to an existing assignment by project/slug', async () => {
    await seedProject('alpha');
    await seedAssignment('alpha', 'foo');
    await runCli(['todo', 'add', 'extra work'], syntaurHome);
    const list = await readFile(resolve(syntaurHome, 'todos', '_global.md'), 'utf-8');
    const id = list.match(/\[t:([a-f0-9]{4})\]/)![1];

    const res = await runCli(
      ['todo', 'promote', id, '--to-assignment', 'alpha/foo'],
      syntaurHome,
    );
    expect(res.code).toBe(0);
    const aMd = await readFile(
      resolve(projectsDir, 'alpha', 'assignments', 'foo', 'assignment.md'),
      'utf-8',
    );
    expect(aMd).toContain('- [ ] extra work');
    expect(aMd).toContain(`promoted from t:${id}`);
    expect(aMd).toContain('- [x] already done [t:0001]');
  });

  it('rejects re-promotion of an already-completed todo', async () => {
    await seedProject('alpha');
    await seedAssignment('alpha', 'foo');
    await runCli(['todo', 'add', 'once'], syntaurHome);
    const list = await readFile(resolve(syntaurHome, 'todos', '_global.md'), 'utf-8');
    const id = list.match(/\[t:([a-f0-9]{4})\]/)![1];
    const first = await runCli(['todo', 'promote', id, '--to-assignment', 'alpha/foo'], syntaurHome);
    expect(first.code).toBe(0);
    const second = await runCli(['todo', 'promote', id, '--to-assignment', 'alpha/foo'], syntaurHome);
    expect(second.code).not.toBe(0);
    expect(second.stderr).toMatch(/already completed/i);
  });

  it('rejects when target syntax is invalid', async () => {
    await runCli(['todo', 'add', 'x'], syntaurHome);
    const list = await readFile(resolve(syntaurHome, 'todos', '_global.md'), 'utf-8');
    const id = list.match(/\[t:([a-f0-9]{4})\]/)![1];

    const res = await runCli(
      ['todo', 'promote', id, '--to-assignment', 'just-a-string'],
      syntaurHome,
    );
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/Invalid --to-assignment target/);
  });
});

describe('syntaur todo move', () => {
  function extractMetaField(line: string, key: string): string | undefined {
    const m = line.match(/<([^>]*)>/);
    if (!m) return undefined;
    const body = m[1];
    const parts = body.split(';');
    for (const p of parts) {
      const eq = p.indexOf('=');
      if (eq === -1) continue;
      if (p.slice(0, eq) === key) return p.slice(eq + 1);
    }
    return undefined;
  }

  function getItemLine(content: string, id: string): string | undefined {
    return content.split('\n').find((l) => l.includes(`[t:${id}]`));
  }

  it('moves a workspace todo to a project, preserving id/timestamps', async () => {
    await seedProject('alpha');
    await runCli(['todo', 'add', 'movable', '--workspace', 'src'], syntaurHome);
    const sourceBefore = await readFile(resolve(syntaurHome, 'todos', 'src.md'), 'utf-8');
    const id = sourceBefore.match(/\[t:([a-f0-9]{4})\]/)![1];
    const beforeLine = getItemLine(sourceBefore, id)!;
    const beforeCreated = extractMetaField(beforeLine, 'c');
    const beforeUpdated = extractMetaField(beforeLine, 'u');

    const res = await runCli(
      ['todo', 'move', id, '--to-project', 'alpha', '--workspace', 'src'],
      syntaurHome,
    );
    expect(res.code).toBe(0);

    const sourceAfter = await readFile(resolve(syntaurHome, 'todos', 'src.md'), 'utf-8');
    expect(sourceAfter).not.toContain(`[t:${id}]`);

    const targetAfter = await readFile(
      resolve(projectsDir, 'alpha', 'todos', 'alpha.md'),
      'utf-8',
    );
    expect(targetAfter).toContain(`[t:${id}]`);
    const afterLine = getItemLine(targetAfter, id)!;
    expect(extractMetaField(afterLine, 'c')).toBe(beforeCreated);
    expect(extractMetaField(afterLine, 'u')).toBe(beforeUpdated);

    // Both logs touched
    const srcLog = await readFile(resolve(syntaurHome, 'todos', 'src-log.md'), 'utf-8');
    expect(srcLog).toMatch(/Moved to project:alpha/);
    const tgtLog = await readFile(
      resolve(projectsDir, 'alpha', 'todos', 'alpha-log.md'),
      'utf-8',
    );
    expect(tgtLog).toMatch(/Moved from workspace:src/);
  });

  it('relocates plan dir on disk and updates planDir absolute path', async () => {
    await seedProject('alpha');
    await runCli(['todo', 'add', 'with-plan', '--workspace', 'src'], syntaurHome);
    const list = await readFile(resolve(syntaurHome, 'todos', 'src.md'), 'utf-8');
    const id = list.match(/\[t:([a-f0-9]{4})\]/)![1];

    await runCli(['todo', 'plan', id, '--workspace', 'src'], syntaurHome);
    const oldPlanDir = resolve(syntaurHome, 'todos', 'plans', 'src', id);
    expect(await pathExists(oldPlanDir)).toBe(true);

    const res = await runCli(
      ['todo', 'move', id, '--to-project', 'alpha', '--workspace', 'src'],
      syntaurHome,
    );
    expect(res.code).toBe(0);

    const newPlanDir = resolve(projectsDir, 'alpha', 'todos', 'plans', 'alpha', id);
    expect(await pathExists(oldPlanDir)).toBe(false);
    expect(await pathExists(newPlanDir)).toBe(true);

    const targetMd = await readFile(resolve(projectsDir, 'alpha', 'todos', 'alpha.md'), 'utf-8');
    const line = targetMd.split('\n').find((l) => l.includes(`[t:${id}]`))!;
    const meta = line.match(/<([^>]*)>/)![1];
    expect(meta).toContain(`p=${newPlanDir}`);
  });

  it('refuses on plan-dir collision in target', async () => {
    await seedProject('alpha');
    await runCli(['todo', 'add', 'with-plan', '--workspace', 'src'], syntaurHome);
    const list = await readFile(resolve(syntaurHome, 'todos', 'src.md'), 'utf-8');
    const id = list.match(/\[t:([a-f0-9]{4})\]/)![1];
    await runCli(['todo', 'plan', id, '--workspace', 'src'], syntaurHome);

    // Pre-create the destination plan dir
    const dest = resolve(projectsDir, 'alpha', 'todos', 'plans', 'alpha', id);
    await mkdir(dest, { recursive: true });

    const res = await runCli(
      ['todo', 'move', id, '--to-project', 'alpha', '--workspace', 'src'],
      syntaurHome,
    );
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/already exists at target/i);

    // Source unchanged
    const sourceAfter = await readFile(resolve(syntaurHome, 'todos', 'src.md'), 'utf-8');
    expect(sourceAfter).toContain(`[t:${id}]`);
  });

  it('refuses on id collision in target', async () => {
    await seedProject('alpha');
    // Add a todo to source workspace
    await runCli(['todo', 'add', 'src item', '--workspace', 'src'], syntaurHome);
    const srcList = await readFile(resolve(syntaurHome, 'todos', 'src.md'), 'utf-8');
    const id = srcList.match(/\[t:([a-f0-9]{4})\]/)![1];

    // Manually craft a colliding entry in the target project
    await mkdir(resolve(projectsDir, 'alpha', 'todos'), { recursive: true });
    await writeFile(
      resolve(projectsDir, 'alpha', 'todos', 'alpha.md'),
      `---\nworkspace: alpha\narchiveInterval: weekly\n---\n\n# Quick Todos\n\n- [ ] colliding [t:${id}]\n`,
    );

    const res = await runCli(
      ['todo', 'move', id, '--to-project', 'alpha', '--workspace', 'src'],
      syntaurHome,
    );
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/already exists in target/i);
  });

  it('rejects same-scope moves', async () => {
    await runCli(['todo', 'add', 'x', '--workspace', 'src'], syntaurHome);
    const list = await readFile(resolve(syntaurHome, 'todos', 'src.md'), 'utf-8');
    const id = list.match(/\[t:([a-f0-9]{4})\]/)![1];

    const res = await runCli(
      ['todo', 'move', id, '--to-workspace', 'src', '--workspace', 'src'],
      syntaurHome,
    );
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/same/i);
  });

  it('moves project A → project B', async () => {
    await seedProject('alpha');
    await seedProject('beta');
    await runCli(['todo', 'add', 'crossp', '--project', 'alpha'], syntaurHome);
    const aMd = await readFile(resolve(projectsDir, 'alpha', 'todos', 'alpha.md'), 'utf-8');
    const id = aMd.match(/\[t:([a-f0-9]{4})\]/)![1];

    const res = await runCli(
      ['todo', 'move', id, '--to-project', 'beta', '--project', 'alpha'],
      syntaurHome,
    );
    expect(res.code).toBe(0);

    const aAfter = await readFile(resolve(projectsDir, 'alpha', 'todos', 'alpha.md'), 'utf-8');
    expect(aAfter).not.toContain(`[t:${id}]`);
    const bAfter = await readFile(resolve(projectsDir, 'beta', 'todos', 'beta.md'), 'utf-8');
    expect(bAfter).toContain(`[t:${id}]`);
  });

  it('moves workspace → global', async () => {
    await runCli(['todo', 'add', 'globe', '--workspace', 'src'], syntaurHome);
    const list = await readFile(resolve(syntaurHome, 'todos', 'src.md'), 'utf-8');
    const id = list.match(/\[t:([a-f0-9]{4})\]/)![1];

    const res = await runCli(
      ['todo', 'move', id, '--to-global', '--workspace', 'src'],
      syntaurHome,
    );
    expect(res.code).toBe(0);

    const srcAfter = await readFile(resolve(syntaurHome, 'todos', 'src.md'), 'utf-8');
    expect(srcAfter).not.toContain(`[t:${id}]`);
    const gAfter = await readFile(resolve(syntaurHome, 'todos', '_global.md'), 'utf-8');
    expect(gAfter).toContain(`[t:${id}]`);
  });
});
