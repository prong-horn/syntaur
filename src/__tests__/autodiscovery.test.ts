import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  registerSession,
  readSessionFile,
  registerAutoSession,
  listSessionFiles,
  updateLastRefreshed,
  setOverride,
  buildSessionContent,
  removeSession,
} from '../dashboard/servers.js';
import { parseTmuxPaneOutput, findListeningPorts } from '../dashboard/scanner.js';
import {
  listAllTmuxSessions,
  parseLsofForListeningProcesses,
  parsePortsForPid,
  isProcessAlive,
  reconcile,
} from '../dashboard/autodiscovery.js';

let serversDir: string;
let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-autodiscovery-test-'));
  serversDir = resolve(testDir, 'servers');
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ─── auto/kind field roundtrip ───────────────────────────────────────────────

describe('auto/kind field roundtrip', () => {
  it('registerAutoSession creates file with auto: true and kind: tmux', async () => {
    await registerAutoSession(serversDir, 'my-session', { kind: 'tmux' });
    const data = await readSessionFile(serversDir, 'my-session');
    expect(data).not.toBeNull();
    expect(data!.auto).toBe(true);
    expect(data!.kind).toBe('tmux');
    expect(data!.session).toBe('my-session');
  });

  it('registerAutoSession creates file with kind: process and metadata', async () => {
    await registerAutoSession(serversDir, 'proc-node-3000', {
      kind: 'process',
      pid: 12345,
      ports: [3000, 3001],
      cwd: '/Users/test/project',
    });
    const data = await readSessionFile(serversDir, 'proc-node-3000');
    expect(data).not.toBeNull();
    expect(data!.auto).toBe(true);
    expect(data!.kind).toBe('process');
    expect(data!.pid).toBe(12345);
    expect(data!.ports).toEqual([3000, 3001]);
    expect(data!.cwd).toBe('/Users/test/project');
  });

  it('preserves auto/kind through updateLastRefreshed', async () => {
    await registerAutoSession(serversDir, 'preserved', { kind: 'tmux' });
    const before = await readSessionFile(serversDir, 'preserved');
    await updateLastRefreshed(serversDir, 'preserved');
    const after = await readSessionFile(serversDir, 'preserved');
    expect(after!.auto).toBe(true);
    expect(after!.kind).toBe('tmux');
    // lastRefreshed should have been updated
    expect(after!.lastRefreshed).not.toBe(before!.lastRefreshed);
  });

  it('preserves auto/kind/process metadata through setOverride', async () => {
    await registerAutoSession(serversDir, 'with-override', {
      kind: 'process',
      pid: 99999,
      ports: [8080],
      cwd: '/tmp/test',
    });
    await setOverride(serversDir, 'with-override', 0, 0, {
      mission: 'my-mission',
      assignment: 'my-assignment',
    });
    const data = await readSessionFile(serversDir, 'with-override');
    expect(data!.auto).toBe(true);
    expect(data!.kind).toBe('process');
    expect(data!.pid).toBe(99999);
    expect(data!.ports).toEqual([8080]);
    expect(data!.cwd).toBe('/tmp/test');
    expect(data!.overrides['0:0']).toEqual({
      mission: 'my-mission',
      assignment: 'my-assignment',
    });
  });

  it('manual sessions have no auto field', async () => {
    await registerSession(serversDir, 'manual-session');
    const data = await readSessionFile(serversDir, 'manual-session');
    expect(data).not.toBeNull();
    expect(data!.auto).toBeUndefined();
    expect(data!.kind).toBeUndefined();
  });
});

// ─── buildSessionContent ─────────────────────────────────────────────────────

describe('buildSessionContent', () => {
  it('emits auto and kind fields in frontmatter', () => {
    const content = buildSessionContent({
      session: 'test',
      registered: '2026-01-01T00:00:00Z',
      lastRefreshed: '2026-01-01T00:00:00Z',
      overrides: {},
      auto: true,
      kind: 'tmux',
    });
    expect(content).toContain('auto: true');
    expect(content).toContain('kind: tmux');
  });

  it('emits process metadata in frontmatter', () => {
    const content = buildSessionContent({
      session: 'proc',
      registered: '2026-01-01T00:00:00Z',
      lastRefreshed: '2026-01-01T00:00:00Z',
      overrides: {},
      auto: true,
      kind: 'process',
      pid: 42,
      ports: [3000, 3001],
      cwd: '/home/user/project',
    });
    expect(content).toContain('pid: 42');
    expect(content).toContain('ports: [3000, 3001]');
    expect(content).toContain('cwd: /home/user/project');
  });

  it('omits auto/kind when not provided', () => {
    const content = buildSessionContent({
      session: 'manual',
      registered: '2026-01-01T00:00:00Z',
      lastRefreshed: '2026-01-01T00:00:00Z',
      overrides: {},
    });
    expect(content).not.toContain('auto:');
    expect(content).not.toContain('kind:');
    expect(content).not.toContain('pid:');
  });
});

// ─── lsof parsing ────────────────────────────────────────────────────────────

