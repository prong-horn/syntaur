import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const PLUGIN_DIR = fileURLToPath(
  new URL('../../platforms/hermes/plugins/syntaur', import.meta.url),
);

function hasPython3(): boolean {
  const r = spawnSync('python3', ['--version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

const py = hasPython3();
const describeIf = py ? describe : describe.skip;

describe('hermes plugin — static structure', () => {
  it('plugin.yaml declares both hooks', () => {
    const yaml = readFileSync(join(PLUGIN_DIR, 'plugin.yaml'), 'utf-8');
    expect(yaml).toMatch(/name:\s*syntaur/);
    expect(yaml).toMatch(/pre_tool_call/);
    expect(yaml).toMatch(/on_session_end/);
  });
  it('__init__.py exports register(ctx)', () => {
    const init = readFileSync(join(PLUGIN_DIR, '__init__.py'), 'utf-8');
    expect(init).toMatch(/def register\(ctx\)/);
    expect(init).toMatch(/register_hook\(["']pre_tool_call["']/);
    expect(init).toMatch(/register_hook\(["']on_session_end["']/);
  });
});

describeIf('hermes plugin — python (py_compile + behavioral)', () => {
  it('all .py files compile', () => {
    const r = spawnSync(
      'python3',
      ['-m', 'py_compile', join(PLUGIN_DIR, 'boundary.py'), join(PLUGIN_DIR, '__init__.py')],
      { encoding: 'utf-8' },
    );
    expect(r.status, r.stderr).toBe(0);
  });

  it('boundary.is_write_allowed matches the bash boundary rules', () => {
    const harness = [
      'import sys, os',
      'sys.path.insert(0, os.environ["PLUGIN_DIR"])',
      'import boundary',
      'ctx = {"assignmentDir": "/work/assign", "projectDir": "/proj", "workspaceRoot": "/ws"}',
      'assert boundary.is_write_allowed("/work/assign/plan.md", ctx)[0] is True',
      'assert boundary.is_write_allowed("/etc/passwd", ctx)[0] is False',
      'assert boundary.is_write_allowed("/proj/resources/foo.md", ctx)[0] is True',
      'assert boundary.is_write_allowed("/proj/resources/_index.md", ctx)[0] is False',
      'assert boundary.is_write_allowed("/proj/memories/note.md", ctx)[0] is True',
      'assert boundary.is_write_allowed("/proj/memories/_index.md", ctx)[0] is False',
      'assert boundary.is_write_allowed("/ws/src/app.py", ctx)[0] is True',
      'assert boundary.is_write_allowed("/work/assignment-other/x", ctx)[0] is False',
      '# NO fail-open after the context.json demotion: missing assignment/project',
      '# fields narrow the allowlist, they do not disable enforcement.',
      'assert boundary.is_write_allowed("/anywhere", {})[0] is False',
      '# workspace-only enforcement via the workspaceRoot marker (no engagement)',
      'assert boundary.is_write_allowed("/ws/src/app.py", {"workspaceRoot": "/ws"})[0] is True',
      'assert boundary.is_write_allowed("/outside/x", {"workspaceRoot": "/ws"})[0] is False',
      '# assignmentDir-only still allows writes under it, blocks elsewhere',
      'assert boundary.is_write_allowed("/work/assign/x", {"assignmentDir": "/work/assign"})[0] is True',
      'assert boundary.is_write_allowed("/anywhere", {"assignmentDir": "/work/assign"})[0] is False',
      'print("OK")',
    ].join('\n');
    const r = spawnSync('python3', ['-c', harness], {
      encoding: 'utf-8',
      env: { ...process.env, PLUGIN_DIR },
    });
    expect(r.stderr).toBe('');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('OK');
  });

  it('_on_pre_tool_call resolves the boundary from the engagement via `syntaur session boundary`', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hermes-boundary-'));
    try {
      const ws = join(tmp, 'ws');
      const pdir = join(tmp, 'home', 'projects', 'p');
      const adir = join(pdir, 'assignments', 'a');
      mkdirSync(join(ws, '.syntaur'), { recursive: true });
      mkdirSync(adir, { recursive: true });
      // Marker-only context.json — NO assignment scalars (the demoted shape).
      writeFileSync(
        join(ws, '.syntaur', 'context.json'),
        JSON.stringify({ workspaceRoot: ws, sessionId: 'sid-x', repository: '/repo' }),
      );
      // Fake `syntaur` on PATH that returns the engagement-resolved boundary.
      const binDir = join(tmp, 'bin');
      mkdirSync(binDir);
      const fake = join(binDir, 'syntaur');
      writeFileSync(
        fake,
        `#!/usr/bin/env bash\nprintf '%s' '{"assignmentDir":"${adir}","projectDir":"${pdir}","workspaceRoot":"${ws}"}'\n`,
      );
      chmodSync(fake, 0o755);

      const parent = dirname(PLUGIN_DIR);
      const harness = [
        'import sys',
        `sys.path.insert(0, ${JSON.stringify(parent)})`,
        'import syntaur',
        // write inside the engagement-resolved assignment dir → allowed (None)
        `r1 = syntaur._on_pre_tool_call(tool_name="write_file", args={"path": ${JSON.stringify(
          join(adir, 'progress.md'),
        )}})`,
        'assert r1 is None, r1',
        // write under project resources/ → allowed
        `r2 = syntaur._on_pre_tool_call(tool_name="write_file", args={"path": ${JSON.stringify(
          join(pdir, 'resources', 'doc.md'),
        )}})`,
        'assert r2 is None, r2',
        // write inside the workspace → allowed
        `r3 = syntaur._on_pre_tool_call(tool_name="write_file", args={"path": ${JSON.stringify(
          join(ws, 'src', 'x.py'),
        )}})`,
        'assert r3 is None, r3',
        // write outside everything → BLOCKED (no fail-open)
        'r4 = syntaur._on_pre_tool_call(tool_name="write_file", args={"path": "/etc/passwd"})',
        'assert isinstance(r4, dict) and r4.get("allow") is False, r4',
        'print("OK")',
      ].join('\n');
      const r = spawnSync('python3', ['-c', harness], {
        encoding: 'utf-8',
        cwd: ws,
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
      });
      // The intentional /etc/passwd block logs a violation to stderr — expected.
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim()).toBe('OK');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does NOT leak stale legacy context.json scalars when boundary resolution fails ({})', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hermes-stale-'));
    try {
      const ws = join(tmp, 'ws');
      const staleAssign = join(tmp, 'stale', 'assign');
      const staleProj = join(tmp, 'stale', 'proj');
      mkdirSync(join(ws, '.syntaur'), { recursive: true });
      mkdirSync(staleAssign, { recursive: true });
      // LEGACY context.json carrying STALE assignment/project scalars (pre-demotion).
      writeFileSync(
        join(ws, '.syntaur', 'context.json'),
        JSON.stringify({
          assignmentDir: staleAssign,
          projectDir: staleProj,
          workspaceRoot: ws,
          sessionId: 'sid-x',
        }),
      );
      // Fake `syntaur` that FAILS to resolve a boundary (returns {}).
      const binDir = join(tmp, 'bin');
      mkdirSync(binDir);
      const fake = join(binDir, 'syntaur');
      writeFileSync(fake, `#!/usr/bin/env bash\nprintf '%s' '{}'\n`);
      chmodSync(fake, 0o755);

      const parent = dirname(PLUGIN_DIR);
      const harness = [
        'import sys',
        `sys.path.insert(0, ${JSON.stringify(parent)})`,
        'import syntaur',
        // write under the STALE assignment dir → BLOCKED (scalar not surfaced; CLI returned {})
        `r1 = syntaur._on_pre_tool_call(tool_name="write_file", args={"path": ${JSON.stringify(
          join(staleAssign, 'x.md'),
        )}})`,
        'assert isinstance(r1, dict) and r1.get("allow") is False, r1',
        // write inside the workspace → ALLOWED (workspace-only via the marker)
        `r2 = syntaur._on_pre_tool_call(tool_name="write_file", args={"path": ${JSON.stringify(
          join(ws, 'src', 'x.py'),
        )}})`,
        'assert r2 is None, r2',
        'print("OK")',
      ].join('\n');
      const r = spawnSync('python3', ['-c', harness], {
        encoding: 'utf-8',
        cwd: ws,
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim()).toBe('OK');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
