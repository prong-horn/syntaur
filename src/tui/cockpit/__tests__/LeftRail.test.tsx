import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { MouseProvider } from '../../mouse/MouseContext.js';
import { LeftRail } from '../LeftRail.js';
import type { AgentSessionWithLiveness } from '../../../dashboard/types.js';

function session(id: string, overrides: Partial<AgentSessionWithLiveness> = {}): AgentSessionWithLiveness {
  return {
    sessionId: id,
    agent: 'claude',
    started: '2026-07-01T00:00:00Z',
    status: 'active',
    isLive: true,
    resumeSupported: true,
    forkSupported: false,
    projectSlug: null,
    assignmentSlug: id,
    path: `/tmp/${id}`,
    ...overrides,
  } as AgentSessionWithLiveness;
}

/** Left-button-down SGR sequence at 0-indexed (x, y). */
function clickAt(x: number, y: number): string {
  return `\x1b[<0;${x + 1};${y + 1}M`;
}

/** Wheel scroll-down SGR sequence at 0-indexed (x, y). cb=65 → wheel bit set + odd → scroll-down. */
function scrollDownAt(x: number, y: number): string {
  return `\x1b[<65;${x + 1};${y + 1}M`;
}

describe('LeftRail', () => {
  it('renders LIVE/RECENT group headers and a live row', () => {
    const { lastFrame, unmount } = render(
      <MouseProvider>
        <LeftRail
          contentRect={{ x: 0, y: 0, width: 30, height: 20 }}
          sessions={[session('s1')]}
          selectedSessionId={null}
          focused
          onSelectSession={vi.fn()}
        />
      </MouseProvider>,
    );
    const f = lastFrame() ?? '';
    expect(f).toContain('LIVE (1)');
    expect(f).toContain('RECENT (0)');
    expect(f).toContain('s1');
    unmount();
  });

  it('clicking a session row selects it', async () => {
    const onSelectSession = vi.fn();
    const { stdin, unmount } = render(
      <MouseProvider>
        <LeftRail
          contentRect={{ x: 0, y: 0, width: 30, height: 20 }}
          sessions={[session('s1'), session('s2')]}
          selectedSessionId={null}
          focused
          onSelectSession={onSelectSession}
        />
      </MouseProvider>,
    );
    // Row 0: LIVE header. Row 1: s1. Row 2: s2.
    stdin.write(clickAt(0, 2));
    await vi.waitFor(() => expect(onSelectSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's2' })));
    unmount();
  });

  it('clicking the RECENT header toggles it open, revealing dead sessions', async () => {
    const dead = session('dead', { isLive: false });
    const { lastFrame, stdin, unmount } = render(
      <MouseProvider>
        <LeftRail
          contentRect={{ x: 0, y: 0, width: 30, height: 20 }}
          sessions={[dead]}
          selectedSessionId={null}
          focused
          onSelectSession={vi.fn()}
        />
      </MouseProvider>,
    );
    expect(lastFrame() ?? '').not.toContain('dead');
    // Row 0: LIVE header. Row 1: RECENT header (no live sessions).
    stdin.write(clickAt(0, 1));
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('dead'));
    unmount();
  });

  it('shows the selected session inverse-highlighted', () => {
    const { lastFrame, unmount } = render(
      <MouseProvider>
        <LeftRail
          contentRect={{ x: 0, y: 0, width: 30, height: 20 }}
          sessions={[session('s1')]}
          selectedSessionId="s1"
          focused
          onSelectSession={vi.fn()}
        />
      </MouseProvider>,
    );
    // ink-testing-library's non-TTY lastFrame renders inverse via ANSI SGR 7 —
    // assert the escape code is present rather than a specific color name.
    expect(lastFrame() ?? '').toContain('[7m');
    unmount();
  });

  it('scrolled rail + click selects the correct session (viewport-aware click math)', async () => {
    const sessions = Array.from({ length: 10 }, (_, i) => session(`s${i}`));
    const onSelectSession = vi.fn();
    const { stdin, unmount } = render(
      <MouseProvider>
        <LeftRail
          // height 4: rows visible per screen is small enough that scrolling
          // is required to reach later sessions.
          contentRect={{ x: 0, y: 0, width: 30, height: 4 }}
          sessions={sessions}
          selectedSessionId={null}
          focused
          onSelectSession={onSelectSession}
        />
      </MouseProvider>,
    );
    // The mouse region registers via a post-commit effect; give it a beat
    // before the first scroll so the SGR sequence has a target to dispatch to.
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Scroll down enough to move the LIVE header + s0..s2 out of view.
    // WHEEL_STEP=3 per tick; two ticks moves the offset to 6. scrollBy is NOT
    // idempotent, so each tick is sent once with a settle delay between —
    // resending on retry (as click below does) would over-scroll.
    stdin.write(scrollDownAt(0, 0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write(scrollDownAt(0, 0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // With offset=6 the visible slice is rows[6..10): s5, s6, s7, s8 (row 0 is
    // the LIVE header, so rows[6] is the 6th session = s5). Click screen row 2
    // (0-indexed within the pane) -> visibleRows[2] -> s7. If the click math
    // wrongly indexed into the UNSCROLLED `rows` or into `sessions` directly,
    // this would select a different session instead.
    await vi.waitFor(() => {
      stdin.write(clickAt(0, 2));
      return expect(onSelectSession).toHaveBeenCalled();
    });
    const selected = onSelectSession.mock.calls.at(-1)?.[0] as AgentSessionWithLiveness;
    expect(selected.sessionId).toBe('s7');
    unmount();
  });
});
