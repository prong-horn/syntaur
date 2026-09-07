import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderComments, formatCommentEntry, type Comment } from '../templates/index.js';
import { parseComments } from '../dashboard/parser.js';
import { setCommentResolved, resolveQuestionComments } from '../lifecycle/comment-resolve.js';

let testDir: string;

function seedComments(entries: Comment[]): string {
  const timestamp = '2026-09-07T12:00:00Z';
  let content = renderComments({ assignment: 'demo', timestamp });
  content = content.replace('entryCount: 0', `entryCount: ${entries.length}`);
  const body = entries.map((c) => formatCommentEntry(c).trimEnd()).join('\n\n');
  return content.replace('No comments yet.', body);
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'comment-resolve-test-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('setCommentResolved', () => {
  it('resolves and unresolves a question in a round trip', async () => {
    const content = seedComments([
      {
        id: 'q1',
        timestamp: '2026-09-07T12:00:00Z',
        author: 'alice',
        type: 'question',
        body: 'Should we proceed?',
        resolved: false,
      },
    ]);
    await writeFile(join(testDir, 'comments.md'), content);

    const resolve = await setCommentResolved(testDir, 'q1', true);
    expect(resolve).toEqual({ changed: true, previous: false });
    let parsed = parseComments(await readFile(join(testDir, 'comments.md'), 'utf-8'));
    expect(parsed.entries[0].resolved).toBe(true);

    const unresolve = await setCommentResolved(testDir, 'q1', false);
    expect(unresolve).toEqual({ changed: true, previous: true });
    parsed = parseComments(await readFile(join(testDir, 'comments.md'), 'utf-8'));
    expect(parsed.entries[0].resolved).toBe(false);
  });

  it('returns previous null for an unknown id', async () => {
    const content = seedComments([
      {
        id: 'q1',
        timestamp: '2026-09-07T12:00:00Z',
        author: 'alice',
        type: 'question',
        body: 'Q?',
        resolved: false,
      },
    ]);
    await writeFile(join(testDir, 'comments.md'), content);

    const result = await setCommentResolved(testDir, 'missing', true);
    expect(result).toEqual({ changed: false, previous: null });
  });

  it('returns previous null for a note comment', async () => {
    const content = seedComments([
      {
        id: 'n1',
        timestamp: '2026-09-07T12:00:00Z',
        author: 'alice',
        type: 'note',
        body: 'Just a note',
      },
    ]);
    await writeFile(join(testDir, 'comments.md'), content);

    const result = await setCommentResolved(testDir, 'n1', true);
    expect(result).toEqual({ changed: false, previous: null });
  });

  it('is idempotent on a second resolve call', async () => {
    const content = seedComments([
      {
        id: 'q1',
        timestamp: '2026-09-07T12:00:00Z',
        author: 'alice',
        type: 'question',
        body: 'Q?',
        resolved: false,
      },
    ]);
    await writeFile(join(testDir, 'comments.md'), content);

    const first = await setCommentResolved(testDir, 'q1', true);
    expect(first.changed).toBe(true);

    const second = await setCommentResolved(testDir, 'q1', true);
    expect(second).toEqual({ changed: false, previous: true });
  });
});

describe('resolveQuestionComments', () => {
  it('resolves two of three matching questions in one write', async () => {
    const content = seedComments([
      {
        id: 'q1',
        timestamp: '2026-09-07T12:00:00Z',
        author: 'alice',
        type: 'question',
        body: 'First?',
        resolved: false,
      },
      {
        id: 'q2',
        timestamp: '2026-09-07T12:01:00Z',
        author: 'bob',
        type: 'question',
        body: 'Second?',
        resolved: false,
      },
      {
        id: 'q3',
        timestamp: '2026-09-07T12:02:00Z',
        author: 'alice',
        type: 'question',
        body: 'Third?',
        resolved: false,
      },
    ]);
    await writeFile(join(testDir, 'comments.md'), content);

    const ids = await resolveQuestionComments(testDir, (c) => c.author === 'alice');
    expect(ids.sort()).toEqual(['q1', 'q3']);

    const parsed = parseComments(await readFile(join(testDir, 'comments.md'), 'utf-8'));
    const byId = new Map(parsed.entries.map((e) => [e.id, e.resolved]));
    expect(byId.get('q1')).toBe(true);
    expect(byId.get('q2')).toBe(false);
    expect(byId.get('q3')).toBe(true);
  });

  it('returns an empty array when comments.md is absent', async () => {
    const ids = await resolveQuestionComments(testDir, () => true);
    expect(ids).toEqual([]);
  });
});
