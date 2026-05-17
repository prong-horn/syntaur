import { describe, it, expect } from 'vitest';
import { formatUrlCommandError } from '../commands/url.js';
import { OpenUrlError, LaunchError, TerminalNotFoundError } from '../launch/index.js';

describe('formatUrlCommandError', () => {
  it('formats OpenUrlError with its code', () => {
    const msg = formatUrlCommandError(new OpenUrlError('bad-host', 'wrong host'));
    expect(msg).toContain('bad-host');
    expect(msg).toContain('wrong host');
  });

  it('formats LaunchError with its code', () => {
    const msg = formatUrlCommandError(
      new LaunchError('assignment-not-found', 'missing'),
    );
    expect(msg).toContain('assignment-not-found');
    expect(msg).toContain('missing');
  });

  it('formats TerminalNotFoundError as-is', () => {
    const err = new TerminalNotFoundError('ghostty', 'install Ghostty');
    const msg = formatUrlCommandError(err);
    expect(msg).toContain('ghostty');
    expect(msg).toContain('install Ghostty');
  });

  it('formats unknown errors with a generic prefix', () => {
    const msg = formatUrlCommandError(new Error('boom'));
    expect(msg).toContain('Unexpected error');
    expect(msg).toContain('boom');
  });

  it('formats non-Error throws by stringifying', () => {
    const msg = formatUrlCommandError('weird');
    expect(msg).toContain('Unexpected error');
    expect(msg).toContain('weird');
  });
});
