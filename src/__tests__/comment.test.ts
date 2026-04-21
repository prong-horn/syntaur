import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createProjectCommand } from '../commands/create-project.js';
import { createAssignmentCommand } from '../commands/create-assignment.js';
import { commentCommand } from '../commands/comment.js';

let testDir: string;
let origSyntaurHome: string | undefined;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-comment-test-'));
  origSyntaurHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = testDir;
});

afterEach(async () => {
  if (origSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = origSyntaurHome;
  await rm(testDir, { recursive: true, force: true });
});

describe('commentCommand', () => {
  it('appends a question, bumps entryCount, replaces the "No comments yet." sentinel', async () => {
    await createProjectCommand('P', { dir: testDir });
    await createAssignmentCommand('A', { project: 'p', dir: testDir });

    const commentsPath = resolve(
      testDir,
      'p',
      'assignments',
      'a',
      'comments.md',
    );
    const before = await readFile(commentsPath, 'utf-8');
    expect(before).toContain('entryCount: 0');
    expect(before).toContain('No comments yet.');

    await commentCommand('a', 'Why this design?', {
      project: 'p',
      type: 'question',
      author: 'claude-1',
      dir: testDir,
    });

    const after = await readFile(commentsPath, 'utf-8');
    expect(after).toContain('entryCount: 1');
    expect(after).not.toContain('No comments yet.');
    expect(after).toContain('**Type:** question');
    expect(after).toContain('**Resolved:** false');
    expect(after).toContain('**Author:** claude-1');
    expect(after).toContain('Why this design?');
  });

  it('rejects empty text', async () => {
    await createProjectCommand('P', { dir: testDir });
    await createAssignmentCommand('A', { project: 'p', dir: testDir });

    await expect(
      commentCommand('a', '   ', { project: 'p', dir: testDir }),
    ).rejects.toThrow('empty');
  });

  it('rejects an invalid type', async () => {
    await createProjectCommand('P', { dir: testDir });
    await createAssignmentCommand('A', { project: 'p', dir: testDir });

    await expect(
      commentCommand('a', 'body', {
        project: 'p',
        // @ts-expect-error — intentionally invalid
        type: 'bogus',
        dir: testDir,
      }),
    ).rejects.toThrow('Invalid comment type');
  });

  it('records the reply-to pointer when set', async () => {
    await createProjectCommand('P', { dir: testDir });
    await createAssignmentCommand('A', { project: 'p', dir: testDir });

    await commentCommand('a', 'parent', { project: 'p', type: 'question', author: 'a', dir: testDir });
    await commentCommand('a', 'child', { project: 'p', type: 'note', replyTo: 'abc12345', author: 'b', dir: testDir });

    const content = await readFile(
      resolve(testDir, 'p', 'assignments', 'a', 'comments.md'),
      'utf-8',
    );
    expect(content).toContain('**Reply to:** abc12345');
  });
});
