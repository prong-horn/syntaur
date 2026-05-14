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
      suppressPid: false,
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

describe('captureCommand video shellout', () => {
  let origPlatform: PropertyDescriptor | undefined;
  let killSpy: ReturnType<typeof vi.spyOn<typeof process, 'kill'>> | null = null;
  const realKill = process.kill.bind(process);

  beforeAll(() => {
    // Override the screencapture-shaped mock with a video-aware one. The
    // ffmpeg path needs a synchronous pid + unref() on the returned child.
    fakeSpawn.mockImplementation((cmd: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        pid?: number;
        unref: () => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.unref = vi.fn();
      if (cmd === 'ffmpeg' && !behavior.suppressPid) {
        child.pid = 12345;
      }
      if (behavior.handler) {
        const h = behavior.handler;
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
    behavior.suppressPid = false;
    fakeSpawn.mockClear();
    process.env.SYNTAUR_RECORDING_WARMUP_MS = '0';
    process.env.SYNTAUR_RECORDING_POLL_INTERVAL_MS = '5';
    process.env.SYNTAUR_RECORDING_POLL_COUNT = '3';
    process.env.SYNTAUR_RECORDING_SIGTERM_WAIT_MS = '5';
    origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  afterEach(() => {
    delete process.env.SYNTAUR_RECORDING_WARMUP_MS;
    delete process.env.SYNTAUR_RECORDING_POLL_INTERVAL_MS;
    delete process.env.SYNTAUR_RECORDING_POLL_COUNT;
    delete process.env.SYNTAUR_RECORDING_SIGTERM_WAIT_MS;
    if (origPlatform) {
      Object.defineProperty(process, 'platform', origPlatform);
    }
    if (killSpy) {
      killSpy.mockRestore();
      killSpy = null;
    }
  });

  function spyKillAliveForWarmup(): void {
    killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: number | NodeJS.Signals) => {
      if (pid === 12345 && signal === 0) return true;
      return realKill(pid, signal);
    });
  }

  function readSidecar(): Promise<Record<string, unknown>> {
    return readFile(resolve(testDir, 'recording.json'), 'utf-8').then((s) => JSON.parse(s));
  }

  it('--start happy path writes pidfile + sidecar, no DB row, prints PID/log', async () => {
    spyKillAliveForWarmup();
    const { projectSlug, assignmentDir } = await setupProjectAssignment();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let stdout = '';

    try {
      await captureCommand('a', {
        kind: 'video',
        start: true,
        project: projectSlug,
        dir: testDir,
      });
      stdout = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    } finally {
      logSpy.mockRestore();
    }

    expect(fakeSpawn).toHaveBeenCalledTimes(1);
    const [cmd, spawnArgs] = fakeSpawn.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('ffmpeg');
    expect(spawnArgs).toEqual(
      expect.arrayContaining([
        '-y',
        '-f',
        'avfoundation',
        '-capture_cursor',
        '1',
        '-framerate',
        '30',
        '-i',
        '1:none',
        '-pix_fmt',
        'yuv420p',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '20',
      ]),
    );

    const pidContent = await readFile(resolve(testDir, 'recording.pid'), 'utf-8');
    expect(pidContent).toBe('12345');

    const sidecar = await readSidecar();
    expect(sidecar).toMatchObject({
      pid: 12345,
      assignmentDir,
      assignmentSlug: 'a',
      projectSlug,
      standalone: false,
      criterionIndex: null,
      note: null,
      device: '1',
      fps: '30',
    });
    expect(typeof sidecar.startedAt).toBe('string');
    expect(sidecar.mp4Path).toMatch(/syntaur-recording-/);

    const id = await getAssignmentId(assignmentDir);
    initProofDb();
    expect(listArtifactsByAssignment(id)).toHaveLength(0);

    expect(stdout).toContain('PID: 12345');
    expect(stdout).toContain('Log:');

    // Cleanup the helper's tmp dir manually (no --stop ran).
    await rm(dirname(String(sidecar.mp4Path)), { recursive: true, force: true });
  });

  it('--start then --stop attaches the mp4 and cleans up state', async () => {
    let sigintSent = false;
    killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: number | NodeJS.Signals) => {
      if (pid !== 12345) return realKill(pid, signal);
      if (signal === 'SIGINT') {
        sigintSent = true;
        return true;
      }
      if (signal === 0) {
        if (sigintSent) {
          throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
        }
        return true;
      }
      return true;
    });

    const { projectSlug, assignmentDir } = await setupProjectAssignment();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await captureCommand('a', {
        kind: 'video',
        start: true,
        project: projectSlug,
        dir: testDir,
      });

      // Simulate ffmpeg producing an mp4 by writing to the sidecar's mp4Path.
      const sidecar = await readSidecar();
      const mp4Path = String(sidecar.mp4Path);
      await writeFile(mp4Path, Buffer.from('fake-mp4-bytes'));

      await captureCommand(undefined, { kind: 'video', stop: true });
    } finally {
      logSpy.mockRestore();
    }

    // Signal call sequence — SIGINT only.
    const signalCalls = killSpy!.mock.calls.filter(
      ([pid, sig]) => pid === 12345 && sig !== 0,
    );
    expect(signalCalls.map((c) => c[1])).toEqual(['SIGINT']);

    // Pidfile + sidecar removed.
    expect(existsSync(resolve(testDir, 'recording.pid'))).toBe(false);
    expect(existsSync(resolve(testDir, 'recording.json'))).toBe(false);

    // DB row + file in proof/untagged.
    const id = await getAssignmentId(assignmentDir);
    const rows = listArtifactsByAssignment(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('video');
    expect(rows[0].file_path).toMatch(/^proof\/untagged\/.+\.mp4$/);

    const proofUntagged = resolve(assignmentDir, 'proof', 'untagged');
    const files = await readdir(proofUntagged);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.mp4$/);
  });

  it('--start refuses when a live PID is in the pidfile', async () => {
    // Pre-write a pidfile pointing at this test process — guaranteed alive.
    await writeFile(resolve(testDir, 'recording.pid'), String(process.pid));

    const { projectSlug } = await setupProjectAssignment();
    await expect(
      captureCommand('a', {
        kind: 'video',
        start: true,
        project: projectSlug,
        dir: testDir,
      }),
    ).rejects.toThrow(/already in progress/);

    expect(fakeSpawn).not.toHaveBeenCalled();
    const after = await readFile(resolve(testDir, 'recording.pid'), 'utf-8');
    expect(after).toBe(String(process.pid));
  });

  it('--start auto-cleans a stale pidfile (dead PID) and proceeds', async () => {
    await writeFile(resolve(testDir, 'recording.pid'), '999999');
    killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: number | NodeJS.Signals) => {
      if (pid === 999999 && signal === 0) {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }
      if (pid === 12345 && signal === 0) return true;
      return realKill(pid, signal);
    });

    const { projectSlug } = await setupProjectAssignment();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await captureCommand('a', {
        kind: 'video',
        start: true,
        project: projectSlug,
        dir: testDir,
      });
    } finally {
      logSpy.mockRestore();
    }

    expect(fakeSpawn).toHaveBeenCalledTimes(1);
    const pidContent = await readFile(resolve(testDir, 'recording.pid'), 'utf-8');
    expect(pidContent).toBe('12345');

    // Cleanup the helper's tmp dir (no --stop in this test).
    const sidecar = await readSidecar();
    await rm(dirname(String(sidecar.mp4Path)), { recursive: true, force: true });
  });

  it('ffmpeg dying during warm-up surfaces a Screen Recording permission hint and cleans up', async () => {
    // Warm-up wait is 0; warm-up check happens before sidecar write.
    // Spy: pid 12345 is dead.
    killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: number | NodeJS.Signals) => {
      if (pid === 12345 && signal === 0) {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }
      return realKill(pid, signal);
    });
    behavior.handler = async (_args, _child) => {
      // Pre-seed the log file with a fake permission error so the tail logic
      // has content to surface.
      await writeFile(
        resolve(testDir, 'recording.log'),
        'Screen Recording permission denied\nffmpeg exiting\n',
        { flag: 'a' },
      );
    };

    const { projectSlug } = await setupProjectAssignment();
    await expect(
      captureCommand('a', {
        kind: 'video',
        start: true,
        project: projectSlug,
        dir: testDir,
      }),
    ).rejects.toThrow(/exited during startup/);

    // Pidfile cleaned; sidecar never written.
    expect(existsSync(resolve(testDir, 'recording.pid'))).toBe(false);
    expect(existsSync(resolve(testDir, 'recording.json'))).toBe(false);
    // Log file preserved for post-mortem.
    expect(existsSync(resolve(testDir, 'recording.log'))).toBe(true);
  });

  it('ENOENT (ffmpeg missing) surfaces a brew-install hint and leaves no pidfile', async () => {
    behavior.suppressPid = true;
    behavior.handler = (_args, child) => {
      child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    };

    const { projectSlug } = await setupProjectAssignment();
    await expect(
      captureCommand('a', {
        kind: 'video',
        start: true,
        project: projectSlug,
        dir: testDir,
      }),
    ).rejects.toThrow(/brew install ffmpeg/);

    expect(existsSync(resolve(testDir, 'recording.pid'))).toBe(false);
    expect(existsSync(resolve(testDir, 'recording.json'))).toBe(false);
  });

  it('non-darwin platform errors with --file hint and never spawns', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    const { projectSlug } = await setupProjectAssignment();
    await expect(
      captureCommand('a', {
        kind: 'video',
        start: true,
        project: projectSlug,
        dir: testDir,
      }),
    ).rejects.toThrow(/macOS.*--file/s);

    expect(fakeSpawn).not.toHaveBeenCalled();
  });

  it('--stop escalates to SIGTERM when SIGINT is ignored', async () => {
    let phase: 'pre' | 'post-sigint' | 'post-sigterm' = 'pre';
    killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: number | NodeJS.Signals) => {
      if (pid !== 12345) return realKill(pid, signal);
      if (signal === 'SIGINT') {
        phase = 'post-sigint';
        return true;
      }
      if (signal === 'SIGTERM') {
        phase = 'post-sigterm';
        return true;
      }
      if (signal === 'SIGKILL') {
        return true;
      }
      if (signal === 0) {
        if (phase === 'post-sigterm') {
          throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
        }
        return true;
      }
      return true;
    });

    const { projectSlug } = await setupProjectAssignment();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await captureCommand('a', {
        kind: 'video',
        start: true,
        project: projectSlug,
        dir: testDir,
      });

      const sidecar = await readSidecar();
      await writeFile(String(sidecar.mp4Path), Buffer.from('fake-mp4'));

      await captureCommand(undefined, { kind: 'video', stop: true });
    } finally {
      logSpy.mockRestore();
    }

    const sigs = killSpy!.mock.calls
      .filter(([pid, sig]) => pid === 12345 && sig !== 0)
      .map((c) => c[1]);
    expect(sigs).toEqual(['SIGINT', 'SIGTERM']);
  });

  it('--stop escalates to SIGKILL when SIGTERM is also ignored', async () => {
    let killSentSignal: NodeJS.Signals | null = null;
    killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: number | NodeJS.Signals) => {
      if (pid !== 12345) return realKill(pid, signal);
      if (signal === 'SIGINT' || signal === 'SIGTERM') return true;
      if (signal === 'SIGKILL') {
        killSentSignal = signal;
        return true;
      }
      if (signal === 0) {
        if (killSentSignal === 'SIGKILL') {
          throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
        }
        return true;
      }
      return true;
    });

    const { projectSlug } = await setupProjectAssignment();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await captureCommand('a', {
        kind: 'video',
        start: true,
        project: projectSlug,
        dir: testDir,
      });

      const sidecar = await readSidecar();
      await writeFile(String(sidecar.mp4Path), Buffer.from('fake-mp4'));

      await captureCommand(undefined, { kind: 'video', stop: true });
    } finally {
      logSpy.mockRestore();
    }

    const sigs = killSpy!.mock.calls
      .filter(([pid, sig]) => pid === 12345 && sig !== 0)
      .map((c) => c[1]);
    expect(sigs).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
  });

  it('concurrent --start is blocked by the STARTING sentinel (HIGH-1)', async () => {
    // Pre-write a sentinel naming the current test process so isProcessAlive
    // returns true (alive parent). This simulates a concurrent --start mid-write.
    await writeFile(resolve(testDir, 'recording.pid'), `STARTING:${process.pid}`);

    const { projectSlug } = await setupProjectAssignment();
    await expect(
      captureCommand('a', {
        kind: 'video',
        start: true,
        project: projectSlug,
        dir: testDir,
      }),
    ).rejects.toThrow(/startup already in progress/);

    expect(fakeSpawn).not.toHaveBeenCalled();
    // Original sentinel preserved — we did NOT unlink someone else's lock.
    const after = await readFile(resolve(testDir, 'recording.pid'), 'utf-8');
    expect(after).toBe(`STARTING:${process.pid}`);
  });

  it('stale STARTING sentinel (dead parent) is auto-cleaned (HIGH-1)', async () => {
    await writeFile(resolve(testDir, 'recording.pid'), 'STARTING:999998');
    killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: number | NodeJS.Signals) => {
      if (pid === 999998 && signal === 0) {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }
      if (pid === 12345 && signal === 0) return true;
      return realKill(pid, signal);
    });

    const { projectSlug } = await setupProjectAssignment();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await captureCommand('a', {
        kind: 'video',
        start: true,
        project: projectSlug,
        dir: testDir,
      });
    } finally {
      logSpy.mockRestore();
    }

    expect(fakeSpawn).toHaveBeenCalledTimes(1);
    const pidContent = await readFile(resolve(testDir, 'recording.pid'), 'utf-8');
    expect(pidContent).toBe('12345');

    // Cleanup helper tmp dir.
    const sidecar = await readSidecar();
    await rm(dirname(String(sidecar.mp4Path)), { recursive: true, force: true });
  });

  it('post-PID failure during --start kills the detached ffmpeg (HIGH-2)', async () => {
    // Make the sidecar write fail by pre-creating recording.json as a
    // directory: writeFile(sidecar) hits EISDIR after spawn, PID write, and
    // warm-up have already succeeded. The catch path must kill PID 12345.
    await mkdir(resolve(testDir, 'recording.json'), { recursive: true });

    let sigintSent = false;
    killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: number | NodeJS.Signals) => {
      if (pid !== 12345) return realKill(pid, signal);
      if (signal === 'SIGINT') {
        sigintSent = true;
        return true;
      }
      if (signal === 'SIGKILL') return true;
      if (signal === 0) {
        if (sigintSent) {
          throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
        }
        return true;
      }
      return true;
    });

    const { projectSlug } = await setupProjectAssignment();
    await expect(
      captureCommand('a', {
        kind: 'video',
        start: true,
        project: projectSlug,
        dir: testDir,
      }),
    ).rejects.toThrow(); // EISDIR or similar — we just need it to throw

    // The orphan ffmpeg was sent SIGINT (best-effort cleanup).
    const sigs = killSpy.mock.calls
      .filter(([pid, sig]) => pid === 12345 && sig !== 0)
      .map((c) => c[1]);
    expect(sigs).toContain('SIGINT');

    // Pidfile cleaned, tmp dir gone.
    expect(existsSync(resolve(testDir, 'recording.pid'))).toBe(false);
    const [, spawnArgs] = fakeSpawn.mock.calls[0] as [string, string[]];
    const mp4Path = spawnArgs[spawnArgs.length - 1];
    expect(existsSync(dirname(mp4Path))).toBe(false);
  });

  it('--stop attach failure preserves the mp4 for manual recovery (HIGH-3)', async () => {
    let sigintSent = false;
    killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: number | NodeJS.Signals) => {
      if (pid !== 12345) return realKill(pid, signal);
      if (signal === 'SIGINT') {
        sigintSent = true;
        return true;
      }
      if (signal === 0) {
        if (sigintSent) {
          throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
        }
        return true;
      }
      return true;
    });

    const { projectSlug, assignmentDir } = await setupProjectAssignment();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let mp4Path = '';
    let stderr = '';
    try {
      await captureCommand('a', {
        kind: 'video',
        start: true,
        project: projectSlug,
        dir: testDir,
      });

      const sidecar = await readSidecar();
      mp4Path = String(sidecar.mp4Path);
      await writeFile(mp4Path, Buffer.from('fake-mp4'));

      // Make the post-stop attach fail: read+execute-only assignment dir so
      // mkdir(proof/untagged) raises EACCES *after* stopRecording has already
      // removed the pidfile + sidecar.
      await chmod(assignmentDir, 0o500);
      try {
        await expect(
          captureCommand(undefined, { kind: 'video', stop: true }),
        ).rejects.toThrow();
      } finally {
        await chmod(assignmentDir, 0o700);
      }
      stderr = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }

    // The mp4 must still exist — losing minutes of recording on an attach
    // failure is exactly what HIGH-3 was about.
    expect(mp4Path).toBeTruthy();
    expect(existsSync(mp4Path)).toBe(true);

    // Pidfile + sidecar removed by stopRecording before the failure.
    expect(existsSync(resolve(testDir, 'recording.pid'))).toBe(false);
    expect(existsSync(resolve(testDir, 'recording.json'))).toBe(false);

    // Recovery message printed to stderr.
    expect(stderr).toMatch(/Recording saved at/);
    expect(stderr).toMatch(/Re-attach with: syntaur capture --kind video/);

    // Manual cleanup since the helper tmp dir survives by design.
    await rm(dirname(mp4Path), { recursive: true, force: true });
  });

  it.each([
    [{ kind: 'video', start: true, stop: true }, /mutually exclusive/],
    [{ kind: 'text', start: true, note: 'x' }, /require --kind=video/],
    [{ kind: 'video', start: true, file: '/tmp/x.mp4' }, /--file cannot be combined with --start/],
    // Either of the screenshot or video mutex blocks may fire first; both are
    // correct user-facing errors for this combination.
    [{ kind: 'video', start: true, interactive: true }, /require --kind=screenshot|screenshot mode flags/],
    [{ kind: 'video', device: '2' }, /--device\/--fps require --start/],
    [{ kind: 'video', fps: '60' }, /--device\/--fps require --start/],
  ])('mutex violation: %j throws %s', async (opts, expectedErr) => {
    const { projectSlug } = await setupProjectAssignment();
    await expect(
      captureCommand('a', { ...opts, project: projectSlug, dir: testDir }),
    ).rejects.toThrow(expectedErr);

    expect(fakeSpawn).not.toHaveBeenCalled();
    expect(existsSync(resolve(testDir, 'recording.pid'))).toBe(false);
  });
});
