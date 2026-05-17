import { describe, expect, it } from 'vitest';
import { parseOpenUrl, OpenUrlError } from '../launch/url.js';

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
    expect(result).toEqual({ kind: 'session', id: 'abc-123' });
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
});
