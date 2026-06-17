import { describe, it, expect } from 'vitest';
import { connectionStatusView } from '../connectionStatusView';

describe('connectionStatusView', () => {
  it('shows an amber "Reconnecting…" pill while reconnecting', () => {
    expect(connectionStatusView('reconnecting')).toEqual({
      show: true,
      label: 'Reconnecting…',
      tone: 'amber',
    });
  });

  it('shows an amber "Offline" pill when closed', () => {
    expect(connectionStatusView('closed')).toEqual({
      show: true,
      label: 'Offline',
      tone: 'amber',
    });
  });

  it('shows a muted "Connecting…" pill on the initial connect', () => {
    expect(connectionStatusView('connecting')).toEqual({
      show: true,
      label: 'Connecting…',
      tone: 'muted',
    });
  });

  it('stays quiet (not shown) when the connection is open/live', () => {
    expect(connectionStatusView('open').show).toBe(false);
  });
});
