import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import activate, {
  isWriteAllowed,
  extractWritePath,
  loadContext,
  resolveBoundary,
  CORE_COMMANDS,
} from '../../platforms/pi/extensions/syntaur/index';

/**
 * Install a fake `syntaur` on PATH that prints the given boundary JSON for
 * `session boundary`, so `resolveBoundary` (which shells out) is hermetic and
 * never invokes the real/global CLI. Returns the original PATH for restoration.
 */
async function withFakeSyntaur(binDir: string, boundaryJson: string): Promise<string> {
  const script = `#!/usr/bin/env bash\nif [ "$1" = "session" ] && [ "$2" = "boundary" ]; then\n  echo '${boundaryJson}'\n  exit 0\nfi\nexit 0\n`;
  const scriptPath = join(binDir, 'syntaur');
  await writeFile(scriptPath, script);
  await chmod(scriptPath, 0o755);
  const prevPath = process.env.PATH ?? '';
  process.env.PATH = binDir + delimiter + prevPath;
  return prevPath;
}

// A fully-resolved boundary (assignment + project + workspace), as the CLI's
// `session boundary` would emit for an open project-nested engagement.
const BOUNDARY = {
  assignmentDir: '/work/assign',
  projectDir: '/proj',
  workspaceRoot: '/ws',
};

