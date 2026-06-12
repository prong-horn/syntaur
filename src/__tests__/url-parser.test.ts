import { describe, expect, it } from 'vitest';
import { parseOpenUrl, OpenUrlError, MAX_OPEN_PROMPT_LENGTH } from '../launch/url.js';

describe('parseOpenUrl', () => {
  it('accepts syntaur://open?assignment=<id>', () => {
    const result = parseOpenUrl('syntaur://open?assignment=5ac92d8e-fc54-4eb2-bdfc-7603cbda1836');
    expect(result).toEqual({
      kind: 'assignment',
      id: '5ac92d8e-fc54-4eb2-bdfc-7603cbda1836',
    });
  });

  it('accepts syntaur://open?session=<id>', () => {
    const result = parseOpenUrl('syntaur://open?session=abc-123');
    expect(result).toEqual({ kind: 'session', id: 'abc-123', mode: 'resume' });
  });

  it('parses an assignment agent= param', () => {
    const result = parseOpenUrl('syntaur://open?assignment=a1&agent=claude');
    expect(result).toEqual({ kind: 'assignment', id: 'a1', agent: 'claude' });
  });

  it('omits agent when absent or empty', () => {
    expect(parseOpenUrl('syntaur://open?assignment=a1')).not.toHaveProperty('agent');
    expect(parseOpenUrl('syntaur://open?assignment=a1&agent=')).not.toHaveProperty('agent');
  });

  it('carries agent on the session branch too (inert downstream)', () => {
    const result = parseOpenUrl('syntaur://open?session=s1&agent=codex');
    expect(result).toEqual({ kind: 'session', id: 's1', mode: 'resume', agent: 'codex' });
  });

  it('rejects a duplicated agent param', () => {
    expect(() => parseOpenUrl('syntaur://open?assignment=a1&agent=x&agent=y')).toThrowError(
      expect.objectContaining({ code: 'duplicate-param' }),
    );
  });

  it('coexists with terminal and mode params', () => {
    const result = parseOpenUrl(
      'syntaur://open?session=s2&mode=fork&terminal=iterm&agent=codex',
    );
    expect(result).toEqual({
      kind: 'session',
      id: 's2',
      mode: 'fork',
      terminal: 'iterm',
      agent: 'codex',
    });
  });

  it('parses an assignment prompt= param (presence-significant; keeps empty)', () => {
    expect(parseOpenUrl('syntaur://open?assignment=a1&prompt=hi%20there')).toEqual({
      kind: 'assignment',
      id: 'a1',
      prompt: 'hi there',
    });
    // An empty value is a deliberate clear — preserved, not dropped.
    expect(parseOpenUrl('syntaur://open?assignment=a1&prompt=')).toEqual({
      kind: 'assignment',
      id: 'a1',
      prompt: '',
    });
  });

  it('omits prompt when absent', () => {
    expect(parseOpenUrl('syntaur://open?assignment=a1')).not.toHaveProperty('prompt');
  });

  it('does not carry prompt on the session branch', () => {
    expect(parseOpenUrl('syntaur://open?session=s1&prompt=hi')).not.toHaveProperty('prompt');
  });

  it('rejects a duplicated prompt param', () => {
    expect(() => parseOpenUrl('syntaur://open?assignment=a1&prompt=x&prompt=y')).toThrowError(
      expect.objectContaining({ code: 'duplicate-param' }),
    );
  });

  it('accepts a prompt containing a newline', () => {
    const result = parseOpenUrl(
      'syntaur://open?assignment=a1&prompt=' + encodeURIComponent('a\nb'),
    );
    expect(result).toEqual({ kind: 'assignment', id: 'a1', prompt: 'a\nb' });
  });

  it('accepts a prompt at exactly MAX_OPEN_PROMPT_LENGTH and rejects one char more', () => {
    const max = 'x'.repeat(MAX_OPEN_PROMPT_LENGTH);
    expect(parseOpenUrl('syntaur://open?assignment=a1&prompt=' + max)).toMatchObject({ prompt: max });
    expect(() =>
      parseOpenUrl('syntaur://open?assignment=a1&prompt=' + max + 'x'),
    ).toThrowError(expect.objectContaining({ code: 'invalid-prompt' }));
  });

  it('rejects unknown scheme', () => {
    expect(() => parseOpenUrl('http://open?assignment=x')).toThrowError(
      expect.objectContaining({ code: 'bad-scheme' }),
    );
  });

  it('rejects unknown host', () => {
    expect(() => parseOpenUrl('syntaur://other?assignment=x')).toThrowError(
      expect.objectContaining({ code: 'bad-host' }),
    );
  });

  it('rejects missing params', () => {
    expect(() => parseOpenUrl('syntaur://open')).toThrowError(
      expect.objectContaining({ code: 'missing-id' }),
    );
  });

  it('rejects empty assignment param', () => {
    expect(() => parseOpenUrl('syntaur://open?assignment=')).toThrowError(
      expect.objectContaining({ code: 'missing-id' }),
    );
  });

  it('rejects both assignment and session present', () => {
    expect(() =>
      parseOpenUrl('syntaur://open?assignment=a&session=b'),
    ).toThrowError(expect.objectContaining({ code: 'both-ids' }));
  });

  it('rejects both params present even when assignment is empty', () => {
    expect(() =>
      parseOpenUrl('syntaur://open?assignment=&session=x'),
    ).toThrowError(expect.objectContaining({ code: 'both-ids' }));
  });

  it('rejects both params present even when session is empty', () => {
    expect(() =>
      parseOpenUrl('syntaur://open?assignment=x&session='),
    ).toThrowError(expect.objectContaining({ code: 'both-ids' }));
  });

  it('rejects both params present when both are empty', () => {
    expect(() =>
      parseOpenUrl('syntaur://open?assignment=&session='),
    ).toThrowError(expect.objectContaining({ code: 'both-ids' }));
  });

  it('rejects duplicate assignment params', () => {
    expect(() =>
      parseOpenUrl('syntaur://open?assignment=a&assignment=b'),
    ).toThrowError(expect.objectContaining({ code: 'duplicate-param' }));
  });

  it('rejects duplicate session params', () => {
    expect(() =>
      parseOpenUrl('syntaur://open?session=a&session=b'),
    ).toThrowError(expect.objectContaining({ code: 'duplicate-param' }));
  });

  it('parses a valid one-shot terminal override', () => {
    const result = parseOpenUrl(
      'syntaur://open?assignment=abc-123&terminal=ghostty',
    );
    expect(result).toEqual({ kind: 'assignment', id: 'abc-123', terminal: 'ghostty' });
  });

  it('parses terminal override on session URLs', () => {
    const result = parseOpenUrl(
      'syntaur://open?session=sess-9&terminal=iterm',
    );
    expect(result).toEqual({
      kind: 'session',
      id: 'sess-9',
      mode: 'resume',
      terminal: 'iterm',
    });
  });

  it('treats empty terminal value as absent', () => {
    const result = parseOpenUrl(
      'syntaur://open?assignment=abc-123&terminal=',
    );
    expect(result).toEqual({ kind: 'assignment', id: 'abc-123' });
    expect(result).not.toHaveProperty('terminal');
  });

  it('rejects unknown terminal values', () => {
    expect(() =>
      parseOpenUrl('syntaur://open?assignment=x&terminal=bogus'),
    ).toThrowError(expect.objectContaining({ code: 'bad-terminal' }));
  });

  it('rejects duplicate terminal params', () => {
    expect(() =>
      parseOpenUrl('syntaur://open?assignment=x&terminal=a&terminal=b'),
    ).toThrowError(expect.objectContaining({ code: 'duplicate-param' }));
  });

  it('rejects malformed URLs', () => {
    expect(() => parseOpenUrl('not a url')).toThrowError(
      expect.objectContaining({ code: 'malformed' }),
    );
    expect(() => parseOpenUrl('')).toThrowError(
      expect.objectContaining({ code: 'malformed' }),
    );
  });

  it('OpenUrlError carries its structured code', () => {
    try {
      parseOpenUrl('syntaur://other');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(OpenUrlError);
      expect((err as OpenUrlError).code).toBe('bad-host');
    }
  });

  it('defaults mode to "resume" when session URL has no mode param', () => {
    const result = parseOpenUrl('syntaur://open?session=sess-1');
    expect(result).toEqual({ kind: 'session', id: 'sess-1', mode: 'resume' });
  });

  it('accepts mode=resume on a session URL', () => {
    const result = parseOpenUrl('syntaur://open?session=sess-1&mode=resume');
    expect(result).toEqual({ kind: 'session', id: 'sess-1', mode: 'resume' });
  });

  it('accepts mode=fork on a session URL', () => {
    const result = parseOpenUrl('syntaur://open?session=sess-1&mode=fork');
    expect(result).toEqual({ kind: 'session', id: 'sess-1', mode: 'fork' });
  });

  it('rejects invalid mode values with bad-mode', () => {
    try {
      parseOpenUrl('syntaur://open?session=sess-1&mode=branch');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(OpenUrlError);
      expect((err as OpenUrlError).code).toBe('bad-mode');
    }
  });

  it('rejects duplicate mode params with duplicate-param', () => {
    try {
      parseOpenUrl('syntaur://open?session=sess-1&mode=resume&mode=fork');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(OpenUrlError);
      expect((err as OpenUrlError).code).toBe('duplicate-param');
    }
  });
});
