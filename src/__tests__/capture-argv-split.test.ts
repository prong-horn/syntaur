import { describe, it, expect } from 'vitest';
import { spliceDashDashFromArgv } from '../utils/argv-split.js';

describe('spliceDashDashFromArgv', () => {
  it('returns empty array and leaves argv untouched when no -- is present', () => {
    const argv = ['node', 'cli.js', 'capture', '--kind', 'asciinema', '--interactive'];
    const trailing = spliceDashDashFromArgv(argv);
    expect(trailing).toEqual([]);
    expect(argv).toEqual([
      'node',
      'cli.js',
      'capture',
      '--kind',
      'asciinema',
      '--interactive',
    ]);
  });

  it('captures trailing operands and truncates argv at --', () => {
    const argv = ['node', 'cli.js', 'capture', '--kind', 'asciinema', '--', 'echo', 'hi'];
    const trailing = spliceDashDashFromArgv(argv);
    expect(trailing).toEqual(['echo', 'hi']);
    expect(argv).toEqual(['node', 'cli.js', 'capture', '--kind', 'asciinema']);
  });

  it('preserves complex token contents verbatim', () => {
    const argv = ['x', '--', 'bash', '-c', 'echo a && echo b', "it's"];
    const trailing = spliceDashDashFromArgv(argv);
    expect(trailing).toEqual(['bash', '-c', 'echo a && echo b', "it's"]);
  });

  it('treats an empty -- as a no-op trailing list', () => {
    const argv = ['x', 'capture', '--'];
    expect(spliceDashDashFromArgv(argv)).toEqual([]);
    expect(argv).toEqual(['x', 'capture']);
  });

  it('uses the first -- when multiple are present (operands include later --)', () => {
    const argv = ['x', 'capture', '--', 'echo', '--', 'literal-dash'];
    expect(spliceDashDashFromArgv(argv)).toEqual(['echo', '--', 'literal-dash']);
    expect(argv).toEqual(['x', 'capture']);
  });
});
