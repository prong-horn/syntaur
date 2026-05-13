import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { derivePathFromTranscript } from '../utils/transcript.js';

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-transcript-'));
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function writeTranscript(name: string, lines: object[]): Promise<string> {
  const path = join(sandbox, name);
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

describe('derivePathFromTranscript', () => {
  it('returns null for an empty / nullish path', async () => {
    expect(await derivePathFromTranscript(null)).toBeNull();
    expect(await derivePathFromTranscript(undefined)).toBeNull();
    expect(await derivePathFromTranscript('')).toBeNull();
  });

  it('returns null when the transcript file does not exist', async () => {
    expect(
      await derivePathFromTranscript(join(sandbox, 'missing.jsonl')),
    ).toBeNull();
  });

  it('returns the cwd from the first JSONL line that has one', async () => {
    // Mirrors what Claude Code writes: a leading non-cwd entry, then the
    // first user message carrying cwd.
    const path = await writeTranscript('a.jsonl', [
      { type: 'permission-mode', sessionId: 'abc' },
      { type: 'user', sessionId: 'abc', cwd: '/Users/me/launch-dir' },
      { type: 'user', sessionId: 'abc', cwd: '/Users/me/later-cd' },
    ]);
    expect(await derivePathFromTranscript(path)).toBe('/Users/me/launch-dir');
  });

  it('tolerates blank lines and non-JSON noise before the cwd line', async () => {
    const path = join(sandbox, 'b.jsonl');
    await writeFile(
      path,
      '\n\nnot-json\n' +
        JSON.stringify({ type: 'user', cwd: '/tmp/launch' }) +
        '\n',
    );
    expect(await derivePathFromTranscript(path)).toBe('/tmp/launch');
  });

  it('returns null when no JSONL line in the scan window has a cwd', async () => {
    const path = await writeTranscript('c.jsonl', [
      { type: 'permission-mode' },
      { type: 'user', text: 'hi' },
      { type: 'assistant', text: 'hello' },
    ]);
    expect(await derivePathFromTranscript(path)).toBeNull();
  });

  it('ignores cwd values that are not non-empty strings', async () => {
    const path = await writeTranscript('d.jsonl', [
      { type: 'user', cwd: '' },
      { type: 'user', cwd: null },
      { type: 'user', cwd: 42 },
      { type: 'user', cwd: '/Users/me/real' },
    ]);
    expect(await derivePathFromTranscript(path)).toBe('/Users/me/real');
  });
});
