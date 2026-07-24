import './forceColor.js'; // MUST be first — pins color on before ink imports (see file)
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { MouseProvider } from '../../mouse/MouseContext.js';
import { LeftRail } from '../LeftRail.js';
import { windowTreeRows } from '../../components/TreeView.js';
import { buildRailRows } from '../railTypes.js';
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
    expect(f).toContain('claude'); // agent column — AC2: "agent · assignment/project ... "
    expect(f).toContain('s1');
    unmount();
  });

  it('shows the agent name as its own column, distinct from the work label', () => {
    const { lastFrame, unmount } = render(
      <MouseProvider>
        <LeftRail
          contentRect={{ x: 0, y: 0, width: 30, height: 20 }}
          sessions={[session('s1', { agent: 'codex' })]}
          selectedSessionId={null}
          focused
          onSelectSession={vi.fn()}
        />
      </MouseProvider>,
    );
    const f = lastFrame() ?? '';
    expect(f).toContain('codex');
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
    const contentRect = { x: 0, y: 0, width: 30, height: 4 };
    const { stdin, unmount } = render(
      <MouseProvider>
        <LeftRail
          // height 4: rows visible per screen is small enough that scrolling
          // is required to reach later sessions.
          contentRect={contentRect}
          sessions={sessions}
          selectedSessionId={null}
          focused
          onSelectSession={onSelectSession}
        />
      </MouseProvider>,
    );
    // Enter the list (down arrow, from the non-selectable LIVE header, lands
    // on the first session and auto-selects it — spec §5.2), confirmed via
    // waitFor rather than a fixed delay, then PgDn to jump deep enough that
    // scrolling is required. Each key is sent exactly once — moveCursor is
    // NOT idempotent, so resending would over-scroll.
    stdin.write('\x1b[B'); // down arrow: cursor -> selectableIndices[0] (s0)
    await vi.waitFor(() => expect(onSelectSession).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 's0' })));
    stdin.write('\x1b[6~'); // PgDn: cursor -> selectableIndices[0 + viewHeight] (s4, viewHeight=4)
    await vi.waitFor(() => expect(onSelectSession).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 's4' })));
    onSelectSession.mockClear();

    // Independently derive the expected visible window from the SAME pure
    // functions the component uses, rather than hand-deriving offsets — this
    // is exactly the invariant under test (render slice === hit-test slice).
    // Cursor is now at rows-index 5 (rows[0]=LIVE header, rows[1..10]=s0..s9).
    const rows = buildRailRows(sessions, { recentExpanded: false });
    const { start } = windowTreeRows(rows.length, 5, contentRect.height);
    const clickedRow = rows[start + 2]; // screen row 2 (0-indexed) within the pane
    if (clickedRow.kind !== 'session') throw new Error('test assumption violated: expected a session row');

    stdin.write(clickAt(0, 2));
    await vi.waitFor(() => expect(onSelectSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: clickedRow.session.sessionId })));
    unmount();
  });

  it('arrow-key navigation moves the cursor and auto-selects session rows', async () => {
    const sessions = [session('s1'), session('s2'), session('s3')];
    const onSelectSession = vi.fn();
    const { stdin, unmount } = render(
      <MouseProvider>
        <LeftRail
          contentRect={{ x: 0, y: 0, width: 30, height: 20 }}
          sessions={sessions}
          selectedSessionId={null}
          focused
          onSelectSession={onSelectSession}
        />
      </MouseProvider>,
    );
    // Row 0: LIVE header (skipped — not selectable). Down arrow lands on the
    // first selectable row, s1.
    stdin.write('\x1b[B');
    await vi.waitFor(() => expect(onSelectSession).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 's1' })));
    stdin.write('\x1b[B');
    await vi.waitFor(() => expect(onSelectSession).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 's2' })));
    stdin.write('k');
    await vi.waitFor(() => expect(onSelectSession).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 's1' })));
    unmount();
  });

  it('wheel scroll moves the cursor one row and auto-selects it', async () => {
    const sessions = [session('s1'), session('s2')];
    const onSelectSession = vi.fn();
    const { stdin, unmount } = render(
      <MouseProvider>
        <LeftRail
          contentRect={{ x: 0, y: 0, width: 30, height: 20 }}
          sessions={sessions}
          selectedSessionId={null}
          focused
          onSelectSession={onSelectSession}
        />
      </MouseProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write(scrollDownAt(0, 0));
    await vi.waitFor(() => expect(onSelectSession).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 's1' })));
    unmount();
  });

  it('Enter toggles the RECENT header once the cursor moves onto it', async () => {
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
    // No live sessions -> the only selectable row is the RECENT header. The
    // cursor starts on the (non-selectable) LIVE header, so Down enters at
    // the top of the selectable set — which, with nothing live, is RECENT.
    expect(lastFrame() ?? '').not.toContain('dead');
    stdin.write('\x1b[B');
    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('dead'));
    unmount();
  });

  it('keeps the keyboard cursor synced to the selected session when a poll re-sorts it to a new row', async () => {
    // Regression: the cursor used to only re-sync when `selectedSessionId`
    // itself changed, not when the SAME session moved to a different row
    // because its waiting/working/recency rank changed — leaving subsequent
    // arrow/PgUp/PgDn moves acting from a stale, now-wrong index.
    const s1 = session('s1', { started: '2026-07-01T00:03:00Z' });
    const s2 = session('s2', { started: '2026-07-01T00:02:00Z' });
    const s3 = session('s3', { started: '2026-07-01T00:01:00Z' });
    const onSelectSession = vi.fn();
    const { stdin, rerender, unmount } = render(
      <MouseProvider>
        <LeftRail
          contentRect={{ x: 0, y: 0, width: 30, height: 20 }}
          sessions={[s1, s2, s3]}
          selectedSessionId="s3"
          focused
          onSelectSession={onSelectSession}
        />
      </MouseProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    // s3 becomes the waiting session -> it re-sorts to the TOP (rows:
    // header, s3, s1, s2, RECENT), while still being the selected session.
    const s3Waiting = { ...s3, waitingFor: 'permission prompt' };
    rerender(
      <MouseProvider>
        <LeftRail
          contentRect={{ x: 0, y: 0, width: 30, height: 20 }}
          sessions={[s1, s2, s3Waiting]}
          selectedSessionId="s3"
          focused
          onSelectSession={onSelectSession}
        />
      </MouseProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Down from s3's NEW position (row 1) should land on whatever is now
    // directly below it (s1, row 2) — a stale cursor left at the OLD row
    // (3) would instead land on the RECENT header and never call
    // onSelectSession at all.
    stdin.write('\x1b[B');
    await vi.waitFor(() => expect(onSelectSession).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 's1' })));
    unmount();
  });

  it('re-sorts a session to the top and renders ⚠ <needs> when a daemon join blocks it (Phase C)', async () => {
    const s1 = session('s1', { started: '2026-07-01T00:03:00Z' });
    const s2 = session('s2', { started: '2026-07-01T00:02:00Z' });
    const s3 = session('s3', { started: '2026-07-01T00:01:00Z' });
    const { lastFrame, rerender, unmount } = render(
      <MouseProvider>
        <LeftRail
          contentRect={{ x: 0, y: 0, width: 30, height: 20 }}
          sessions={[s1, s2, s3]}
          selectedSessionId="s3"
          focused
          onSelectSession={vi.fn()}
        />
      </MouseProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    // s3 becomes daemon-blocked with a `needs` reason -> it re-sorts to the
    // TOP (rows: header, s3, s1, s2, RECENT) and renders the specific ⚠ text.
    const s3Blocked = { ...s3, state: 'blocked' as const, needs: 'permission: Bash' };
    rerender(
      <MouseProvider>
        <LeftRail
          contentRect={{ x: 0, y: 0, width: 30, height: 20 }}
          sessions={[s1, s2, s3Blocked]}
          selectedSessionId="s3"
          focused
          onSelectSession={vi.fn()}
        />
      </MouseProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const f = lastFrame() ?? '';
    expect(f).toContain('⚠ permission: Bash');
    const rows = buildRailRows([s1, s2, s3Blocked], { recentExpanded: false, now: Date.now() });
    const sessionRows = rows.filter((r) => r.kind === 'session');
    expect(sessionRows[0]?.session.sessionId).toBe('s3');
    unmount();
  });
});
