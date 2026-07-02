import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Cockpit } from '../Cockpit.js';
import { buildActions } from '../actions.js';
import type { DetailSelection } from '../DetailPane.js';
import type { AgentSessionWithLiveness } from '../../../dashboard/types.js';

describe('Cockpit shell', () => {
  it('renders rail (Live Sessions + Projects) + detail + action bar', () => {
    const { lastFrame, unmount } = render(<Cockpit projectsDir="/tmp/p" assignmentsDir="/tmp/a" tmuxAvailable={false} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('Live Sessions');
    expect(f).toContain('Projects');
    expect(f).toContain('Detail');
    // Action bar: Launch/Attach are context-sensitive (no selection yet ->
    // disabled), Quit is always available.
    expect(f).toContain('Launch');
    expect(f).toContain('Attach');
    expect(f).toContain('Quit');
    unmount();
  });

  it('graceful degradation: Attach is disabled when tmuxAvailable is false, even with a session selected', () => {
    // Restores the "no tmux" assertion dropped when ActionBar took over the
    // bottom row (it used to check for a literal "no tmux" status string,
    // which no longer renders). Re-expressed against the current structure:
    // `buildActions` is the exact function Cockpit calls to wire up the
    // action bar, so this exercises the real enable/disable rule, not just a
    // copy of it. Ink strips color from non-TTY `lastFrame()`, so rendering
    // Cockpit itself can't distinguish enabled vs disabled buttons -- see
    // actions.test.tsx for full render+keypress coverage of this rule.
    const selection: DetailSelection = {
      kind: 'session',
      session: { assignmentSlug: 'a1', projectSlug: 'proj' } as AgentSessionWithLiveness,
    };
    const cb = { onLaunch: vi.fn(), onAttach: vi.fn(), onQuit: vi.fn() };

    const withTmux = buildActions(selection, true, cb);
    const withoutTmux = buildActions(selection, false, cb);

    expect(withTmux.find((a) => a.key === 'a')?.enabled).toBe(true);
    expect(withoutTmux.find((a) => a.key === 'a')?.enabled).toBe(false);
  });
});
