import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const hookPath = resolve(
  here,
  '../../platforms/claude-code/hooks/statusline.sh',
);

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-hook-status-'));
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

function runHook(stdinJson: string, env: Record<string, string> = {}) {
  return spawnSync('bash', [hookPath], {
    input: stdinJson,
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: sandbox,
      ...env,
    },
  });
}

function gitInit(dir: string): void {
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init', '-q'], {
    cwd: dir,
  });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'checkout', '-q', '-B', 'feat/demo'], {
    cwd: dir,
  });
}

describe('claude-code statusline.sh', () => {
  it('renders only the session id suffix when cwd is not a git repo and no context.json exists', () => {
    const res = runHook(
      JSON.stringify({
        session_id: 'aaaaaaaaaaaaaaaaaaaaaaaa99887766',
        cwd: sandbox,
      }),
    );
    expect(res.status).toBe(0);
    // No branch, no worktree, no assignment — just the session suffix.
    expect(res.stdout).toBe('…99887766');
  });

  it('renders branch and worktree basename for a git cwd without context.json', () => {
    gitInit(sandbox);
    const res = runHook(
      JSON.stringify({
        session_id: 'zzzzzzzzzzzzzzzzzzzzzzzz12345678',
        cwd: sandbox,
      }),
    );
    expect(res.status).toBe(0);
    // Matches: feat/demo · <basename> · …12345678
    expect(res.stdout).toContain('feat/demo');
    expect(res.stdout).toContain('…12345678');
    // Worktree basename is the tmpdir leaf (mkdtemp's prefix).
    const leaf = sandbox.split('/').pop()!;
    expect(res.stdout).toContain(leaf);
    expect(res.stdout).toMatch(/ · /);
  });

  it('renders project/assignment label with title for a project-nested context.json', async () => {
    gitInit(sandbox);
    const assignmentDir = resolve(sandbox, 'proj', 'assignments', 'demo-assn');
    await mkdir(assignmentDir, { recursive: true });
    await writeFile(
      resolve(assignmentDir, 'assignment.md'),
      '---\nid: 00000000-0000-0000-0000-000000000000\nslug: demo-assn\ntitle: "Demo Assignment"\nstatus: in_progress\n---\n',
    );
    await mkdir(resolve(sandbox, '.syntaur'), { recursive: true });
    await writeFile(
      resolve(sandbox, '.syntaur', 'context.json'),
      JSON.stringify({
        projectSlug: 'my-proj',
        assignmentSlug: 'demo-assn',
        assignmentDir,
      }),
    );

    const res = runHook(
      JSON.stringify({
        session_id: 'yyyyyyyyyyyyyyyyyyyyyyyy0a0b0c0d',
        cwd: sandbox,
      }),
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('feat/demo');
    expect(res.stdout).toContain('my-proj/demo-assn — Demo Assignment');
    expect(res.stdout).toContain('…0a0b0c0d');
  });

  it('renders a standalone UUID label with title when projectSlug is absent', async () => {
    gitInit(sandbox);
    const uuid = '12345678-9abc-def0-1234-56789abcdef0';
    const assignmentDir = resolve(sandbox, 'standalone-dir');
    await mkdir(assignmentDir, { recursive: true });
    await writeFile(
      resolve(assignmentDir, 'assignment.md'),
      `---\nid: ${uuid}\nslug: ${uuid}\ntitle: "Solo Standalone"\nstatus: in_progress\nproject: null\n---\n`,
    );
    await mkdir(resolve(sandbox, '.syntaur'), { recursive: true });
    await writeFile(
      resolve(sandbox, '.syntaur', 'context.json'),
      JSON.stringify({
        projectSlug: null,
        assignmentSlug: uuid,
        assignmentDir,
      }),
    );

    const res = runHook(
      JSON.stringify({
        session_id: 'ssssssssssssssssssssssss11223344',
        cwd: sandbox,
      }),
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`standalone/${uuid.slice(0, 8)} — Solo Standalone`);
    expect(res.stdout).toContain('…11223344');
  });

  it('degrades to a marker string and still exits 0 when jq is unavailable', async () => {
    // Build a PATH sandbox that has bash (and its minimum transitive deps)
    // but does NOT have jq. The hook runs under `bash [scriptPath]`, so we
    // only need enough of PATH for the script's internal `command -v jq` /
    // `printf` / `[ ... ]` builtins — those are bash builtins and work
    // without PATH. But `basename` and `awk` are external; they're not
    // reached in this case because we exit before git / awk calls.
    const pathDir = resolve(sandbox, 'bin');
    await mkdir(pathDir, { recursive: true });
    // Symlink bash only. Everything else on PATH is absent — notably jq.
    const realBash = spawnSync('bash', ['-c', 'command -v bash'], {
      encoding: 'utf-8',
    }).stdout.trim();
    await symlink(realBash || '/bin/bash', resolve(pathDir, 'bash'));

    const res = runHook(
      JSON.stringify({
        session_id: 'xxxx',
        cwd: sandbox,
      }),
      { PATH: pathDir },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('(syntaur: jq missing)');
  });
});
