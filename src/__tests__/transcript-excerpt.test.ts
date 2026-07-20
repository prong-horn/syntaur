import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildTranscriptExcerpt } from '../sessions/transcript-excerpt.js';

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-excerpt-'));
});
afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function write(name: string, lines: object[]): Promise<string> {
  const path = resolve(sandbox, name);
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

describe('buildTranscriptExcerpt', () => {
  it('returns null for a missing path', async () => {
    expect(await buildTranscriptExcerpt(resolve(sandbox, 'nope.jsonl'), 'claude')).toBeNull();
    expect(await buildTranscriptExcerpt(null, 'claude')).toBeNull();
  });

  it('returns null for an empty file', async () => {
    const path = await write('empty.jsonl', []);
    expect(await buildTranscriptExcerpt(path, 'claude')).toBeNull();
  });

  it('renders claude user/assistant turns', async () => {
    const path = await write('claude.jsonl', [
      { type: 'user', message: { content: 'fix the login bug' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking into it now.' }] } },
    ]);
    const excerpt = await buildTranscriptExcerpt(path, 'claude');
    expect(excerpt).toContain('fix the login bug');
    expect(excerpt).toContain('Looking into it now.');
  });

  // Regression for codex code-review r2 finding 1: real pi transcripts are
  // ENTIRELY `{type:"message", message:{role, content:[{type,text}]}}` lines.
  // The old generic renderer treated the nested `message` object as content and
  // dropped every line, producing an empty excerpt for all pi sessions.
  it('renders pi nested-message transcripts (was dropped entirely)', async () => {
    const path = await write('pi.jsonl', [
      { type: 'session', version: 3, id: 'x', cwd: '/w' },
      { type: 'model_change', model: 'glm' },
      {
        type: 'message',
        id: 'm1',
        message: { role: 'user', content: [{ type: 'text', text: 'apply to this job posting' }] },
      },
      {
        type: 'message',
        id: 'm2',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Submitting the application.' }] },
      },
    ]);
    const excerpt = await buildTranscriptExcerpt(path, 'pi');
    expect(excerpt).not.toBeNull();
    expect(excerpt).toContain('apply to this job posting');
    expect(excerpt).toContain('Submitting the application.');
    // Role is taken from the nested message, not the outer "message" type.
    expect(excerpt).toContain('user:');
    expect(excerpt).toContain('assistant:');
  });

  it('renders codex payload-enveloped transcripts', async () => {
    const path = await write('codex.jsonl', [
      { type: 'session_meta', payload: { id: 's', cwd: '/w' } },
      { payload: { role: 'user', content: 'run the tests' } },
      { payload: { role: 'assistant', content: [{ type: 'text', text: 'All green.' }] } },
    ]);
    const excerpt = await buildTranscriptExcerpt(path, 'codex');
    expect(excerpt).toContain('run the tests');
    expect(excerpt).toContain('All green.');
  });

  it('keeps head and tail and marks the omitted middle for a long transcript', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => ({
      type: 'message',
      message: { role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: `event ${i}` }] },
    }));
    const path = await write('long.jsonl', lines);
    const excerpt = (await buildTranscriptExcerpt(path, 'pi'))!;
    expect(excerpt).toContain('event 0'); // head
    expect(excerpt).toContain('event 199'); // tail
    expect(excerpt).toMatch(/events omitted/);
  });
});
