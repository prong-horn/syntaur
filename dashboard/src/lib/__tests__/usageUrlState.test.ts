import { describe, expect, it } from 'vitest';
import {
  DEFAULT_USAGE_URL_STATE,
  legacyUsageSearchParams,
  namespacedUsageToLegacy,
  parseLegacyUsageUrlState,
  parseUsageUrlState,
  serializeUsageUrlState,
} from '../usageUrlState';
import { parseSessionUrlState, serializeSessionUrlState, DEFAULT_SESSION_URL_STATE } from '../sessionUrlState';

describe('usageUrlState', () => {
  it('round-trips namespaced usage keys', () => {
    const sp = serializeUsageUrlState({
      filters: { window: 'custom', since: '2026-01-01', until: '2026-01-31', project: 'syntaur', model: 'gpt', tool: 'claude' },
      groupBy: 'ticket',
    });
    const parsed = parseUsageUrlState(sp);
    expect(parsed.filters.window).toBe('custom');
    expect(parsed.filters.since).toBe('2026-01-01');
    expect(parsed.filters.project).toBe('syntaur');
    expect(parsed.groupBy).toBe('ticket');
  });

  it('legacyUsageSearchParams maps old /usage keys to namespaced keys', () => {
    const legacy = new URLSearchParams('window=30d&project=foo&groupBy=ticket');
    const namespaced = legacyUsageSearchParams(legacy);
    expect(namespaced.get('usageWindow')).toBe('30d');
    expect(namespaced.get('usageProject')).toBe('foo');
    expect(namespaced.get('usageGroupBy')).toBe('ticket');
    expect(namespaced.get('window')).toBeNull();
  });

  it('usage and session keys are independent in a combined URL', () => {
    const sp = serializeUsageUrlState(
      DEFAULT_USAGE_URL_STATE,
      serializeSessionUrlState({ ...DEFAULT_SESSION_URL_STATE, page: 4, search: 'x' }),
    );
    expect(sp.get('sessionPage')).toBe('4');
    expect(sp.get('sessionSearch')).toBe('x');
    expect(sp.get('usageWindow')).toBe('30d');
    const usage = parseUsageUrlState(sp);
    const session = parseSessionUrlState(sp);
    expect(usage.groupBy).toBe('project');
    expect(session.page).toBe(4);
  });

  it('parseLegacyUsageUrlState matches old UsagePage parsing', () => {
    const sp = new URLSearchParams('window=7d&groupBy=ticket');
    const state = parseLegacyUsageUrlState(sp);
    expect(state.filters.window).toBe('7d');
    expect(state.groupBy).toBe('ticket');
  });

  it('namespacedUsageToLegacy reverses mapping for tests', () => {
    const sp = new URLSearchParams('usageWindow=90d&usageModel=m1');
    const legacy = namespacedUsageToLegacy(sp);
    expect(legacy.get('window')).toBe('90d');
    expect(legacy.get('model')).toBe('m1');
    expect(legacy.get('usageWindow')).toBeNull();
  });
});