describe('pi extension — isWriteAllowed (mirrors the bash boundary hook)', () => {
  it('allows writes under the assignment dir', () => {
    expect(isWriteAllowed('/work/assign/plan.md', BOUNDARY).allowed).toBe(true);
  });
  it('blocks writes outside every boundary', () => {
    const r = isWriteAllowed('/etc/passwd', BOUNDARY);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/write boundary violation/);
  });
  it('allows project resources/memories but blocks derived _ files', () => {
    expect(isWriteAllowed('/proj/resources/foo.md', BOUNDARY).allowed).toBe(true);
    expect(isWriteAllowed('/proj/resources/_index.md', BOUNDARY).allowed).toBe(false);
    expect(isWriteAllowed('/proj/memories/note.md', BOUNDARY).allowed).toBe(true);
    expect(isWriteAllowed('/proj/memories/_index.md', BOUNDARY).allowed).toBe(false);
  });
  it('allows writes under the workspace root', () => {
    expect(isWriteAllowed('/ws/src/app.ts', BOUNDARY).allowed).toBe(true);
  });
  it('does NOT mis-allow a sibling with a shared prefix (/foo vs /foobar)', () => {
    expect(isWriteAllowed('/work/assignment-other/x', BOUNDARY).allowed).toBe(false);
    expect(isWriteAllowed('/ws-extra/x', BOUNDARY).allowed).toBe(false);
  });
  it('allows the context file itself', () => {
    expect(
      isWriteAllowed('/cwd/.syntaur/context.json', BOUNDARY, '/cwd/.syntaur/context.json').allowed,
    ).toBe(true);
  });

  // The regression this rewrite fixes: NO fail-open. With no assignment/project
  // resolved (no open engagement) the boundary degrades to WORKSPACE-ONLY — it
  // must still BLOCK writes outside the workspace, not allow everything.
  it('enforces WORKSPACE-ONLY when no assignment/project resolves (no fail-open)', () => {
    const wsOnly = { workspaceRoot: '/ws' };
    expect(isWriteAllowed('/ws/src/app.ts', wsOnly).allowed).toBe(true);
    const blocked = isWriteAllowed('/etc/passwd', wsOnly);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/No active assignment/);
  });
  it('blocks everything (except the context file) when the boundary is entirely empty', () => {
    // No assignment, no project, no workspace → nothing matches but the context
    // file gate. An EMPTY dir must NOT glob to "/" and allow the filesystem.
    expect(isWriteAllowed('/anywhere', {}).allowed).toBe(false);
    expect(isWriteAllowed('/anywhere', { assignmentDir: '/work/assign' }).allowed).toBe(false);
    expect(isWriteAllowed('/work/assign/x', { assignmentDir: '/work/assign' }).allowed).toBe(true);
    // The context file is still always writable even with an empty boundary.
    expect(
      isWriteAllowed('/cwd/.syntaur/context.json', {}, '/cwd/.syntaur/context.json').allowed,
    ).toBe(true);
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
  it('loadContext reads ONLY workspace markers (assignment scalars demoted) and null when absent', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'pi-ctx-'));
    try {
      expect(loadContext(tmp)).toBeNull();
      await mkdir(join(tmp, '.syntaur'), { recursive: true });
      await writeFile(
        join(tmp, '.syntaur', 'context.json'),
        // assignmentDir is a demoted scalar — loadContext must NOT surface it.
        JSON.stringify({ assignmentDir: '/a', workspaceRoot: '/ws', sessionId: 's1', projectSlug: 'p' }),
      );
      const ctx = loadContext(tmp);
      expect(ctx?.sessionId).toBe('s1');
      expect(ctx?.workspaceRoot).toBe('/ws');
      expect(ctx?.projectSlug).toBe('p');
      // The demoted assignment scalar is no longer part of SyntaurContext.
      expect((ctx as Record<string, unknown>).assignmentDir).toBeUndefined();
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
    // context.json is the workspace MARKER only; the assignment boundary is
    // resolved from the engagement via the (faked) `syntaur session boundary`.
    await writeFile(
      join(tmp, '.syntaur', 'context.json'),
      JSON.stringify({ workspaceRoot: tmp }),
    );
    const binDir = await mkdtemp(join(tmpdir(), 'pi-bin-'));
    const prevPath = await withFakeSyntaur(
      binDir,
      JSON.stringify({ assignmentDir, projectDir: join(tmp, 'proj'), workspaceRoot: tmp }),
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
      process.env.PATH = prevPath;
      await rm(tmp, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  });

  it('tool_call enforces WORKSPACE-ONLY (no fail-open) when the CLI resolves no assignment', async () => {
    const handlers: Record<string, (e: unknown, c?: unknown) => unknown> = {};
    activate({ on: (e, h) => (handlers[e] = h), registerCommand: () => {} });

    const tmp = await mkdtemp(join(tmpdir(), 'pi-wsonly-'));
    await mkdir(join(tmp, '.syntaur'), { recursive: true });
    await writeFile(join(tmp, '.syntaur', 'context.json'), JSON.stringify({ workspaceRoot: tmp }));
    const binDir = await mkdtemp(join(tmpdir(), 'pi-bin-'));
    // No open engagement → the CLI returns only the workspace marker.
    const prevPath = await withFakeSyntaur(binDir, JSON.stringify({ workspaceRoot: tmp }));
    const prevCwd = process.cwd();
    process.chdir(tmp);
    try {
      // Inside the workspace → allowed.
      const inWs = await handlers.tool_call({
        toolName: 'edit',
        input: { file_path: join(tmp, 'src', 'app.ts') },
      });
      expect(inWs).toBeUndefined();
      // Outside the workspace → BLOCKED (the regression: must NOT fail open).
      const out = await handlers.tool_call({
        toolName: 'edit',
        input: { file_path: '/etc/passwd' },
      });
      expect(out).toMatchObject({ block: true });
    } finally {
      process.chdir(prevCwd);
      process.env.PATH = prevPath;
      await rm(tmp, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  });
});

describe('pi extension — resolveBoundary (shells out to `syntaur session boundary`)', () => {
  it('parses the CLI JSON and ~-expands paths', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'pi-rb-'));
    const prevPath = await withFakeSyntaur(
      binDir,
      JSON.stringify({ assignmentDir: '/a', projectDir: '/p', workspaceRoot: '/w' }),
    );
    try {
      const b = resolveBoundary(process.cwd());
      expect(b).toEqual({ assignmentDir: '/a', projectDir: '/p', workspaceRoot: '/w' });
    } finally {
      process.env.PATH = prevPath;
      await rm(binDir, { recursive: true, force: true });
    }
  });

  it('returns an empty boundary (workspace-only) when the CLI is missing — never fail-open', async () => {
    // Point PATH at an empty dir so `syntaur` cannot be found; spawn errors →
    // {} boundary → the caller enforces workspace-only.
    const binDir = await mkdtemp(join(tmpdir(), 'pi-empty-'));
    const prevPath = process.env.PATH;
    process.env.PATH = binDir;
    try {
      expect(resolveBoundary(process.cwd())).toEqual({
        assignmentDir: undefined,
        projectDir: undefined,
        workspaceRoot: undefined,
      });
    } finally {
      process.env.PATH = prevPath;
      await rm(binDir, { recursive: true, force: true });
    }
  });
});
