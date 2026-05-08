import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
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
