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

function assignmentMd(opts: {
  id: string;
  slug: string;
  title: string;
  status: string;
  tags: string[];
  updated: string;
}): string {
  const tags = opts.tags.length
    ? '\n' + opts.tags.map((t) => `  - ${t}`).join('\n')
    : ' []';
  return `---
id: ${opts.id}
slug: ${opts.slug}
title: "${opts.title}"
project: p
status: ${opts.status}
priority: medium
created: "2026-04-01T00:00:00Z"
updated: "${opts.updated}"
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags:${tags}
---

Body.
`;
}

describe('syntaur ls', () => {
  let syntaurHome: string;

  beforeEach(async () => {
    syntaurHome = await mkdtemp(join(tmpdir(), 'syntaur-ls-'));
    const projectsDir = resolve(syntaurHome, 'projects');
    await mkdir(projectsDir, { recursive: true });
    await writeFile(
      resolve(syntaurHome, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\nonboarding:\n  completed: true\n---\n`,
    );
    const projDir = resolve(projectsDir, 'p');
    await mkdir(resolve(projDir, 'assignments'), { recursive: true });
    await writeFile(
      resolve(projDir, 'project.md'),
      '---\nid: pid\nslug: p\ntitle: "P"\nworkspace: null\n---\n',
    );
    const today = '2026-05-08T12:00:00Z';
    const old = '2025-01-01T12:00:00Z';
    for (const a of [
      { id: 'a1', slug: 'a-pending', status: 'pending', tags: ['x', 'y'], updated: today },
      { id: 'a2', slug: 'a-progress', status: 'in_progress', tags: ['x'], updated: today },
      { id: 'a3', slug: 'a-old', status: 'pending', tags: ['z'], updated: old },
    ]) {
      const adir = resolve(projDir, 'assignments', a.slug);
      await mkdir(adir, { recursive: true });
      await writeFile(
        resolve(adir, 'assignment.md'),
        assignmentMd({
          id: a.id,
          slug: a.slug,
          title: a.slug,
          status: a.status,
          tags: a.tags,
          updated: a.updated,
        }),
      );
    }
  });

  afterEach(async () => {
    await rm(syntaurHome, { recursive: true, force: true });
  });

  it('lists all assignments with --json', async () => {
    const r = await runCli(['ls', '--json'], syntaurHome);
    expect(r.code, r.stderr).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.assignments).toHaveLength(3);
  });

  it('filters by --status', async () => {
    const r = await runCli(['ls', '--status', 'pending', '--json'], syntaurHome);
    expect(r.code, r.stderr).toBe(0);
    const data = JSON.parse(r.stdout);
    const slugs = data.assignments.map((a: { slug: string }) => a.slug).sort();
    expect(slugs).toEqual(['a-old', 'a-pending']);
  });

  it('filters by --age', async () => {
    const r = await runCli(['ls', '--age', '30d', '--json'], syntaurHome);
    expect(r.code, r.stderr).toBe(0);
    const data = JSON.parse(r.stdout);
    const slugs = data.assignments.map((a: { slug: string }) => a.slug).sort();
    expect(slugs).toEqual(['a-pending', 'a-progress']);
  });

  it('filters by --tag (must have ALL listed tags)', async () => {
    const r = await runCli(['ls', '--tag', 'x,y', '--json'], syntaurHome);
    expect(r.code, r.stderr).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.assignments).toHaveLength(1);
    expect(data.assignments[0].slug).toBe('a-pending');
  });
});
