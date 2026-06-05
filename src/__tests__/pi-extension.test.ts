import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import activate, {
  isWriteAllowed,
  extractWritePath,
  loadContext,
  CORE_COMMANDS,
} from '../../platforms/pi/extensions/syntaur/index';

const CTX = {
  assignmentDir: '/work/assign',
  projectDir: '/proj',
  workspaceRoot: '/ws',
};

describe('pi extension — isWriteAllowed (mirrors the bash boundary hook)', () => {
  it('allows writes under the assignment dir', () => {
    expect(isWriteAllowed('/work/assign/plan.md', CTX).allowed).toBe(true);
  });
  it('blocks writes outside every boundary', () => {
    const r = isWriteAllowed('/etc/passwd', CTX);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/write boundary violation/);
  });
  it('allows project resources/memories but blocks derived _ files', () => {
    expect(isWriteAllowed('/proj/resources/foo.md', CTX).allowed).toBe(true);
    expect(isWriteAllowed('/proj/resources/_index.md', CTX).allowed).toBe(false);
    expect(isWriteAllowed('/proj/memories/note.md', CTX).allowed).toBe(true);
    expect(isWriteAllowed('/proj/memories/_index.md', CTX).allowed).toBe(false);
  });
  it('allows writes under the workspace root', () => {
    expect(isWriteAllowed('/ws/src/app.ts', CTX).allowed).toBe(true);
  });
  it('does NOT mis-allow a sibling with a shared prefix (/foo vs /foobar)', () => {
    expect(isWriteAllowed('/work/assignment-other/x', CTX).allowed).toBe(false);
    expect(isWriteAllowed('/ws-extra/x', CTX).allowed).toBe(false);
  });
  it('allows the context file itself', () => {
    expect(isWriteAllowed('/cwd/.syntaur/context.json', CTX, '/cwd/.syntaur/context.json').allowed).toBe(
      true,
    );
  });
  it('fails OPEN when required context fields are missing (bash parity)', () => {
    // Mirror enforce-boundaries.sh:69 — enforcement needs BOTH assignmentDir and
    // projectDir; a missing/partial context allows everything.
    expect(isWriteAllowed('/anywhere', {}).allowed).toBe(true);
    expect(isWriteAllowed('/anywhere', { assignmentDir: '/work/assign' }).allowed).toBe(true);
    expect(isWriteAllowed('/anywhere', { projectDir: '/proj' }).allowed).toBe(true);
  });
});

describe('pi extension — extractWritePath', () => {
  it('returns the path for write tools (case-insensitive)', () => {
    expect(extractWritePath('edit', { file_path: '/x' })).toBe('/x');
    expect(extractWritePath('WRITE', { path: '/y' })).toBe('/y');
    expect(extractWritePath('apply_patch', { target_file: '/z' })).toBe('/z');
  });
  it('returns null for non-write tools and missing paths', () => {
    expect(extractWritePath('read', { file_path: '/x' })).toBeNull();
    expect(extractWritePath('bash', { command: 'ls' })).toBeNull();
    expect(extractWritePath('edit', {})).toBeNull();
  });
});

describe('pi extension — CORE_COMMANDS shape', () => {
  it('passthrough entries have argv (real subcommand) and no skill; guidance the inverse', () => {
    for (const c of CORE_COMMANDS) {
      if (c.kind === 'passthrough') {
        expect(Array.isArray(c.argv)).toBe(true);
        expect(c.argv!.length).toBeGreaterThan(0);
        expect(c.skill).toBeUndefined();
      } else {
        expect(typeof c.skill).toBe('string');
        expect(c.argv).toBeUndefined();
      }
    }
  });
  it('the only passthrough is doctor-syntaur → syntaur doctor', () => {
    const pass = CORE_COMMANDS.filter((c) => c.kind === 'passthrough');
    expect(pass).toHaveLength(1);
    expect(pass[0].name).toBe('doctor-syntaur');
    expect(pass[0].argv).toEqual(['doctor']);
  });
});

describe('pi extension — loadContext + activate registration', () => {
  it('loadContext reads .syntaur/context.json and null when absent', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'pi-ctx-'));
    try {
      expect(loadContext(tmp)).toBeNull();
      await mkdir(join(tmp, '.syntaur'), { recursive: true });
      await writeFile(
        join(tmp, '.syntaur', 'context.json'),
        JSON.stringify({ assignmentDir: '/a', sessionId: 's1', projectSlug: 'p' }),
      );
      const ctx = loadContext(tmp);
      expect(ctx?.assignmentDir).toBe('/a');
      expect(ctx?.sessionId).toBe('s1');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('activate registers tool_call + session_shutdown + commands and the blocker works', async () => {
    const handlers: Record<string, (e: unknown, c?: unknown) => unknown> = {};
    const commands: string[] = [];
    activate({
      on: (e, h) => {
        handlers[e] = h;
      },
      registerCommand: (name) => {
        commands.push(name);
      },
    });
    expect(typeof handlers.tool_call).toBe('function');
    expect(typeof handlers.session_shutdown).toBe('function');
    expect(commands).toContain('doctor-syntaur');
    expect(commands).toContain('grab-assignment');

    const tmp = await mkdtemp(join(tmpdir(), 'pi-act-'));
    const assignmentDir = join(tmp, 'assign');
    await mkdir(assignmentDir, { recursive: true });
    await mkdir(join(tmp, '.syntaur'), { recursive: true });
    await writeFile(
      join(tmp, '.syntaur', 'context.json'),
      JSON.stringify({ assignmentDir, projectDir: join(tmp, 'proj'), workspaceRoot: assignmentDir }),
    );
    const prevCwd = process.cwd();
    process.chdir(tmp);
    try {
      const blocked = await handlers.tool_call({ toolName: 'edit', input: { file_path: '/etc/passwd' } });
      expect(blocked).toMatchObject({ block: true });
      const allowed = await handlers.tool_call({
        toolName: 'edit',
        input: { file_path: join(assignmentDir, 'x.md') },
      });
      expect(allowed).toBeUndefined();
      const nonwrite = await handlers.tool_call({ toolName: 'read', input: { file_path: '/etc/passwd' } });
      expect(nonwrite).toBeUndefined();
    } finally {
      process.chdir(prevCwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
