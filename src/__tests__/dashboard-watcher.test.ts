import { describe, it, expect } from 'vitest';
import { win32, posix } from 'node:path';
import { ignoreDotSegmentsBelow } from '../dashboard/watcher.js';

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
