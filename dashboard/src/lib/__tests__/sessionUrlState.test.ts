import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_URL_STATE,
  parseSessionUrlState,
  patchSessionUrlState,
  serializeSessionUrlState,
  sessionUrlToQuery,
} from '../sessionUrlState';
import { serializeUsageUrlState } from '../usageUrlState';

describe('sessionUrlState', () => {
  it('round-trips session fields with namespaced keys', () => {
    const sp = serializeSessionUrlState({
      ...DEFAULT_SESSION_URL_STATE,
      page: 2,
      search: 'codex',
      startedFrom: '2026-01-01',
      sort: 'spend_desc',
      sessionId: 'sess-1',
      panel: 'usage',
    });
    const parsed = parseSessionUrlState(sp);
    expect(parsed.page).toBe(2);
    expect(parsed.search).toBe('codex');
    expect(parsed.startedFrom).toBe('2026-01-01');
    expect(parsed.sort).toBe('spend_desc');
    expect(parsed.sessionId).toBe('sess-1');
    expect(parsed.panel).toBe('usage');
  });

  it('omits default session fields from the URL', () => {
    const sp = serializeSessionUrlState(DEFAULT_SESSION_URL_STATE);
    expect(sp.toString()).toBe('');
  });

  it('patchSessionUrlState resets page when filters change but preserves usage keys', () => {
    const base = serializeUsageUrlState(
      { filters: { window: '7d' }, groupBy: 'ticket' },
      serializeSessionUrlState({ ...DEFAULT_SESSION_URL_STATE, page: 3 }),
    );
    const next = patchSessionUrlState(
      parseSessionUrlState(base),
      { search: 'foo' },
      base,
    );
    expect(next.get('sessionPage')).toBeNull();
    expect(next.get('sessionSearch')).toBe('foo');
    expect(next.get('usageWindow')).toBe('7d');
    expect(next.get('usageGroupBy')).toBe('ticket');
  });

  it('patchSessionUrlState keeps page when only page changes', () => {
    const base = serializeSessionUrlState({ ...DEFAULT_SESSION_URL_STATE, page: 1 });
    const next = patchSessionUrlState(parseSessionUrlState(base), { page: 2 }, base);
    expect(next.get('sessionPage')).toBe('2');
  });

  it('sessionUrlToQuery maps to API sessions query', () => {
    const query = sessionUrlToQuery({
      ...DEFAULT_SESSION_URL_STATE,
      page: 1,
      pageSize: 50,
      search: '  hello ',
      startedFrom: '2026-06-01',
    });
    expect(query).toMatchObject({
      page: 1,
      pageSize: 50,
      search: 'hello',
      startedFrom: '2026-06-01',
    });
  });
});
