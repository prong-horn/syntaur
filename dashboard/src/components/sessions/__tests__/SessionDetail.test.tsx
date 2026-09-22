import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { SessionDetail } from '../SessionDetail';
import { ResourceProvider } from '../../../data/useResource';
import { resources } from '../../../data/resources';
import type { AgentSessionDetailResponse, AgentSessionWithLiveness } from '../../../types';

function makeSession(usage: AgentSessionWithLiveness['usage']): AgentSessionWithLiveness {
  return {
    projectSlug: null,
    ticketSlug: null,
    ticketId: null,
    agent: 'claude',
    sessionId: 'sess-1',
    started: '2026-07-01T10:00:00.000Z',
    ended: null,
    status: 'stopped',
    path: '/Users/test/repo',
    description: null,
    transcriptPath: null,
    usage,
    isLive: false,
  };
}

function renderDetail(usage: AgentSessionWithLiveness['usage']): string {
  const detailResponse: AgentSessionDetailResponse = {
    session: makeSession(usage),
    generatedAt: '2026-07-01T12:00:00.000Z',
  };
  return renderToStaticMarkup(
    <MemoryRouter>
      <ResourceProvider seed={[[resources.session('sess-1'), detailResponse]]}>
        <SessionDetail sessionId="sess-1" onClose={() => {}} variant="page" />
      </ResourceProvider>
    </MemoryRouter>,
  );
}

describe('SessionDetail usage token split', () => {
  it('renders input, output, cache, and totals when the server sends the split', () => {
    const html = renderDetail({
      totalCost: 1,
      totalTokens: 1_060,
      totalInputTokens: 100,
      totalOutputTokens: 20,
      totalCacheTokens: 940,
      models: [],
    });
    expect(html).toContain('100 in');
    expect(html).toContain('20 out');
    expect(html).toContain('940 cache');
    expect(html).toContain('1,060 tokens total');
  });

  it('omits the in/out/cache spans when only totalTokens is present', () => {
    const html = renderDetail({
      totalCost: 1,
      totalTokens: 500,
      models: [],
    });
    expect(html).not.toMatch(/\d+ in/);
    expect(html).not.toMatch(/\d+ out/);
    expect(html).not.toContain('cache');
    expect(html).toContain('500 tokens total');
  });

  it('shows the empty usage state when usage is null', () => {
    const html = renderDetail(null);
    expect(html).toContain('No usage recorded');
  });
});
