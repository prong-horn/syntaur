import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  StartAgentPicker,
  resolveStartAgentOverride,
  startDefaultOptionLabel,
  startPickerSelection,
} from '../StartAgentPicker';
import { runTicketVerb } from '../../lib/tickets';

/** The Start path used by both TicketDetail and TicketStatusPill. */
function startWith(pickerValue: string | null, defaultAgentId: string | null) {
  return runTicketVerb('T-1', 'start', {
    agent: resolveStartAgentOverride(pickerValue, defaultAgentId),
  });
}

describe('Start agent picker', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ticket: { id: 'T-1' } }), { status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sentBody(): unknown {
    const init = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    return JSON.parse(init.body as string);
  }

  it('sends no agent when the picker is untouched', async () => {
    await startWith(null, 'cursor');
    expect(sentBody()).toEqual({});
  });

  it('sends no agent when there is no template default either', async () => {
    await startWith(null, null);
    expect(sentBody()).toEqual({});
  });

  it('sends an explicit non-default choice as the one-use override', async () => {
    await startWith(startPickerSelection('codex', 'cursor'), 'cursor');
    expect(sentBody()).toEqual({ agent: 'codex' });
  });

  it('reverts to no override when the default is selected again', async () => {
    expect(startPickerSelection('cursor', 'cursor')).toBeNull();
    expect(startPickerSelection('', 'cursor')).toBeNull();
    await startWith(startPickerSelection('cursor', 'cursor'), 'cursor');
    expect(sentBody()).toEqual({});
  });

  it('shows the template default as the untouched option', () => {
    expect(startDefaultOptionLabel('cursor', true)).toBe('Default: @cursor');
    expect(startDefaultOptionLabel('cursor', false)).toBe('Default: @cursor (manual)');
    expect(startDefaultOptionLabel(null, true)).toBe('No default agent');
    const html = renderToStaticMarkup(
      <StartAgentPicker defaultAgentId="cursor" defaultAuto={false} value={null} onChange={() => {}} />,
    );
    expect(html).toContain('Default: @cursor (manual)');
    expect(html).toContain('use Hand to after start');
  });
});
