import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TicketMetrics, presentTicketMetrics } from '../TicketMetrics';
import { ResourceProvider } from '../../../data/useResource';
import { resources } from '../../../data/resources';
import { useTicket, useTicketsBoard } from '../../../hooks/useProjects';
import type { TicketMetrics as Metrics } from '../../../data/types';

const engagementPartial: Metrics = { costUsd: 1.5, sessionCount: 2, costSource: 'engagement', partial: true };
const knownZero: Metrics = { costUsd: 0, sessionCount: 0, costSource: 'usage', partial: false };
const none: Metrics = { costUsd: null, sessionCount: 3, costSource: 'none', partial: false };
const noSessionDb: Metrics = { costUsd: 0.25, sessionCount: null, costSource: 'usage', partial: false };

describe('presentTicketMetrics', () => {
  it('marks partial engagement cost and pluralizes sessions', () => {
    const p = presentTicketMetrics(engagementPartial);
    expect(p.cost.text).toBe('$1.50+');
    expect(p.cost.label).toContain('partial');
    expect(p.sessions.text).toBe('2 sessions');
  });

  it('renders a recorded zero as $0.00 and zero sessions as a real count', () => {
    const p = presentTicketMetrics(knownZero);
    expect(p.cost.text).toBe('$0.00');
    expect(p.sessions.text).toBe('0 sessions');
  });

  it('renders unknown cost and unknown session count as an em dash with an explanation', () => {
    expect(presentTicketMetrics(none).cost).toMatchObject({ text: '—', label: 'Cost unknown' });
    expect(presentTicketMetrics(none).cost.detail).toContain('not $0');
    expect(presentTicketMetrics(noSessionDb).sessions).toMatchObject({ text: '—', label: 'Session count unknown' });
    // A payload without metrics (pre-SV-12 server) is unknown too, never zero.
    expect(presentTicketMetrics(undefined).cost.text).toBe('—');
    expect(presentTicketMetrics(undefined).sessions.text).toBe('—');
  });

  it('labels the source of usage-event cost', () => {
    expect(presentTicketMetrics(noSessionDb).cost.detail).toContain('usage events');
    expect(presentTicketMetrics({ ...engagementPartial, partial: false }).cost.text).toBe('$1.50');
  });
});

describe('TicketMetrics SSR through the seeded resource provider', () => {
  function Header({ id }: { id: string }) {
    const { data } = useTicket(id);
    return data ? <header>{<TicketMetrics metrics={data.metrics} variant="header" />}</header> : <p>loading</p>;
  }
  function Card({ id }: { id: string }) {
    const { data } = useTicketsBoard();
    const item = data?.tickets.find((t) => t.id === id);
    return item ? <article>{<TicketMetrics metrics={item.metrics} />}</article> : <p>loading</p>;
  }

  it('header and card render the same totals from their own payloads', () => {
    const html = renderToStaticMarkup(
      <ResourceProvider
        seed={[
          [resources.ticket('T-1'), { id: 'T-1', metrics: engagementPartial }],
          [resources.tickets(), { generatedAt: 'g', tickets: [{ id: 'T-1', metrics: engagementPartial }] }],
        ]}
      >
        <Header id="T-1" />
        <Card id="T-1" />
      </ResourceProvider>,
    );
    const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
    const card = html.slice(html.indexOf('<article>'), html.indexOf('</article>'));
    for (const part of [header, card]) {
      expect(part).toContain('$1.50+');
      expect(part).toContain('2 sessions');
      expect(part).toContain('aria-label="Lifetime cost $1.50, partial"');
    }
  });

  it('renders unknown states for a ticket without recorded usage', () => {
    const html = renderToStaticMarkup(
      <ResourceProvider seed={[[resources.ticket('T-2'), { id: 'T-2', metrics: none }]]}>
        <Header id="T-2" />
      </ResourceProvider>,
    );
    expect(html).toContain('aria-label="Cost unknown"');
    expect(html).toContain('3 sessions');
    expect(html).not.toContain('>$0');
    expect(html).toContain('aria-hidden="true">—<');
  });
});
