import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { EventEmitter } from 'node:events';

// Mock child_process.spawn at module scope (vitest hoists this above imports).
// Tests set `behavior.handler` per-case to drive the fake child's events.
const { fakeSpawn, behavior } = vi.hoisted(() => {
  return {
    fakeSpawn: vi.fn(),
    behavior: {
      handler: null as null | ((args: string[], child: EventEmitter) => void | Promise<void>),
    },
  };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: fakeSpawn };
});

import { createProjectCommand } from '../commands/create-project.js';
import { createAssignmentCommand } from '../commands/create-assignment.js';
import { captureCommand } from '../commands/capture.js';
import {
  initProofDb,
  closeProofDb,
  resetProofDb,
  listArtifactsByAssignment,
} from '../db/proof-db.js';

let testDir: string;
let origSyntaurHome: string | undefined;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-capture-test-'));
  origSyntaurHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = testDir;
  resetProofDb();
});

afterEach(async () => {
  closeProofDb();
  if (origSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = origSyntaurHome;
  await rm(testDir, { recursive: true, force: true });
});

async function setupProjectAssignment(): Promise<{ projectSlug: string; assignmentSlug: string; assignmentDir: string }> {
  await createProjectCommand('P', { dir: testDir });
  await createAssignmentCommand('A', { project: 'p', dir: testDir });
  return {
    projectSlug: 'p',
    assignmentSlug: 'a',
    assignmentDir: resolve(testDir, 'p', 'assignments', 'a'),
  };
}

async function getAssignmentId(assignmentDir: string): Promise<string> {
  const content = await readFile(resolve(assignmentDir, 'assignment.md'), 'utf-8');
  const match = content.match(/^id:\s*(.+)$/m);
  return match ? match[1].trim() : '';
}

describe('captureCommand', () => {
  it('captures a tagged screenshot from a real --file', async () => {
    const { projectSlug, assignmentSlug, assignmentDir } = await setupProjectAssignment();
    const sourcePath = resolve(testDir, 'shot.png');
    await writeFile(sourcePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    await captureCommand('a', {
      kind: 'screenshot',
      file: sourcePath,
      criterion: 0,
      project: projectSlug,
      dir: testDir,
    });

    const id = await getAssignmentId(assignmentDir);
    const rows = listArtifactsByAssignment(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('screenshot');
    expect(rows[0].criterion_index).toBe(0);
    expect(rows[0].file_path).toMatch(/^proof\/0\/.+\.png$/);

    // File copied to dest under proof/0/<id>.png
    const proofDir0 = resolve(assignmentDir, 'proof', '0');
    const filesIn0 = await readdir(proofDir0);
    expect(filesIn0).toHaveLength(1);
    expect(filesIn0[0]).toMatch(/\.png$/);
    void assignmentSlug;
  });

  it('captures an untagged text artifact (note only)', async () => {
    const { projectSlug, assignmentDir } = await setupProjectAssignment();

    await captureCommand('a', {
      kind: 'text',
      note: 'hello world',
      project: projectSlug,
      dir: testDir,
    });

    const id = await getAssignmentId(assignmentDir);
    const rows = listArtifactsByAssignment(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('text');
    expect(rows[0].criterion_index).toBeNull();
    expect(rows[0].file_path).toBeNull();
    expect(rows[0].note).toBe('hello world');
  });

  it('rejects --kind=text with --file', async () => {
    const { projectSlug } = await setupProjectAssignment();
    const sourcePath = resolve(testDir, 'note.txt');
    await writeFile(sourcePath, 'a');

    await expect(
      captureCommand('a', {
        kind: 'text',
        file: sourcePath,
        note: 'hi',
        project: projectSlug,
        dir: testDir,
      }),
    ).rejects.toThrow(/forbids --file/);
  });

  it('rejects --kind=text without --note', async () => {
    const { projectSlug } = await setupProjectAssignment();

    await expect(
      captureCommand('a', { kind: 'text', project: projectSlug, dir: testDir }),
    ).rejects.toThrow(/requires --note/);
  });

  it('rejects --kind=screenshot without --file', async () => {
    const { projectSlug } = await setupProjectAssignment();

    await expect(
      captureCommand('a', { kind: 'screenshot', project: projectSlug, dir: testDir }),
    ).rejects.toThrow(/requires --file/);
  });

  it('rejects nonexistent --file', async () => {
    const { projectSlug } = await setupProjectAssignment();

    await expect(
      captureCommand('a', {
        kind: 'screenshot',
        file: resolve(testDir, 'no-such-file.png'),
        project: projectSlug,
        dir: testDir,
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it('rejects --file pointing to a directory', async () => {
    const { projectSlug } = await setupProjectAssignment();
    const dirPath = resolve(testDir, 'a-dir');
    await mkdir(dirPath, { recursive: true });

    await expect(
      captureCommand('a', {
        kind: 'screenshot',
        file: dirPath,
        project: projectSlug,
        dir: testDir,
      }),
    ).rejects.toThrow(/not a regular file/);
  });

  it('rejects invalid --kind', async () => {
    const { projectSlug } = await setupProjectAssignment();

    await expect(
      captureCommand('a', { kind: 'bogus', project: projectSlug, dir: testDir }),
    ).rejects.toThrow(/Invalid --kind/);
  });

  it('rejects negative --criterion', async () => {
    const { projectSlug } = await setupProjectAssignment();

    await expect(
      captureCommand('a', {
        kind: 'text',
        note: 'x',
        criterion: '-1',
        project: projectSlug,
        dir: testDir,
      }),
    ).rejects.toThrow(/non-negative/);
  });

  it('rejects non-numeric --criterion ("1foo")', async () => {
    const { projectSlug } = await setupProjectAssignment();

    await expect(
      captureCommand('a', {
        kind: 'text',
        note: 'x',
        criterion: '1foo',
        project: projectSlug,
        dir: testDir,
      }),
    ).rejects.toThrow(/non-negative integer/);
  });

  it('rejects fractional --criterion ("1.5")', async () => {
    const { projectSlug } = await setupProjectAssignment();

    await expect(
      captureCommand('a', {
        kind: 'text',
        note: 'x',
        criterion: '1.5',
        project: projectSlug,
        dir: testDir,
      }),
    ).rejects.toThrow(/non-negative integer/);
  });

  it('accepts an out-of-range --criterion at capture time', async () => {
    const { projectSlug, assignmentDir } = await setupProjectAssignment();

    await captureCommand('a', {
      kind: 'text',
      note: 'future-criterion',
      criterion: '99',
      project: projectSlug,
      dir: testDir,
    });

    const id = await getAssignmentId(assignmentDir);
    const rows = listArtifactsByAssignment(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].criterion_index).toBe(99);
  });

  it('captures against a standalone (UUID) assignment via .syntaur/context.json fallback', async () => {
    // Create a standalone assignment
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const standaloneDir = resolve(testDir, 'assignments', id);
    await mkdir(standaloneDir, { recursive: true });
    await writeFile(
      resolve(standaloneDir, 'assignment.md'),
      [
        '---',
        `id: ${id}`,
        'slug: example',
        'title: Example',
        'status: pending',
        'priority: medium',
        'created: "2026-04-20T00:00:00Z"',
        'updated: "2026-04-20T00:00:00Z"',
        'project: null',
        '---',
        '',
        '# Example',
        '',
        '## Acceptance Criteria',
        '- [ ] First',
        '',
      ].join('\n'),
    );

    // Set up a working dir with .syntaur/context.json pointing at it
    const workingDir = resolve(testDir, 'work');
    await mkdir(resolve(workingDir, '.syntaur'), { recursive: true });
    await writeFile(
      resolve(workingDir, '.syntaur', 'context.json'),
      JSON.stringify({ assignmentDir: standaloneDir }),
    );

    await captureCommand(undefined, {
      kind: 'text',
      note: 'standalone-capture',
      cwd: workingDir,
      dir: testDir,
    });

    const rows = listArtifactsByAssignment(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe('standalone-capture');
  });

  it('captures via bare UUID positional', async () => {
    const id = 'cccccccc-dddd-eeee-ffff-000000000000';
    const standaloneDir = resolve(testDir, 'assignments', id);
    await mkdir(standaloneDir, { recursive: true });
    await writeFile(
      resolve(standaloneDir, 'assignment.md'),
      [
        '---',
        `id: ${id}`,
        'slug: example',
        'title: Example',
        'status: pending',
        'priority: medium',
        'created: "2026-04-20T00:00:00Z"',
        'updated: "2026-04-20T00:00:00Z"',
        'project: null',
        '---',
        '',
        '# Example',
        '',
      ].join('\n'),
    );

    await captureCommand(id, { kind: 'text', note: 'bare-uuid', dir: testDir });

    const rows = listArtifactsByAssignment(id);
    expect(rows).toHaveLength(1);
  });

  it('--kind=http with --note (no file) captures successfully', async () => {
    const { projectSlug, assignmentDir } = await setupProjectAssignment();

    await captureCommand('a', {
      kind: 'http',
      note: 'GET / 200 OK',
      project: projectSlug,
      dir: testDir,
    });

    const id = await getAssignmentId(assignmentDir);
    const rows = listArtifactsByAssignment(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('http');
    expect(rows[0].file_path).toBeNull();
  });

  it('--kind=http with --file copies the transcript', async () => {
    const { projectSlug, assignmentDir } = await setupProjectAssignment();
    const transcript = resolve(testDir, 't.txt');
    await writeFile(transcript, 'GET / HTTP/1.1\n\n200 OK\n');

    await captureCommand('a', {
      kind: 'http',
      file: transcript,
      project: projectSlug,
      dir: testDir,
    });

    const id = await getAssignmentId(assignmentDir);
    const rows = listArtifactsByAssignment(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].file_path).toMatch(/^proof\/untagged\/.+\.txt$/);
  });

  it('--kind=http with neither --file nor --note is rejected', async () => {
    const { projectSlug } = await setupProjectAssignment();

    await expect(
      captureCommand('a', { kind: 'http', project: projectSlug, dir: testDir }),
    ).rejects.toThrow(/requires --file or --note/);
  });
});

describe('captureCommand screenshot shellout', () => {
  let origPlatform: PropertyDescriptor | undefined;

  beforeAll(() => {
    fakeSpawn.mockImplementation((_cmd: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      if (behavior.handler) {
        const h = behavior.handler;
        // Defer so the helper can attach 'close'/'error' listeners first.
        queueMicrotask(() => {
          void Promise.resolve(h(args, child)).catch((err) => {
            child.emit('error', err);
          });
        });
      }
      return child;
    });
  });

  beforeEach(() => {
    behavior.handler = null;
    fakeSpawn.mockClear();
    origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    // Force darwin so the platform gate passes; individual tests can override.
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  afterEach(() => {
    if (origPlatform) {
      Object.defineProperty(process, 'platform', origPlatform);
    }
  });

  function writeFakePng(path: string): Promise<void> {
    return writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  }

  it('--interactive happy path: spawns screencapture -i and stores the PNG', async () => {
    behavior.handler = async (args, child) => {
      await writeFakePng(args[args.length - 1]);
      child.emit('close', 0);
    };

    const { projectSlug, assignmentDir } = await setupProjectAssignment();
    await captureCommand('a', {
      kind: 'screenshot',
      interactive: true,
      project: projectSlug,
      dir: testDir,
    });

    expect(fakeSpawn).toHaveBeenCalledTimes(1);
    const [cmd, spawnArgs] = fakeSpawn.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('screencapture');
    expect(spawnArgs[0]).toBe('-i');
    const tmpPng = spawnArgs[1];
    expect(tmpPng).toMatch(/syntaur-screenshot-/);

    const id = await getAssignmentId(assignmentDir);
    const rows = listArtifactsByAssignment(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('screenshot');
    expect(rows[0].file_path).toMatch(/^proof\/untagged\/.+\.png$/);

    const proofUntagged = resolve(assignmentDir, 'proof', 'untagged');
    const files = await readdir(proofUntagged);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.png$/);

    // Helper-owned tmp dir cleaned up after successful copy.
    expect(existsSync(dirname(tmpPng))).toBe(false);
  });

  it('--window passes -iWo to screencapture', async () => {
    behavior.handler = async (args, child) => {
      await writeFakePng(args[args.length - 1]);
      child.emit('close', 0);
    };

    const { projectSlug } = await setupProjectAssignment();
    await captureCommand('a', {
      kind: 'screenshot',
      window: true,
      project: projectSlug,
      dir: testDir,
    });

    const [, spawnArgs] = fakeSpawn.mock.calls[0] as [string, string[]];
    expect(spawnArgs[0]).toBe('-iWo');
  });

  it('--fullscreen passes -x to screencapture', async () => {
    behavior.handler = async (args, child) => {
      await writeFakePng(args[args.length - 1]);
      child.emit('close', 0);
    };

    const { projectSlug } = await setupProjectAssignment();
    await captureCommand('a', {
      kind: 'screenshot',
      fullscreen: true,
      project: projectSlug,
      dir: testDir,
    });

    const [, spawnArgs] = fakeSpawn.mock.calls[0] as [string, string[]];
    expect(spawnArgs[0]).toBe('-x');
  });

  it('errors with a --file hint on non-darwin platforms', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    const { projectSlug, assignmentDir } = await setupProjectAssignment();
    await expect(
      captureCommand('a', {
        kind: 'screenshot',
        interactive: true,
        project: projectSlug,
        dir: testDir,
      }),
    ).rejects.toThrow(/Use --file/);

    expect(fakeSpawn).not.toHaveBeenCalled();
    const id = await getAssignmentId(assignmentDir);
    initProofDb();
    expect(listArtifactsByAssignment(id)).toHaveLength(0);
  });

  it('rejects --interactive combined with --file', async () => {
    const { projectSlug, assignmentDir } = await setupProjectAssignment();
    const sourcePath = resolve(testDir, 'shot.png');
    await writeFakePng(sourcePath);

    await expect(
      captureCommand('a', {
        kind: 'screenshot',
        interactive: true,
        file: sourcePath,
        project: projectSlug,
        dir: testDir,
      }),
    ).rejects.toThrow(/--file cannot be combined/);

    expect(fakeSpawn).not.toHaveBeenCalled();
    const id = await getAssignmentId(assignmentDir);
    initProofDb();
    expect(listArtifactsByAssignment(id)).toHaveLength(0);
  });

  it('rejects two shellout flags together', async () => {
    const { projectSlug, assignmentDir } = await setupProjectAssignment();

    await expect(
      captureCommand('a', {
        kind: 'screenshot',
        interactive: true,
        window: true,
        project: projectSlug,
        dir: testDir,
      }),
    ).rejects.toThrow(/mutually exclusive/);

    expect(fakeSpawn).not.toHaveBeenCalled();
    const id = await getAssignmentId(assignmentDir);
    initProofDb();
    expect(listArtifactsByAssignment(id)).toHaveLength(0);
  });

  it('rejects --interactive for kind=text/http/video', async () => {
    const { projectSlug, assignmentDir } = await setupProjectAssignment();
    for (const kind of ['text', 'http', 'video'] as const) {
      await expect(
        captureCommand('a', {
          kind,
          note: 'x',
          interactive: true,
          project: projectSlug,
          dir: testDir,
        }),
      ).rejects.toThrow(/--interactive requires --kind=screenshot or --kind=asciinema/);
    }
    expect(fakeSpawn).not.toHaveBeenCalled();
    const id = await getAssignmentId(assignmentDir);
    initProofDb();
    expect(listArtifactsByAssignment(id)).toHaveLength(0);
  });

  it('user cancel (non-zero exit, no PNG) throws, writes no row, cleans tmp dir', async () => {
    behavior.handler = (_args, child) => {
      child.emit('close', 1);
    };

    const { projectSlug, assignmentDir } = await setupProjectAssignment();
    await expect(
      captureCommand('a', {
        kind: 'screenshot',
        interactive: true,
        project: projectSlug,
        dir: testDir,
      }),
    ).rejects.toThrow(/canceled or failed/);

    expect(fakeSpawn).toHaveBeenCalledTimes(1);
    const [, spawnArgs] = fakeSpawn.mock.calls[0] as [string, string[]];
    const tmpPng = spawnArgs[1];

    const id = await getAssignmentId(assignmentDir);
    initProofDb();
    expect(listArtifactsByAssignment(id)).toHaveLength(0);
    expect(existsSync(dirname(tmpPng))).toBe(false);
  });

  it('exit 0 but zero-byte PNG is treated as a capture failure', async () => {
    behavior.handler = (_args, child) => {
      child.emit('close', 0);
    };

    const { projectSlug, assignmentDir } = await setupProjectAssignment();
    await expect(
      captureCommand('a', {
        kind: 'screenshot',
        interactive: true,
        project: projectSlug,
        dir: testDir,
      }),
    ).rejects.toThrow(/produced no image/);

    const [, spawnArgs] = fakeSpawn.mock.calls[0] as [string, string[]];
    const tmpPng = spawnArgs[1];

    const id = await getAssignmentId(assignmentDir);
    initProofDb();
    expect(listArtifactsByAssignment(id)).toHaveLength(0);
    expect(existsSync(dirname(tmpPng))).toBe(false);
  });

  it('post-shellout failure (mkdir fails) still cleans the helper tmp dir', async () => {
    // Regression guard for the try/finally that wraps the post-shellout flow.
    behavior.handler = async (args, child) => {
      await writeFakePng(args[args.length - 1]);
      child.emit('close', 0);
    };

    const { projectSlug, assignmentDir } = await setupProjectAssignment();
    // Make the assignment dir read+execute-only so `mkdir(proof/untagged)`
    // inside captureCommand fails with EACCES *after* captureScreenshot has
    // already produced a temp PNG.
    await chmod(assignmentDir, 0o500);

    try {
      await expect(
        captureCommand('a', {
          kind: 'screenshot',
          interactive: true,
          project: projectSlug,
          dir: testDir,
        }),
      ).rejects.toThrow();
    } finally {
      await chmod(assignmentDir, 0o700);
    }

    expect(fakeSpawn).toHaveBeenCalledTimes(1);
    const [, spawnArgs] = fakeSpawn.mock.calls[0] as [string, string[]];
    const tmpPng = spawnArgs[1];
    expect(existsSync(dirname(tmpPng))).toBe(false);

    const id = await getAssignmentId(assignmentDir);
    initProofDb();
    expect(listArtifactsByAssignment(id)).toHaveLength(0);
  });

  it('ENOENT from spawn surfaces a binary-not-found error', async () => {
    behavior.handler = (_args, child) => {
      const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      child.emit('error', err);
    };

    const { projectSlug, assignmentDir } = await setupProjectAssignment();
    await expect(
      captureCommand('a', {
        kind: 'screenshot',
        interactive: true,
        project: projectSlug,
        dir: testDir,
      }),
    ).rejects.toThrow(/screencapture binary not found/);

    const [, spawnArgs] = fakeSpawn.mock.calls[0] as [string, string[]];
    const tmpPng = spawnArgs[1];

    const id = await getAssignmentId(assignmentDir);
    initProofDb();
    expect(listArtifactsByAssignment(id)).toHaveLength(0);
    expect(existsSync(dirname(tmpPng))).toBe(false);
  });
});

describe('captureCommand asciinema shellout', () => {
  beforeEach(() => {
    behavior.handler = null;
    fakeSpawn.mockClear();
  });

  async function writeFakeCast(path: string, eventLines = 1): Promise<void> {
    const header = JSON.stringify({ version: 2, width: 80, height: 24 });
    const events = Array.from({ length: eventLines }, (_, i) =>
      JSON.stringify([0.1 * (i + 1), 'o', `line${i}\r\n`]),
    );
    await writeFile(path, [header, ...events].join('\n') + '\n');
  }

  async function writeHeaderOnlyCast(path: string): Promise<void> {
    const header = JSON.stringify({ version: 2, width: 80, height: 24 });
    await writeFile(path, header + '\n');
  }

  async function writeResizeOnlyCast(path: string): Promise<void> {
    const header = JSON.stringify({ version: 2, width: 80, height: 24 });
    const resize = JSON.stringify([0.05, 'r', '120x40']);
    await writeFile(path, header + '\n' + resize + '\n');
  }

  it('--interactive happy path: spawns asciinema rec with stdio inherit and attaches the cast', async () => {
    behavior.handler = async (args, child) => {
      await writeFakeCast(args[args.length - 1]);
      child.emit('close', 0);
    };

    const { projectSlug, assignmentDir } = await setupProjectAssignment();
    await captureCommand('a', {
      kind: 'asciinema',
      interactive: true,
      project: projectSlug,
      dir: testDir,
    });

    expect(fakeSpawn).toHaveBeenCalledTimes(1);
    const [cmd, spawnArgs, spawnOpts] = fakeSpawn.mock.calls[0] as [
      string,
      string[],
      { stdio: unknown },
    ];
    expect(cmd).toBe('asciinema');
    expect(spawnArgs[0]).toBe('rec');
    expect(spawnOpts.stdio).toBe('inherit');
    const castPath = spawnArgs[spawnArgs.length - 1];
    expect(castPath).toMatch(/syntaur-asciinema-/);

    const id = await getAssignmentId(assignmentDir);
    const rows = listArtifactsByAssignment(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('asciinema');
    expect(rows[0].file_path).toMatch(/^proof\/untagged\/.+\.cast$/);

    const proofUntagged = resolve(assignmentDir, 'proof', 'untagged');
    const files = await readdir(proofUntagged);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.cast$/);

    expect(existsSync(dirname(castPath))).toBe(false);
  });

  it('-- <cmd> non-interactive: spawns rec --command <joined> with stdio ignore+inherit+inherit', async () => {
    behavior.handler = async (args, child) => {
      await writeFakeCast(args[args.length - 1]);
      child.emit('close', 0);
    };

    const { projectSlug, assignmentDir } = await setupProjectAssignment();
    await captureCommand('a', {
      kind: 'asciinema',
      commandArgv: ['echo', 'hi'],
      project: projectSlug,
      dir: testDir,
    });

    expect(fakeSpawn).toHaveBeenCalledTimes(1);
    const [, spawnArgs, spawnOpts] = fakeSpawn.mock.calls[0] as [
      string,
      string[],
      { stdio: unknown },
    ];
    expect(spawnArgs[0]).toBe('rec');
    expect(spawnArgs[1]).toBe('--command');
    expect(spawnArgs[2]).toBe('echo hi');
    expect(spawnOpts.stdio).toEqual(['ignore', 'inherit', 'inherit']);

    const id = await getAssignmentId(assignmentDir);
    expect(listArtifactsByAssignment(id)).toHaveLength(1);
  });

  it('shell-quotes argv containing spaces and shell metacharacters', async () => {
    behavior.handler = async (args, child) => {
      await writeFakeCast(args[args.length - 1]);
      child.emit('close', 0);
    };

    const { projectSlug } = await setupProjectAssignment();
    await captureCommand('a', {
      kind: 'asciinema',
      commandArgv: ['bash', '-c', 'echo a && echo b'],
      project: projectSlug,
      dir: testDir,
    });

    const [, spawnArgs] = fakeSpawn.mock.calls[0] as [string, string[]];
    expect(spawnArgs[2]).toBe(`bash -c 'echo a && echo b'`);
  });

  it('shell-quotes argv containing an embedded single quote', async () => {
    behavior.handler = async (args, child) => {
      await writeFakeCast(args[args.length - 1]);
      child.emit('close', 0);
    };

    const { projectSlug } = await setupProjectAssignment();
    await captureCommand('a', {
      kind: 'asciinema',
      commandArgv: ['printf', '%s', "it's"],
      project: projectSlug,
      dir: testDir,
    });

    const [, spawnArgs] = fakeSpawn.mock.calls[0] as [string, string[]];
    expect(spawnArgs[2]).toBe(`printf %s 'it'\\''s'`);
  });

  it('non-zero exit with non-empty cast is attached with a warning', async () => {
    behavior.handler = async (args, child) => {
      await writeFakeCast(args[args.length - 1]);
      child.emit('close', 2);
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { projectSlug, assignmentDir } = await setupProjectAssignment();
    try {
      await captureCommand('a', {
        kind: 'asciinema',
        commandArgv: ['false'],
        project: projectSlug,
        dir: testDir,
      });

      expect(warnSpy).toHaveBeenCalled();
      const warnArg = warnSpy.mock.calls[0][0] as string;
      expect(warnArg).toMatch(/exited 2/);

      const id = await getAssignmentId(assignmentDir);
      expect(listArtifactsByAssignment(id)).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('header-only cast (canceled before any input) throws; no row; tmp dir gone', async () => {
    behavior.handler = async (args, child) => {
      await writeHeaderOnlyCast(args[args.length - 1]);
      child.emit('close', 130);
    };

    const { projectSlug, assignmentDir } = await setupProjectAssignment();
    await expect(
      captureCommand('a', {
        kind: 'asciinema',
        interactive: true,
        project: projectSlug,
        dir: testDir,
      }),
    ).rejects.toThrow(/produced no recording \(canceled before any input/);

    const [, spawnArgs] = fakeSpawn.mock.calls[0] as [string, string[]];
    const castPath = spawnArgs[spawnArgs.length - 1];

    const id = await getAssignmentId(assignmentDir);
    initProofDb();
    expect(listArtifactsByAssignment(id)).toHaveLength(0);
    expect(existsSync(dirname(castPath))).toBe(false);
  });

  it('resize-only cast is treated as empty', async () => {
    behavior.handler = async (args, child) => {
      await writeResizeOnlyCast(args[args.length - 1]);
      child.emit('close', 0);
    };

    const { projectSlug, assignmentDir } = await setupProjectAssignment();
    await expect(
      captureCommand('a', {
        kind: 'asciinema',
        interactive: true,
        project: projectSlug,
        dir: testDir,
      }),
    ).rejects.toThrow(/produced no recording/);

    const id = await getAssignmentId(assignmentDir);
    initProofDb();
    expect(listArtifactsByAssignment(id)).toHaveLength(0);
  });

  it('missing cast file (asciinema exited 0 but wrote nothing) throws', async () => {
    behavior.handler = (_args, child) => {
      child.emit('close', 0);
    };

    const { projectSlug, assignmentDir } = await setupProjectAssignment();
    await expect(
      captureCommand('a', {
        kind: 'asciinema',
        interactive: true,
        project: projectSlug,
        dir: testDir,
      }),
    ).rejects.toThrow(/produced no cast file/);

    const [, spawnArgs] = fakeSpawn.mock.calls[0] as [string, string[]];
    const castPath = spawnArgs[spawnArgs.length - 1];
    expect(existsSync(dirname(castPath))).toBe(false);

    const id = await getAssignmentId(assignmentDir);
    initProofDb();
    expect(listArtifactsByAssignment(id)).toHaveLength(0);
  });

  it('ENOENT from spawn surfaces an install hint mentioning brew and pipx', async () => {
    behavior.handler = (_args, child) => {
      const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      child.emit('error', err);
    };

    const { projectSlug, assignmentDir } = await setupProjectAssignment();
    await expect(
      captureCommand('a', {
        kind: 'asciinema',
        interactive: true,
        project: projectSlug,
        dir: testDir,
      }),
    ).rejects.toThrow(/asciinema not found on PATH.*brew install asciinema.*pipx install asciinema/s);

    const id = await getAssignmentId(assignmentDir);
    initProofDb();
    expect(listArtifactsByAssignment(id)).toHaveLength(0);
  });

  it('--file <existing.cast> regression: does not spawn; copies file as before', async () => {
    const sourcePath = resolve(testDir, 'manual.cast');
    await writeFakeCast(sourcePath);

    const { projectSlug, assignmentDir } = await setupProjectAssignment();
    await captureCommand('a', {
      kind: 'asciinema',
      file: sourcePath,
      project: projectSlug,
      dir: testDir,
    });

    expect(fakeSpawn).not.toHaveBeenCalled();

    const id = await getAssignmentId(assignmentDir);
    const rows = listArtifactsByAssignment(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('asciinema');
    expect(rows[0].file_path).toMatch(/^proof\/untagged\/.+\.cast$/);

    const proofUntagged = resolve(assignmentDir, 'proof', 'untagged');
    const files = await readdir(proofUntagged);
    expect(files).toHaveLength(1);
    expect(existsSync(sourcePath)).toBe(true);
  });

  it('rejects -- <cmd> when --kind is not asciinema', async () => {
    const { projectSlug, assignmentDir } = await setupProjectAssignment();
    await expect(
      captureCommand('a', {
        kind: 'screenshot',
        commandArgv: ['echo', 'hi'],
        project: projectSlug,
        dir: testDir,
      }),
    ).rejects.toThrow(/trailing -- <command> is only valid with --kind=asciinema/);

    expect(fakeSpawn).not.toHaveBeenCalled();
    const id = await getAssignmentId(assignmentDir);
    initProofDb();
    expect(listArtifactsByAssignment(id)).toHaveLength(0);
  });

  it('rejects --interactive combined with a trailing -- <cmd>', async () => {
    const { projectSlug, assignmentDir } = await setupProjectAssignment();
    await expect(
      captureCommand('a', {
        kind: 'asciinema',
        interactive: true,
        commandArgv: ['echo', 'hi'],
        project: projectSlug,
        dir: testDir,
      }),
    ).rejects.toThrow(/--interactive and a trailing -- <command> are mutually exclusive/);

    expect(fakeSpawn).not.toHaveBeenCalled();
    const id = await getAssignmentId(assignmentDir);
    initProofDb();
    expect(listArtifactsByAssignment(id)).toHaveLength(0);
  });

  it('Ctrl-C (SIGINT) during interactive mode: cast finalizes, row is written, parent does not die', async () => {
    behavior.handler = async (args, child) => {
      // Simulate asciinema's behavior on Ctrl-C: it catches SIGINT, finalizes
      // the cast file, and exits with the typical 130 code. The parent's
      // installed no-op listener prevents Node from auto-terminating.
      await writeFakeCast(args[args.length - 1]);
      process.emit('SIGINT' as never);
      child.emit('close', 130);
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { projectSlug, assignmentDir } = await setupProjectAssignment();
    try {
      await captureCommand('a', {
        kind: 'asciinema',
        interactive: true,
        project: projectSlug,
        dir: testDir,
      });

      const id = await getAssignmentId(assignmentDir);
      const rows = listArtifactsByAssignment(id);
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe('asciinema');
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][0]).toMatch(/exited 130/);

      // The helper's SIGINT listener was removed after the call completed.
      expect(process.listenerCount('SIGINT')).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('SIGINT during interactive mode with empty cast: throws, listener cleaned up', async () => {
    behavior.handler = async (args, child) => {
      // SIGINT before any data is written → asciinema exits 130 with only the
      // header on disk → helper throws "produced no recording".
      await writeHeaderOnlyCast(args[args.length - 1]);
      process.emit('SIGINT' as never);
      child.emit('close', 130);
    };

    const { projectSlug, assignmentDir } = await setupProjectAssignment();
    await expect(
      captureCommand('a', {
        kind: 'asciinema',
        interactive: true,
        project: projectSlug,
        dir: testDir,
      }),
    ).rejects.toThrow(/produced no recording/);

    const id = await getAssignmentId(assignmentDir);
    initProofDb();
    expect(listArtifactsByAssignment(id)).toHaveLength(0);
    expect(process.listenerCount('SIGINT')).toBe(0);
  });

  it('rejects --file combined with a trailing -- <cmd>', async () => {
    const sourcePath = resolve(testDir, 'manual.cast');
    await writeFakeCast(sourcePath);

    const { projectSlug, assignmentDir } = await setupProjectAssignment();
    await expect(
      captureCommand('a', {
        kind: 'asciinema',
        file: sourcePath,
        commandArgv: ['echo', 'hi'],
        project: projectSlug,
        dir: testDir,
      }),
    ).rejects.toThrow(/--file cannot be combined with a trailing -- <command>/);

    expect(fakeSpawn).not.toHaveBeenCalled();
    const id = await getAssignmentId(assignmentDir);
    initProofDb();
    expect(listArtifactsByAssignment(id)).toHaveLength(0);
  });
});

describe('asciinema helper internals', () => {
  it('hasRecordedData: true for one output event', async () => {
    const { hasRecordedData } = await import('../utils/asciinema.js');
    const cast = [
      JSON.stringify({ version: 2, width: 80, height: 24 }),
      JSON.stringify([0.1, 'o', 'hello']),
    ].join('\n');
    expect(hasRecordedData(cast)).toBe(true);
  });

  it('hasRecordedData: true for one input event', async () => {
    const { hasRecordedData } = await import('../utils/asciinema.js');
    const cast = [
      JSON.stringify({ version: 2, width: 80, height: 24 }),
      JSON.stringify([0.1, 'i', 'x']),
    ].join('\n');
    expect(hasRecordedData(cast)).toBe(true);
  });

  it('hasRecordedData: false for header only', async () => {
    const { hasRecordedData } = await import('../utils/asciinema.js');
    const cast = JSON.stringify({ version: 2, width: 80, height: 24 }) + '\n';
    expect(hasRecordedData(cast)).toBe(false);
  });

  it('hasRecordedData: false for header + resize event only', async () => {
    const { hasRecordedData } = await import('../utils/asciinema.js');
    const cast = [
      JSON.stringify({ version: 2, width: 80, height: 24 }),
      JSON.stringify([0.05, 'r', '120x40']),
    ].join('\n');
    expect(hasRecordedData(cast)).toBe(false);
  });

  it('hasRecordedData: false for header + v3 comment line only', async () => {
    const { hasRecordedData } = await import('../utils/asciinema.js');
    const cast = `{"version": 3, "term": {"cols": 80, "rows": 24}}\n# a v3 comment\n`;
    expect(hasRecordedData(cast)).toBe(false);
  });

  it('hasRecordedData: true for scientific-notation timestamps', async () => {
    const { hasRecordedData } = await import('../utils/asciinema.js');
    const cast = [
      JSON.stringify({ version: 2, width: 80, height: 24 }),
      `[1e-3, "o", "x"]`,
      `[2.5E+0, "o", "y"]`,
    ].join('\n');
    expect(hasRecordedData(cast)).toBe(true);
  });

  it('hasRecordedData: true even when final line is truncated after a valid event', async () => {
    const { hasRecordedData } = await import('../utils/asciinema.js');
    const cast =
      JSON.stringify({ version: 2, width: 80, height: 24 }) +
      '\n' +
      JSON.stringify([0.1, 'o', 'hi']) +
      '\n[0.2,"o","trunc';
    expect(hasRecordedData(cast)).toBe(true);
  });

  it('shellQuote: passes safe tokens through unchanged', async () => {
    const { shellQuote } = await import('../utils/asciinema.js');
    expect(shellQuote('echo')).toBe('echo');
    expect(shellQuote('./foo.sh')).toBe('./foo.sh');
    expect(shellQuote('--flag=value')).toBe('--flag=value');
  });

  it('shellQuote: wraps spaces and metachars in single quotes', async () => {
    const { shellQuote } = await import('../utils/asciinema.js');
    expect(shellQuote('echo a && echo b')).toBe(`'echo a && echo b'`);
  });

  it('shellQuote: escapes embedded single quote via close-escape-reopen', async () => {
    const { shellQuote } = await import('../utils/asciinema.js');
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it('shellQuote: empty string becomes ""', async () => {
    const { shellQuote } = await import('../utils/asciinema.js');
    expect(shellQuote('')).toBe(`''`);
  });
});
