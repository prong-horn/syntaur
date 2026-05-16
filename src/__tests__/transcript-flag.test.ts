import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const { fakeTranscribe, idHolder } = vi.hoisted(() => ({
  fakeTranscribe: vi.fn(),
  idHolder: { value: null as string | null },
}));

vi.mock('../utils/transcribers/index.js', async () => {
  const actual =
    await vi.importActual<typeof import('../utils/transcribers/index.js')>(
      '../utils/transcribers/index.js',
    );
  return {
    ...actual,
    getTranscriber: () => ({
      id: 'fake',
      transcribe: fakeTranscribe,
    }),
  };
});

vi.mock('../utils/proof-artifact-id.js', async () => {
  const actual =
    await vi.importActual<typeof import('../utils/proof-artifact-id.js')>(
      '../utils/proof-artifact-id.js',
    );
  return {
    ...actual,
    generateArtifactId: () => idHolder.value ?? actual.generateArtifactId(),
  };
});

import { createProjectCommand } from '../commands/create-project.js';
import { createAssignmentCommand } from '../commands/create-assignment.js';
import { captureCommand } from '../commands/capture.js';
import {
  closeProofDb,
  resetProofDb,
  listArtifactsByAssignment,
} from '../db/proof-db.js';
import {
  TranscribeFfmpegMissingError,
  TranscribeNoAudioError,
  TranscribeFfmpegError,
} from '../utils/transcribers/index.js';

let testDir: string;
let origSyntaurHome: string | undefined;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-transcript-flag-test-'));
  origSyntaurHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = testDir;
  resetProofDb();
  fakeTranscribe.mockReset();
  idHolder.value = null;
});

