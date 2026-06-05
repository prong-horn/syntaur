import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

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
      '# fail OPEN when required context fields are missing (bash parity)',
      'assert boundary.is_write_allowed("/anywhere", {})[0] is True',
      'assert boundary.is_write_allowed("/anywhere", {"assignmentDir": "/work/assign"})[0] is True',
      'assert boundary.is_write_allowed("/anywhere", {"projectDir": "/proj"})[0] is True',
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
});
