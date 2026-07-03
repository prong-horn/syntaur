import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { MouseProvider } from '../../mouse/MouseContext.js';
import { ActionBar } from '../ActionBar.js';
import { layoutActions, type Action } from '../actionBarLayout.js';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
/**
 * `lastFrame()` captures the mock stdout's raw bytes verbatim, including
 * out-of-band control sequences (e.g. MouseProvider's mouse-tracking-mode
 * enable codes, which land bundled with the frame text in this harness) and
 * any color codes. Strip them so column-position assertions check only the
 * visible glyphs a real terminal would show.
 */
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

describe('ActionBar', () => {
  it('renders enabled + disabled actions with key hints', () => {
    const { lastFrame } = render(
      <MouseProvider>
        <ActionBar
          barRect={{ x: 0, y: 23, width: 80, height: 1 }}
          actions={[
            { key: 'l', label: 'Launch', onRun: vi.fn(), enabled: true },
            { key: 'a', label: 'Attach', onRun: vi.fn(), enabled: false },
          ]}
        />
      </MouseProvider>,
    );
    const f = lastFrame() ?? '';
    expect(f).toContain('Launch');
    expect(f).toContain('Attach');
    expect(f).toContain('l');
    expect(f).toContain('a');
  });

  it('renders each button flush within its layoutActions() rect, even for a multi-char key', () => {
    // Regression for the precision bug: rendering used to compute its own
    // width (assuming a 1-char `[k]` prefix) instead of consuming the same
    // rect layoutActions() hands to the mouse hit-registry. A multi-char key
    // exposes the drift that a 1-char key coincidentally hides.
    const actions: Action[] = [
      { key: 'ctrl', label: 'Launch', onRun: vi.fn(), enabled: true },
      { key: 'q', label: 'Quit', onRun: vi.fn(), enabled: true },
    ];
    const barRect = { x: 0, y: 0, width: 80, height: 1 };
    const layout = layoutActions(actions, barRect);
    const { lastFrame, unmount } = render(
      <MouseProvider>
        <ActionBar actions={actions} barRect={barRect} />
      </MouseProvider>,
    );
    const line = stripAnsi(lastFrame() ?? '').split('\n')[0];
    for (const { action, rect } of layout) {
      const cell = line.slice(rect.x, rect.x + rect.width);
      expect(cell.startsWith(`[${action.key}]`)).toBe(true);
    }
    unmount();
  });

  it('ignores a mouse click on a disabled action and does not invoke its onRun', async () => {
    const onRunEnabled = vi.fn();
    const onRunDisabled = vi.fn();
    const actions: Action[] = [
      { key: 'l', label: 'Launch', onRun: onRunEnabled, enabled: true },
      { key: 'a', label: 'Attach', onRun: onRunDisabled, enabled: false },
    ];
    const barRect = { x: 0, y: 23, width: 80, height: 1 };
    const layout = layoutActions(actions, barRect);
    const { stdin, unmount } = render(
      <MouseProvider>
        <ActionBar actions={actions} barRect={barRect} />
      </MouseProvider>,
    );

    const disabled = layout[1].rect;
    stdin.write(`\x1b[<0;${disabled.x + 1};${disabled.y + 1}M`);
    const enabled = layout[0].rect;
    stdin.write(`\x1b[<0;${enabled.x + 1};${enabled.y + 1}M`);

    await vi.waitFor(() => {
      expect(onRunEnabled).toHaveBeenCalledTimes(1);
    });
    expect(onRunDisabled).not.toHaveBeenCalled();
    unmount();
  });
});