afterEach(async () => {
  closeProofDb();
  if (origSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = origSyntaurHome;
  await rm(testDir, { recursive: true, force: true });
});

async function setupAssignment(): Promise<{ assignmentDir: string }> {
  await createProjectCommand('P', { dir: testDir });
  await createAssignmentCommand('A', { project: 'p', dir: testDir });
  return { assignmentDir: resolve(testDir, 'p', 'assignments', 'a') };
}

async function makeFakeMp4(): Promise<string> {
  const path = resolve(testDir, 'demo.mp4');
  await writeFile(path, Buffer.from('fake-mp4-bytes'));
  return path;
}

async function findArtifactFiles(assignmentDir: string): Promise<string[]> {
  const dir = resolve(assignmentDir, 'proof', 'untagged');
  return readdir(dir).catch(() => [] as string[]);
}

describe('captureCommand --transcribe (--file path)', () => {
  it('writes <id>.transcript.md sidecar when --transcribe is set', async () => {
    fakeTranscribe.mockResolvedValue({
      words: [
        { type: 'word', text: 'hello', start: 0.0, end: 0.4 },
        { type: 'word', text: 'world', start: 0.5, end: 1.0 },
      ],
    });

    const { assignmentDir } = await setupAssignment();
    const mp4 = await makeFakeMp4();

    await captureCommand('a', {
      kind: 'video',
      file: mp4,
      transcribe: true,
      project: 'p',
      dir: testDir,
    });

    expect(fakeTranscribe).toHaveBeenCalledTimes(1);
    expect(fakeTranscribe.mock.calls[0][0]).toMatch(/\.mp4$/);

    const files = await findArtifactFiles(assignmentDir);
    expect(files.some((f) => /\.mp4$/.test(f))).toBe(true);
    const sidecarFile = files.find((f) => f.endsWith('.transcript.md'));
    expect(sidecarFile).toBeDefined();
    const md = await readFile(
      resolve(assignmentDir, 'proof', 'untagged', sidecarFile!),
      'utf-8',
    );
    expect(md).toBe('  [000.00-001.00] hello world\n');
  });

  it('does NOT write sidecar when --transcribe is absent (AC5 regression)', async () => {
    const { assignmentDir } = await setupAssignment();
    const mp4 = await makeFakeMp4();

    await captureCommand('a', {
      kind: 'video',
      file: mp4,
      project: 'p',
      dir: testDir,
    });

    expect(fakeTranscribe).not.toHaveBeenCalled();
    const files = await findArtifactFiles(assignmentDir);
    expect(files.some((f) => f.endsWith('.transcript.md'))).toBe(false);
  });

  it('skips transcription with a console warning when sidecar already exists at the destination path', async () => {
    fakeTranscribe.mockResolvedValue({
      words: [{ type: 'word', text: 'should-not-write', start: 0, end: 0.5 }],
    });

    const { assignmentDir } = await setupAssignment();
    const mp4 = await makeFakeMp4();

    // Force the artifact id so we can pre-stamp a sidecar at the predictable
    // destination path. proof-artifact-id is mocked at module scope; switching
    // idHolder.value flips the id used by captureCommand.
    idHolder.value = 'testid01-feed';

    const destDir = resolve(assignmentDir, 'proof', 'untagged');
    await import('node:fs').then((m) => m.mkdirSync(destDir, { recursive: true }));
    const sidecarPath = resolve(destDir, 'testid01-feed.transcript.md');
    await writeFile(sidecarPath, 'hand-written sentinel');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let warnText = '';

    try {
      await captureCommand('a', {
        kind: 'video',
        file: mp4,
        transcribe: true,
        project: 'p',
        dir: testDir,
      });
      warnText = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    } finally {
      warnSpy.mockRestore();
    }

    // Transcriber must NOT have been invoked.
    expect(fakeTranscribe).not.toHaveBeenCalled();

    // The hand-written sidecar must be untouched.
    const after = await readFile(sidecarPath, 'utf-8');
    expect(after).toBe('hand-written sentinel');

    expect(warnText).toMatch(/already exists, skipping/);

    void assignmentDir;
  });

  it('preserves the artifact and warns when transcriber throws TranscribeFfmpegMissingError', async () => {
    fakeTranscribe.mockRejectedValue(
      new TranscribeFfmpegMissingError("ffmpeg not found — install via 'brew install ffmpeg'"),
    );

    const { assignmentDir } = await setupAssignment();
    const mp4 = await makeFakeMp4();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let warnText = '';

    try {
      await captureCommand('a', {
        kind: 'video',
        file: mp4,
        transcribe: true,
        project: 'p',
        dir: testDir,
      });
      warnText = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    } finally {
      warnSpy.mockRestore();
    }

    const id = await readFile(resolve(assignmentDir, 'assignment.md'), 'utf-8').then(
      (s) => s.match(/^id:\s*(.+)$/m)![1].trim(),
    );
    const rows = listArtifactsByAssignment(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('video');

    const files = await findArtifactFiles(assignmentDir);
    expect(files.some((f) => /\.mp4$/.test(f))).toBe(true);
    expect(files.some((f) => f.endsWith('.transcript.md'))).toBe(false);

    expect(warnText).toMatch(/ffmpeg not found/);
  });

  it('warns and preserves artifact when transcriber throws TranscribeNoAudioError', async () => {
    fakeTranscribe.mockRejectedValue(new TranscribeNoAudioError());

    const { assignmentDir } = await setupAssignment();
    const mp4 = await makeFakeMp4();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let warnText = '';

    try {
      await captureCommand('a', {
        kind: 'video',
        file: mp4,
        transcribe: true,
        project: 'p',
        dir: testDir,
      });
      warnText = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    } finally {
      warnSpy.mockRestore();
    }

    const files = await findArtifactFiles(assignmentDir);
    expect(files.some((f) => /\.mp4$/.test(f))).toBe(true);
    expect(files.some((f) => f.endsWith('.transcript.md'))).toBe(false);
    expect(warnText).toMatch(/no audio track/);
  });

  it('warns with TranscribeFfmpegError message when ffmpeg exits non-zero', async () => {
    fakeTranscribe.mockRejectedValue(
      new TranscribeFfmpegError('ffmpeg failed (exit 1): some stderr tail'),
    );

    const { assignmentDir } = await setupAssignment();
    const mp4 = await makeFakeMp4();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let warnText = '';

    try {
      await captureCommand('a', {
        kind: 'video',
        file: mp4,
        transcribe: true,
        project: 'p',
        dir: testDir,
      });
      warnText = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    } finally {
      warnSpy.mockRestore();
    }

    const files = await findArtifactFiles(assignmentDir);
    expect(files.some((f) => /\.mp4$/.test(f))).toBe(true);
    expect(files.some((f) => f.endsWith('.transcript.md'))).toBe(false);
    expect(warnText).toMatch(/transcript skipped: ffmpeg failed \(exit 1\)/);
  });

  it('rejects --transcribe when --kind is not video', async () => {
    const { assignmentDir } = await setupAssignment();
    void assignmentDir;
    await expect(
      captureCommand('a', {
        kind: 'text',
        note: 'hi',
        transcribe: true,
        project: 'p',
        dir: testDir,
      }),
    ).rejects.toThrow(/--transcribe is only valid with --kind=video/);
    expect(fakeTranscribe).not.toHaveBeenCalled();
  });
});

// existsSync import for completeness (unused — kept to keep node:fs imported
// for future expansion); remove if linter flags as unused.
void existsSync;
