import { describe, expect, it } from 'vitest';
import { ticketResources } from '../ticketResources';

describe('ticketResources', () => {
  it('builds canonical log URLs with optional type filter', () => {
    expect(ticketResources.log('T-1').url).toBe('/api/tickets/T-1/log');
    expect(ticketResources.log('T-1', 'progress').url).toBe('/api/tickets/T-1/log?type=progress');
  });

  it('tags log reads for ticket-detail invalidation', () => {
    const resource = ticketResources.log('T-1');
    expect(resource.tags).toContain('ticket-detail');
    expect(resource.meta).toEqual({ kind: 'ticket-detail', ticketId: 'T-1' });
  });
});
