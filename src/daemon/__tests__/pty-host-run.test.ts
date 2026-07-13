import { describe, expect, it } from 'vitest';
import { SyntaurError } from '../../errors.js';
import { parsePtyHostArgs } from '../pty-host-run.js';

describe('parsePtyHostArgs', () => {
  it('recognizes --smoke', () => {
    expect(parsePtyHostArgs(['--smoke'])).toEqual({ smoke: true });
  });

  it('parses the full flag set + a `--` argv tail', () => {
    const parsed = parsePtyHostArgs([
      '--short', 'abc', '--daemon-id', 'd1', '--agent', 'codex',
      '--cwd', '/work', '--cols', '120', '--rows', '40', '--name', 'build',
      '--', '/usr/bin/codex', 'exec', '--yolo',
    ]);
    expect(parsed.smoke).toBe(false);
    expect(parsed.config).toMatchObject({
      short: 'abc',
      daemonId: 'd1',
      agent: 'codex',
      cwd: '/work',
      cols: 120,
      rows: 40,
      name: 'build',
      argv: ['/usr/bin/codex', 'exec', '--yolo'],
    });
  });

  it('defaults agent/cols/rows when omitted', () => {
    const parsed = parsePtyHostArgs(['--short', 'a', '--daemon-id', 'd', '--', 'bash']);
    expect(parsed.config).toMatchObject({ agent: 'shell', cols: 80, rows: 24, argv: ['bash'] });
  });

  it('throws a SyntaurError when --short/--daemon-id/tail are missing', () => {
    expect(() => parsePtyHostArgs(['--daemon-id', 'd', '--', 'bash'])).toThrow(SyntaurError);
    expect(() => parsePtyHostArgs(['--short', 'a', '--', 'bash'])).toThrow(SyntaurError);
    expect(() => parsePtyHostArgs(['--short', 'a', '--daemon-id', 'd'])).toThrow(SyntaurError); // no tail
  });
});
