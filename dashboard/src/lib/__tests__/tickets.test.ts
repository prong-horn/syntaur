import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { dispatchVerbMessages, runTicketVerb } from '../tickets';

describe('dispatchVerbMessages', () => {
  it('includes warnings and failed dispatch states', () => {
    const messages = dispatchVerbMessages({
      ticket: {} as never,
      next: null,
      warnings: ['broker notify failed'],
      dispatch: { state: 'failed', error: 'target disabled' },
    });
    expect(messages).toEqual(['broker notify failed', 'target disabled']);
  });

  it('includes offline and unknown dispatch outcomes', () => {
    expect(
      dispatchVerbMessages({
        ticket: {} as never,
        next: null,
        dispatch: { state: 'offline', warning: 'dashboard offline' },
      }),
    ).toEqual(['dashboard offline']);

    expect(
      dispatchVerbMessages({
        ticket: {} as never,
        next: null,
        dispatch: { state: 'unknown', warning: 'acceptance uncertain' },
      }),
    ).toEqual(['acceptance uncertain']);
  });
});

describe('runTicketVerb', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ticket: { id: 'T-1' },
              next: 'Next',
              warnings: ['dispatch warning'],
              dispatch: { state: 'offline', warning: 'offline' },
            }),
            { status: 200 },
          ),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes start agent override and returns dispatch metadata', async () => {
    const result = await runTicketVerb('T-1', 'start', { agent: 'reviewer', by: 'human' });
    expect(fetch).toHaveBeenCalledWith(
      '/api/tickets/T-1/verbs/start',
      expect.objectContaining({
        body: JSON.stringify({ agent: 'reviewer', by: 'human' }),
      }),
    );
    expect(result.warnings).toEqual(['dispatch warning']);
    expect(result.dispatch?.state).toBe('offline');
  });
});
