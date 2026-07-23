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

  const base = ['--short', 'a', '--daemon-id', 'd', '--'];
  it('parses a valid --scrollback into config.scrollback', () => {
    expect(parsePtyHostArgs(['--short', 'a', '--daemon-id', 'd', '--scrollback', '5000', '--', 'bash']).config)
      .toMatchObject({ scrollback: 5000 });
  });
  it('leaves scrollback undefined when omitted (→ emulator default)', () => {
    expect(parsePtyHostArgs([...base, 'bash']).config?.scrollback).toBeUndefined();
  });
  it('rejects invalid/out-of-range --scrollback to undefined (falls back to default)', () => {
    for (const bad of ['-5', 'abc', '1.5', '999999999']) {
      expect(parsePtyHostArgs(['--short', 'a', '--daemon-id', 'd', '--scrollback', bad, '--', 'bash']).config?.scrollback)
        .toBeUndefined();
    }
  });
});
