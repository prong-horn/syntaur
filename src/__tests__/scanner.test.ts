import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseTmuxPaneOutput,
  findListeningPorts,
  parseProcessSnapshot,
  descendantPidsFromSnapshot,
  scanAllSessions,
  clearScanCache,
} from '../dashboard/scanner.js';

describe('parseTmuxPaneOutput', () => {
  it('parses pipe-delimited pane lines', () => {
    const output = [
      '0|main|0|zsh|/Users/test/project|12345',
      '0|main|1|node|/Users/test/project|12346',
      '1|server|0|python|/Users/test/api|12347',
    ].join('\n');

    const result = parseTmuxPaneOutput(output);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      windowIndex: 0,
      windowName: 'main',
      paneIndex: 0,
      command: 'zsh',
      cwd: '/Users/test/project',
      pid: 12345,
    });
    expect(result[2]).toEqual({
      windowIndex: 1,
      windowName: 'server',
      paneIndex: 0,
      command: 'python',
      cwd: '/Users/test/api',
      pid: 12347,
    });
  });

  it('returns empty array for empty output', () => {
    expect(parseTmuxPaneOutput('')).toEqual([]);
  });
});

describe('findListeningPorts', () => {
  it('extracts ports from lsof output for matching PIDs', () => {
    const lsofOutput = [
      'node    12346 user    5u  IPv4 0x1234  0t0  TCP *:3000 (LISTEN)',
      'node    12346 user    6u  IPv4 0x1235  0t0  TCP *:3001 (LISTEN)',
      'python  99999 user    4u  IPv4 0x1236  0t0  TCP *:8080 (LISTEN)',
    ].join('\n');

    const ports = findListeningPorts(lsofOutput, new Set([12346]));
    expect(ports.sort()).toEqual([3000, 3001]);
  });

  it('returns empty for no matching PIDs', () => {
    const lsofOutput = 'python  99999 user    4u  IPv4 0x1236  0t0  TCP *:8080 (LISTEN)';
    expect(findListeningPorts(lsofOutput, new Set([12345]))).toEqual([]);
  });
});

describe('parseProcessSnapshot + descendantPidsFromSnapshot', () => {
  // Tree: 100 -> 200 -> {300, 400 -> 500}; 100 -> 600
  const psOutput = [
    '  100     1',
    '  200   100',
    '  600   100',
    '  300   200',
    '  400   200',
    '  500   400',
    '  999     1', // unrelated process
  ].join('\n');

  it('matches a pgrep -P style BFS over the same tree', () => {
    const snap = parseProcessSnapshot(psOutput);
    const descendants = descendantPidsFromSnapshot(100, snap);
    expect([...descendants].sort((a, b) => a - b)).toEqual([100, 200, 300, 400, 500, 600]);
  });

  it('respects maxDepth', () => {
    const snap = parseProcessSnapshot(psOutput);
    // depth 1 from root 100 reaches its direct children only (200, 600)
    const descendants = descendantPidsFromSnapshot(100, snap, 1);
    expect([...descendants].sort((a, b) => a - b)).toEqual([100, 200, 600]);
  });

  it('returns just the root when it has no children', () => {
    const snap = parseProcessSnapshot(psOutput);
    expect([...descendantPidsFromSnapshot(999, snap)]).toEqual([999]);
  });

  it('ignores blank and malformed lines', () => {
    const snap = parseProcessSnapshot('\n  100   1\ngarbage\n  200 100\n');
    expect([...descendantPidsFromSnapshot(100, snap)].sort((a, b) => a - b)).toEqual([100, 200]);
  });
});

// These exercise the process-global stale-while-revalidate cache against empty
// temp dirs (no session files), so each scan is deterministic: sessions === [].
// We assert on object identity to distinguish a cache hit (same reference) from
// a fresh scan (new reference). A unique serversDir per test resets state via
// the cacheKey guard.
describe('scanAllSessions cache (SWR / epoch / key)', () => {
  let serversDir: string;
  let projectsDir: string;

  beforeEach(async () => {
    serversDir = await mkdtemp(join(tmpdir(), 'syntaur-scan-srv-'));
    projectsDir = await mkdtemp(join(tmpdir(), 'syntaur-scan-prj-'));
  });

  afterEach(async () => {
    await rm(serversDir, { recursive: true, force: true });
    await rm(projectsDir, { recursive: true, force: true });
  });

  it('returns the cached object on a warm hit', async () => {
    const first = await scanAllSessions(serversDir, projectsDir);
    const second = await scanAllSessions(serversDir, projectsDir);
    expect(first.sessions).toEqual([]);
    expect(second).toBe(first); // same reference => served from cache, no rescan
  });

  it('produces a fresh result after clearScanCache (mutation forces fresh)', async () => {
    const first = await scanAllSessions(serversDir, projectsDir);
    clearScanCache();
    const afterClear = await scanAllSessions(serversDir, projectsDir);
    expect(afterClear).not.toBe(first); // forceFreshNext blocked on a new scan
    expect(afterClear.sessions).toEqual([]);
  });

  it('bypassCache always returns a freshly scanned object', async () => {
    const warm = await scanAllSessions(serversDir, projectsDir);
    const fresh = await scanAllSessions(serversDir, projectsDir, { bypassCache: true });
    expect(fresh).not.toBe(warm);
  });

  it('invalidates when the workspace (serversDir) changes', async () => {
    const a = await scanAllSessions(serversDir, projectsDir);
    const otherServers = await mkdtemp(join(tmpdir(), 'syntaur-scan-srv2-'));
    try {
      const b = await scanAllSessions(otherServers, projectsDir);
      expect(b).not.toBe(a); // different key => not served from the other workspace's cache
    } finally {
      await rm(otherServers, { recursive: true, force: true });
    }
  });

  it('nonBlocking serves the last-known result instantly once warm', async () => {
    const warm = await scanAllSessions(serversDir, projectsDir);
    const nb = await scanAllSessions(serversDir, projectsDir, { nonBlocking: true });
    // Within TTL this is a plain cache hit; either way it must be real data, not
    // the empty cold-start fallback.
    expect(nb).toBe(warm);
  });

  it('nonBlocking cold start returns a valid response via the race path', async () => {
    // Fresh dirs (unique key => cacheKey reset => genuinely cold, no lastKnown
    // for this key). The fast empty scan wins the cold-wait race, so we get a
    // real (empty) response rather than the timeout fallback.
    const res = await scanAllSessions(serversDir, projectsDir, { nonBlocking: true });
    expect(res.sessions).toEqual([]);
    expect(typeof res.tmuxAvailable).toBe('boolean');
  });
});
