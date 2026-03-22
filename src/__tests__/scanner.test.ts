import { describe, it, expect } from 'vitest';
import {
  parseTmuxPaneOutput,
  findListeningPorts,
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