describe('parseLsofForListeningProcesses', () => {
  it('extracts PID, port, and command', () => {
    const lsofOutput = [
      'COMMAND   PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
      'node    12345  user   23u  IPv4 0x1234      0t0  TCP *:3000 (LISTEN)',
      'node    12345  user   24u  IPv4 0x1235      0t0  TCP *:3001 (LISTEN)',
      'python  67890  user   5u   IPv4 0x5678      0t0  TCP *:8000 (LISTEN)',
    ].join('\n');

    const processes = parseLsofForListeningProcesses(lsofOutput);
    expect(processes).toHaveLength(2);

    const nodeProc = processes.find((p) => p.pid === 12345);
    expect(nodeProc).toBeDefined();
    expect(nodeProc!.command).toBe('node');
    expect(nodeProc!.port).toBe(3000);

    const pythonProc = processes.find((p) => p.pid === 67890);
    expect(pythonProc).toBeDefined();
    expect(pythonProc!.command).toBe('python');
    expect(pythonProc!.port).toBe(8000);
  });

  it('handles empty lsof output', () => {
    expect(parseLsofForListeningProcesses('')).toEqual([]);
  });

  it('skips malformed lines', () => {
    const lsofOutput = [
      'short line',
      '',
      'node    12345  user   23u  IPv4 0x1234      0t0  TCP *:3000 (LISTEN)',
    ].join('\n');
    const processes = parseLsofForListeningProcesses(lsofOutput);
    expect(processes).toHaveLength(1);
  });
});

describe('parsePortsForPid', () => {
  it('extracts all ports for a specific PID', () => {
    const lsofOutput = [
      'COMMAND   PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
      'node    12345  user   23u  IPv4 0x1234      0t0  TCP *:3000 (LISTEN)',
      'node    12345  user   24u  IPv4 0x1235      0t0  TCP *:3001 (LISTEN)',
      'python  67890  user   5u   IPv4 0x5678      0t0  TCP *:8000 (LISTEN)',
    ].join('\n');

    expect(parsePortsForPid(lsofOutput, 12345)).toEqual([3000, 3001]);
    expect(parsePortsForPid(lsofOutput, 67890)).toEqual([8000]);
    expect(parsePortsForPid(lsofOutput, 99999)).toEqual([]);
  });
});

// ─── tmux pane output parsing ────────────────────────────────────────────────

describe('tmux pane output parsing', () => {
  it('parses multi-pane output correctly', () => {
    const output = [
      '0|main|0|zsh|/home/user/project|1234',
      '0|main|1|node|/home/user/project|5678',
      '1|logs|0|tail|/var/log|9012',
    ].join('\n');

    const panes = parseTmuxPaneOutput(output);
    expect(panes).toHaveLength(3);
    expect(panes[0]).toEqual({
      windowIndex: 0,
      windowName: 'main',
      paneIndex: 0,
      command: 'zsh',
      cwd: '/home/user/project',
      pid: 1234,
    });
    expect(panes[2].windowIndex).toBe(1);
    expect(panes[2].windowName).toBe('logs');
  });

  it('handles empty output', () => {
    expect(parseTmuxPaneOutput('')).toEqual([]);
  });
});

// ─── listAllTmuxSessions ────────────────────────────────────────────────────

describe('listAllTmuxSessions', () => {
  it('splits tmux list-sessions output by newline', async () => {
    // Mock execQuiet to return fake tmux output
    const scanner = await import('../dashboard/scanner.js');
    const spy = vi.spyOn(scanner, 'execQuiet').mockResolvedValue('session1\nsession2\nsession3');

    const sessions = await listAllTmuxSessions();
    expect(sessions).toEqual(['session1', 'session2', 'session3']);
    expect(spy).toHaveBeenCalledWith('tmux', ['list-sessions', '-F', '#{session_name}']);

    spy.mockRestore();
  });

  it('returns empty array when tmux returns nothing', async () => {
    const scanner = await import('../dashboard/scanner.js');
    const spy = vi.spyOn(scanner, 'execQuiet').mockResolvedValue('');

    const sessions = await listAllTmuxSessions();
    expect(sessions).toEqual([]);

    spy.mockRestore();
  });

  it('filters out empty lines from tmux output', async () => {
    const scanner = await import('../dashboard/scanner.js');
    const spy = vi.spyOn(scanner, 'execQuiet').mockResolvedValue('session1\n\nsession2\n');

    const sessions = await listAllTmuxSessions();
    expect(sessions).toEqual(['session1', 'session2']);

    spy.mockRestore();
  });
});

// ─── isProcessAlive ──────────────────────────────────────────────────────────

describe('isProcessAlive', () => {
  it('returns true for current process PID', async () => {
    expect(await isProcessAlive(process.pid)).toBe(true);
  });

  it('returns false for a PID that does not exist', async () => {
    // PID 9999999 is very unlikely to exist
    expect(await isProcessAlive(9999999)).toBe(false);
  });
});

// ─── reconcile ───────────────────────────────────────────────────────────────

