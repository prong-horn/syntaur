import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { commentCommand } from '../commands/comment.js';
import { renderComments } from '../templates/index.js';

let testDir: string;
let ticketDir: string;
let origSyntaurHome: string | undefined;

async function seedTicket(): Promise<void> {
  ticketDir = resolve(testDir, 'p', 'tickets', 'CMT-1-a');
  await mkdir(ticketDir, { recursive: true });
  await writeFile(
    resolve(testDir, 'p', 'project.md'),
    '---\nslug: p\ntitle: P\nprefix: CMT\nnextTicket: 2\n---\n',
  );
  await writeFile(
    resolve(ticketDir, 'ticket.md'),
    '---\nid: CMT-1\nslug: a\ntitle: A\nstatus: draft\n---\n# A\n',
  );
  await writeFile(
    resolve(ticketDir, 'comments.md'),
    renderComments({ ticket: 'a', timestamp: '2026-01-01T00:00:00Z' }),
  );
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-comment-test-'));
  origSyntaurHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = testDir;
  await seedTicket();
});

afterEach(async () => {
  if (origSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = origSyntaurHome;
  await rm(testDir, { recursive: true, force: true });
});

describe('commentCommand', () => {
  it('appends a question, bumps entryCount, replaces the "No comments yet." sentinel', async () => {
    const commentsPath = resolve(ticketDir, 'comments.md');
    const before = await readFile(commentsPath, 'utf-8');
    expect(before).toContain('entryCount: 0');
    expect(before).toContain('No comments yet.');

    await commentCommand('CMT-1', 'Why this design?', {
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
    await expect(
      commentCommand('CMT-1', '   ', { project: 'p', dir: testDir }),
    ).rejects.toThrow('empty');
  });

  it('rejects an invalid type', async () => {
    await expect(
      commentCommand('CMT-1', 'body', {
        project: 'p',
        // @ts-expect-error — intentionally invalid
        type: 'bogus',
        dir: testDir,
      }),
    ).rejects.toThrow('Invalid comment type');
  });

  it('records the reply-to pointer when set', async () => {
    await commentCommand('CMT-1', 'parent', { project: 'p', type: 'question', author: 'a', dir: testDir });
    await commentCommand('CMT-1', 'child', { project: 'p', type: 'note', replyTo: 'abc12345', author: 'b', dir: testDir });

    const content = await readFile(resolve(ticketDir, 'comments.md'), 'utf-8');
    expect(content).toContain('**Reply to:** abc12345');
  });
});
