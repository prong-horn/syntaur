import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32, posix } from 'node:path';
import { createWatcher, ignoreDotSegmentsBelow } from '../dashboard/watcher.js';
import type { WsMessage } from '../dashboard/types.js';

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
  intervalMs = 25,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

describe('ignoreDotSegmentsBelow', () => {
  it('keeps the root and normal nested records; ignores only dot-segments at/below the root', () => {
    // Root is itself nested under a `.syntaur` ANCESTOR — the exact layout that
    // broke the old `/(^|[\/\\])\../` regex (matched the ancestor → ignored all).
    const ignore = ignoreDotSegmentsBelow('/tmp/.syntaur/projects');

    expect(ignore('/tmp/.syntaur/projects')).toBe(false); // the watched root itself
    expect(ignore('/tmp/.syntaur/other')).toBe(false); // a sibling/ancestor path, outside root
    expect(ignore('/tmp/.syntaur/projects/proj/assignments/x/assignment.md')).toBe(false); // real record
    expect(ignore('/tmp/.syntaur/projects/proj/.git/config')).toBe(true); // hidden dir below root
    expect(ignore('/tmp/.syntaur/projects/proj/.hidden/x')).toBe(true);
    expect(ignore('/tmp/.syntaur/projects/.hidden')).toBe(true); // hidden file directly in root
    // Regression for the `rel.startsWith('..')` hole: an in-root file literally
    // named `..foo` is dot-prefixed and must still be ignored.
    expect(ignore('/tmp/.syntaur/projects/..foo')).toBe(true);
  });

  it('handles the leases-db root whose own basename is `.syntaur`', () => {
    // dbDir = dirname(~/.syntaur/syntaur.db) === ~/.syntaur — the root basename
    // is `.syntaur`, which must NOT be treated as an ignorable dot-segment.
    const ignore = ignoreDotSegmentsBelow('/tmp/.syntaur');

    expect(ignore('/tmp/.syntaur')).toBe(false); // root itself
    expect(ignore('/tmp/.syntaur/syntaur.db')).toBe(false);
    expect(ignore('/tmp/.syntaur/syntaur.db-wal')).toBe(false);
    expect(ignore('/tmp/.syntaur/syntaur.db-shm')).toBe(false);
    expect(ignore('/tmp/.syntaur/.hidden')).toBe(true); // genuine hidden file in root
  });

  // Deterministic cross-platform coverage by injecting path.win32 / path.posix,
  // so the backslash-split and the `isAbsolute(rel)` cross-drive guard are real
  // regression guards even on a posix CI host (where they'd otherwise be dead).
  it('handles Windows separators and cross-drive paths via the injected path API', () => {
    const winIgnore = ignoreDotSegmentsBelow('C:\\Users\\me\\.syntaur\\projects', win32);
    expect(winIgnore('C:\\Users\\me\\.syntaur\\projects')).toBe(false); // root itself
    expect(winIgnore('C:\\Users\\me\\.syntaur\\projects\\proj\\assignment.md')).toBe(false); // real record
    expect(winIgnore('C:\\Users\\me\\.syntaur\\projects\\proj\\.git\\config')).toBe(true); // hidden below root
    // Different drive → win32.relative yields an absolute path → isAbsolute guard keeps it.
    expect(winIgnore('D:\\other\\.hidden')).toBe(false);

    const posixIgnore = ignoreDotSegmentsBelow('/home/me/.syntaur/projects', posix);
    expect(posixIgnore('/home/me/.syntaur/projects/proj/assignment.md')).toBe(false);
    expect(posixIgnore('/home/me/.syntaur/projects/proj/.hidden/x')).toBe(true);
  });
});

describe('createWatcher under a dot-named ancestor directory', () => {
  let base: string | null = null;
  let handle: { ready: Promise<void>; close: () => Promise<void> } | null = null;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
    if (base) {
      await rm(base, { recursive: true, force: true });
      base = null;
    }
  });

  it('fires for a new nested assignment and ignores hidden files (the production bug scenario)', async () => {
    base = await mkdtemp(join(tmpdir(), 'syntaur-watcher-test-'));
    // Nest the watched root beneath a dot-named ancestor, reproducing ~/.syntaur/projects.
    const projectsDir = join(base, '.syntaurtest', 'projects');
    const assignmentsDir = join(projectsDir, 'proj', 'assignments');
    await mkdir(assignmentsDir, { recursive: true });

    const messages: WsMessage[] = [];
    handle = createWatcher({
      projectsDir,
      onMessage: (m) => messages.push(m),
      debounceMs: 50,
    });
    await handle.ready;

    // Brand-new assignment created by an external process.
    const asgDir = join(assignmentsDir, 'new-assignment');
    await mkdir(asgDir, { recursive: true });
    await writeFile(join(asgDir, 'assignment.md'), '# new\n');

    const fired = await waitFor(
      () => messages.some((m) => m.type === 'assignment-updated' || m.type === 'project-updated'),
      3000,
    );
    expect(fired).toBe(true);

    // Negative: a hidden file inside the tree must NOT broadcast. Clear first, then
    // wait comfortably longer than debounceMs + FS latency before asserting silence.
    messages.length = 0;
    await writeFile(join(asgDir, '.hidden.tmp'), 'x');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(messages).toHaveLength(0);

    // Liveness: prove the silence above was real ignoring, not a dead watcher —
    // a subsequent NON-hidden write must still be delivered.
    await writeFile(join(asgDir, 'plan.md'), '# plan\n');
    const stillDelivering = await waitFor(() => messages.length > 0, 3000);
    expect(stillDelivering).toBe(true);
  });
});
