import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { SessionRow } from '../SessionRow';
import type { AgentSessionWithLiveness } from '../../../types';

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

const noop = () => {};

describe('SessionRow In / Out column', () => {
  it('shows compact input/output when the server sends the split', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <table>
          <tbody>
            <SessionRow
              session={makeSession({
                totalCost: 1,
                totalTokens: 1_060,
                totalInputTokens: 100,
                totalOutputTokens: 20,
                totalCacheTokens: 940,
                models: [],
              })}
              selected={false}
              expanded={false}
              onToggle={noop}
              onToggleExpand={noop}
              onDelete={noop}
              onMarkStopped={noop}
              onTogglePin={noop}
              onToggleArchive={noop}
              onRename={noop}
            />
          </tbody>
        </table>
      </MemoryRouter>,
    );
    expect(html).toContain('>100<span class="px-0.5 opacity-40">/</span>20<');
  });

  it('shows an em dash when input/output are absent on the wire', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <table>
          <tbody>
            <SessionRow
              session={makeSession({
                totalCost: 1,
                totalTokens: 500,
                models: [],
              })}
              selected={false}
              expanded={false}
              onToggle={noop}
              onToggleExpand={noop}
              onDelete={noop}
              onMarkStopped={noop}
              onTogglePin={noop}
              onToggleArchive={noop}
              onRename={noop}
            />
          </tbody>
        </table>
      </MemoryRouter>,
    );
    expect(html).toMatch(/title="Total 500"><span>—<\/span><\/td>/);
    expect(html).not.toContain('opacity-40">/</span>');
  });
});
