import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { serversDir } from '../utils/paths.js';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sanitizeSessionName,
  registerSession,
  listSessionFiles,
  readSessionFile,
  removeSession,
  updateLastRefreshed,
} from '../dashboard/servers.js';

describe('serversDir', () => {
  it('returns ~/.syntaur/servers', () => {
    expect(serversDir()).toBe(resolve(homedir(), '.syntaur', 'servers'));
  });
});

describe('sanitizeSessionName', () => {
  it('passes alphanumeric names through', () => {
    expect(sanitizeSessionName('my-session_1')).toBe('my-session_1');
  });
  it('replaces dots and colons with hyphens', () => {
    expect(sanitizeSessionName('my.session:name')).toBe('my-session-name');
  });
  it('replaces other special characters', () => {
    expect(sanitizeSessionName('a/b@c')).toBe('a-b-c');
  });
});

describe('session file I/O', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'syntaur-servers-'));
  });
  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('registerSession creates a file with frontmatter', async () => {
    await registerSession(testDir, 'my-stack');
    const data = await readSessionFile(testDir, 'my-stack');
    expect(data).not.toBeNull();
    expect(data!.session).toBe('my-stack');
    expect(data!.registered).toBeTruthy();
    expect(data!.overrides).toEqual({});
  });

  it('listSessionFiles returns registered sessions', async () => {
    await registerSession(testDir, 'stack-a');
    await registerSession(testDir, 'stack-b');
    const names = await listSessionFiles(testDir);
    expect(names.sort()).toEqual(['stack-a', 'stack-b']);
  });

  it('removeSession deletes the file', async () => {
    await registerSession(testDir, 'my-stack');
    await removeSession(testDir, 'my-stack');
    const data = await readSessionFile(testDir, 'my-stack');
    expect(data).toBeNull();
  });

  it('updateLastRefreshed updates the timestamp', async () => {
    await registerSession(testDir, 'my-stack');
    const before = await readSessionFile(testDir, 'my-stack');
    await new Promise(r => setTimeout(r, 10));
    await updateLastRefreshed(testDir, 'my-stack');
    const after = await readSessionFile(testDir, 'my-stack');
    expect(after!.lastRefreshed).not.toBe(before!.lastRefreshed);
  });

  it('registerSession with sanitization works', async () => {
    await registerSession(testDir, 'my.session:1');
    const names = await listSessionFiles(testDir);
    expect(names).toEqual(['my-session-1']);
  });
});
