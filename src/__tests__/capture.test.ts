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

  it('rejects --interactive when --kind is not screenshot', async () => {
    const { projectSlug, assignmentDir } = await setupProjectAssignment();

    await expect(
      captureCommand('a', {
        kind: 'text',
        note: 'x',
        interactive: true,
        project: projectSlug,
        dir: testDir,
      }),
    ).rejects.toThrow(/require --kind=screenshot/);

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
