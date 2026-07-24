import './forceColor.js'; // MUST be first — pins color on before ink imports (see file)
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

  it('renders enabled buttons as inverse-video chips and disabled ones dim with no inverse', () => {
    const { lastFrame, unmount } = render(
      <MouseProvider>
        <ActionBar
          barRect={{ x: 0, y: 0, width: 80, height: 1 }}
          actions={[
            { key: 'l', label: 'Launch', onRun: vi.fn(), enabled: true },
            { key: 'a', label: 'Attach', onRun: vi.fn(), enabled: false },
          ]}
        />
      </MouseProvider>,
    );
    const raw = lastFrame() ?? '';
    // Inverse video is SGR 7 ([7m); dim is SGR 2 ([2m). The enabled button's
    // text must be wrapped in an inverse code, the disabled one must not.
    const launchIdx = raw.indexOf('Launch');
    const attachIdx = raw.indexOf('Attach');
    expect(raw.slice(Math.max(0, launchIdx - 10), launchIdx)).toContain('[7m');
    expect(raw.slice(Math.max(0, attachIdx - 10), attachIdx)).not.toContain('[7m');
    expect(raw.slice(Math.max(0, attachIdx - 10), attachIdx)).toContain('[2m');
    unmount();
  });

  it('appends non-clickable navigation keymap hints after the buttons', () => {
    const { lastFrame } = render(
      <MouseProvider>
        <ActionBar
          barRect={{ x: 0, y: 0, width: 80, height: 1 }}
          actions={[{ key: 'q', label: 'Quit', onRun: vi.fn(), enabled: true }]}
        />
      </MouseProvider>,
    );
    const f = lastFrame() ?? '';
    expect(f).toContain('Tab');
    expect(f).toContain('Focus');
  });

  it('truncates the keymap hints (never overflows the one-row bar) on a narrow width', () => {
    // Regression: the hint string used to be appended unbounded, outside
    // layoutActions' single width computation — on a narrow bar it could
    // overflow past barRect.width instead of being clipped to what's left.
    const actions: Action[] = [{ key: 'l', label: 'Launch', onRun: vi.fn(), enabled: true }];
    const barRect = { x: 0, y: 0, width: 20, height: 1 };
    const { lastFrame, unmount } = render(
      <MouseProvider>
        <ActionBar actions={actions} barRect={barRect} />
      </MouseProvider>,
    );
    const line = (lastFrame() ?? '')
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') // eslint-disable-line no-control-regex
      .split('\n')[0];
    expect(line.length).toBeLessThanOrEqual(barRect.width);
    unmount();
  });

  it('omits the hint entirely when the buttons already fill the bar', () => {
    const actions: Action[] = [{ key: 'l', label: 'Launch', onRun: vi.fn(), enabled: true }];
    const barRect = { x: 0, y: 0, width: 12, height: 1 }; // exactly "[l] Launch  ".length
    const { lastFrame, unmount } = render(
      <MouseProvider>
        <ActionBar actions={actions} barRect={barRect} />
      </MouseProvider>,
    );
    expect(lastFrame() ?? '').not.toContain('Tab');
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
