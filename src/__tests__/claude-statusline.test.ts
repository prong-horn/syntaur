import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const hookPath = resolve(here, '../../statusline/statusline.sh');

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
  it('renders the full session id when cwd is not a git repo and no context.json exists', () => {
    const res = runHook(
      JSON.stringify({
        session_id: 'aaaaaaaaaaaaaaaaaaaaaaaa99887766',
        cwd: sandbox,
      }),
    );
    expect(res.status).toBe(0);
    // No branch, no worktree, no ticket — just the full session id.
    expect(res.stdout).toBe('aaaaaaaaaaaaaaaaaaaaaaaa99887766');
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
    // Matches: feat/demo · <basename> · <full session id>
    expect(res.stdout).toContain('feat/demo');
    expect(res.stdout).toContain('zzzzzzzzzzzzzzzzzzzzzzzz12345678');
    // Worktree basename is the tmpdir leaf (mkdtemp's prefix).
    const leaf = sandbox.split('/').pop()!;
    expect(res.stdout).toContain(leaf);
    expect(res.stdout).toMatch(/ · /);
  });

  it('renders project/ticket label with title for a project-nested context.json', async () => {
    gitInit(sandbox);
    const ticketDir = resolve(sandbox, 'proj', 'tickets', 'DEMO-1-demo-assn');
    await mkdir(ticketDir, { recursive: true });
    await writeFile(
      resolve(ticketDir, 'ticket.md'),
      '---\nid: DEMO-1\nslug: demo-assn\ntitle: "Demo Ticket"\nstatus: in_progress\n---\n',
    );
    await mkdir(resolve(sandbox, '.syntaur'), { recursive: true });
    await writeFile(
      resolve(sandbox, '.syntaur', 'context.json'),
      JSON.stringify({
        ticketId: 'DEMO-1',
        ticketDir,
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
    expect(res.stdout).toContain('DEMO-1 — Demo Ticket');
    expect(res.stdout).toContain('yyyyyyyyyyyyyyyyyyyyyyyy0a0b0c0d');
  });

  it('renders a ticket id label with title from context.json', async () => {
    gitInit(sandbox);
    const ticketDir = resolve(sandbox, 'proj', 'tickets', 'SOLO-1-solo');
    await mkdir(ticketDir, { recursive: true });
    await writeFile(
      resolve(ticketDir, 'ticket.md'),
      '---\nid: SOLO-1\nslug: solo\ntitle: "Solo Standalone"\nstatus: in_progress\n---\n',
    );
    await mkdir(resolve(sandbox, '.syntaur'), { recursive: true });
    await writeFile(
      resolve(sandbox, '.syntaur', 'context.json'),
      JSON.stringify({
        ticketId: 'SOLO-1',
        ticketDir,
      }),
    );

    const res = runHook(
      JSON.stringify({
        session_id: 'ssssssssssssssssssssssss11223344',
        cwd: sandbox,
      }),
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('SOLO-1 — Solo Standalone');
    expect(res.stdout).toContain('ssssssssssssssssssssssss11223344');
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