describe('reconcile', () => {
  const missionsDir = '/tmp/nonexistent-missions-dir';

  it('does not touch manual sessions', async () => {
    // Register a manual session
    await registerSession(serversDir, 'manual');

    // Run reconcile with an empty missions dir (no workspaces to match)
    await reconcile(serversDir, missionsDir);

    // Manual session should still exist
    const files = await listSessionFiles(serversDir);
    expect(files).toContain('manual');
    const data = await readSessionFile(serversDir, 'manual');
    expect(data!.auto).toBeUndefined();
  });

  it('cleans up dead auto process sessions', async () => {
    // Register an auto process session with a dead PID
    await registerAutoSession(serversDir, 'dead-process', {
      kind: 'process',
      pid: 9999999, // non-existent PID
      ports: [3000],
      cwd: '/tmp/fake',
    });

    const beforeFiles = await listSessionFiles(serversDir);
    expect(beforeFiles).toContain('dead-process');

    await reconcile(serversDir, missionsDir);

    const afterFiles = await listSessionFiles(serversDir);
    expect(afterFiles).not.toContain('dead-process');
  });

  it('preserves auto process sessions with alive PID', async () => {
    // Register an auto process session with the current PID (alive)
    await registerAutoSession(serversDir, 'alive-process', {
      kind: 'process',
      pid: process.pid,
      ports: [3000],
      cwd: '/tmp/fake',
    });

    await reconcile(serversDir, missionsDir);

    const files = await listSessionFiles(serversDir);
    expect(files).toContain('alive-process');
  });

  it('does not delete auto tmux sessions when tmux is unavailable', async () => {
    // Mock checkTmuxAvailable to return false
    const scanner = await import('../dashboard/scanner.js');
    const tmuxSpy = vi.spyOn(scanner, 'checkTmuxAvailable').mockResolvedValue(false);

    await registerAutoSession(serversDir, 'tmux-session', { kind: 'tmux' });

    await reconcile(serversDir, missionsDir);

    // Session should still exist since tmux is unavailable
    const files = await listSessionFiles(serversDir);
    expect(files).toContain('tmux-session');

    tmuxSpy.mockRestore();
  });

  it('does not delete auto sessions with unknown kind', async () => {
    // Register a session with auto: true but no kind (edge case)
    await registerAutoSession(serversDir, 'unknown-kind', { kind: 'tmux' });
    // Manually overwrite to remove kind (simulate old format)
    const { writeFileForce } = await import('../utils/fs.js');
    await writeFileForce(
      resolve(serversDir, 'unknown-kind.md'),
      '---\nsession: unknown-kind\nregistered: 2026-01-01T00:00:00Z\nlast_refreshed: 2026-01-01T00:00:00Z\nauto: true\n---\n',
    );

    await reconcile(serversDir, missionsDir);

    // Should still exist — unknown kind is left alone
    const files = await listSessionFiles(serversDir);
    expect(files).toContain('unknown-kind');
  });

  it('cleans up dead sessions before discovery so restarted processes can re-register', async () => {
    // Register an auto process session with a dead PID
    await registerAutoSession(serversDir, 'proc-node-3000', {
      kind: 'process',
      pid: 9999999, // dead
      ports: [3000],
      cwd: '/tmp/project',
    });

    // After reconcile, the dead session should be removed
    // (A real discovery would re-register it, but with an empty missionsDir
    //  there's nothing to discover — the point is the file slot is freed)
    await reconcile(serversDir, missionsDir);

    const files = await listSessionFiles(serversDir);
    expect(files).not.toContain('proc-node-3000');
  });
});

// ─── manual sessions untouched ───────────────────────────────────────────────

describe('manual sessions untouched by auto operations', () => {
  it('manual session files remain after auto session operations', async () => {
    await registerSession(serversDir, 'manual-one');
    await registerAutoSession(serversDir, 'auto-one', { kind: 'tmux' });

    const files = await listSessionFiles(serversDir);
    expect(files).toContain('manual-one');
    expect(files).toContain('auto-one');

    const manualData = await readSessionFile(serversDir, 'manual-one');
    expect(manualData!.auto).toBeUndefined();

    const autoData = await readSessionFile(serversDir, 'auto-one');
    expect(autoData!.auto).toBe(true);
  });
});

// ─── findListeningPorts (scanner.ts shared helper) ───────────────────────────

describe('findListeningPorts', () => {
  it('finds ports for given PIDs from lsof output', () => {
    const lsofOutput = [
      'COMMAND   PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
      'node    12345  user   23u  IPv4 0x1234      0t0  TCP *:3000 (LISTEN)',
      'node    12345  user   24u  IPv4 0x1235      0t0  TCP *:3001 (LISTEN)',
      'python  67890  user   5u   IPv4 0x5678      0t0  TCP *:8000 (LISTEN)',
    ].join('\n');

    const ports = findListeningPorts(lsofOutput, new Set([12345]));
    expect(ports).toEqual([3000, 3001]);
  });

  it('returns empty array for non-matching PIDs', () => {
    const lsofOutput = 'node    12345  user   23u  IPv4 0x1234      0t0  TCP *:3000 (LISTEN)';
    expect(findListeningPorts(lsofOutput, new Set([99999]))).toEqual([]);
  });
});
