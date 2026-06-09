import { describe, it, expect } from 'vitest';
import { win32, posix } from 'node:path';
import { createWatcher, ignoreDotSegmentsBelow } from '../dashboard/watcher.js';

// Deterministic regression guard for the dead-watcher bug. chokidar 4 calls
// `ignored(absolutePath)` for every path it encounters; the old
// `/(^|[\/\\])\../` regex returned `true` (ignore) for records like
// `/x/.syntaur/projects/proj/assignment.md` because it matched the `.syntaur`
// ANCESTOR — so the whole tree was suppressed and 0 events fired. These tests
// assert the new matcher returns the correct boolean for exactly the kinds of
// absolute paths chokidar passes, which is precisely what un-breaks delivery.
//
// (The end-to-end "events actually fire under the running dashboard" behavior is
// verified manually against a live `syntaur dashboard` and captured as a proof
// artifact on the assignment — a real-chokidar test is too timing-flaky to live
// in the parallel suite, where fs-event delivery stalls under heavy load.)
describe('ignoreDotSegmentsBelow', () => {
  it('keeps the root and normal nested records; ignores only dot-segments at/below the root', () => {
    // Root is itself nested under a `.syntaur` ANCESTOR — the exact layout that
    // broke the old regex (matched the ancestor → ignored everything below).
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

// ── derived-status v3: recompute hooks ──────────────────────────────────────

describe('watcher derive hooks', () => {
  it('fires onAssignmentChanged for project + standalone edits, onConfigChanged for config.md', async () => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'syntaur-watch-derive-'));
    const projectsDir = join(root, 'projects');
    const assignmentsDir = join(root, 'assignments');
    const configPath = join(root, 'config.md');
    await mkdir(join(projectsDir, 'p1', 'assignments', 'a1'), { recursive: true });
    await mkdir(join(assignmentsDir, 'u1'), { recursive: true });
    await writeFile(configPath, '---\nversion: "2.0"\n---\n');

    const assignmentEvents: Array<[string | null, string]> = [];
    let configEvents = 0;

    const watcher = createWatcher({
      projectsDir,
      assignmentsDir,
      configPath,
      onMessage: () => {},
      onAssignmentChanged: (p, a) => assignmentEvents.push([p, a]),
      onConfigChanged: () => configEvents++,
      debounceMs: 50,
    });

    // let chokidar settle before generating events
    await new Promise((r) => setTimeout(r, 300));
    await writeFile(join(projectsDir, 'p1', 'assignments', 'a1', 'assignment.md'), '---\nslug: a1\n---\n');
    await writeFile(join(assignmentsDir, 'u1', 'assignment.md'), '---\nslug: u1\n---\n');
    await writeFile(configPath, '---\nversion: "2.0"\nupdated: true\n---\n');
    await new Promise((r) => setTimeout(r, 700));

    await watcher.close();

    expect(assignmentEvents).toContainEqual(['p1', 'a1']);
    expect(assignmentEvents).toContainEqual([null, 'u1']);
    expect(configEvents).toBeGreaterThanOrEqual(1);
  });
});
