import React from 'react';
import { Box, Text } from 'ink';
import { useMouseRegions } from '../mouse/hooks.js';
import type { Rect, Region } from '../mouse/registry.js';
import { layoutActions, buttonText, padCell, type Action } from './actionBarLayout.js';
import { formatKeymapHints } from './keymap.js';

export type { Action };

/**
 * Bottom-row strip of context-sensitive, mouse-clickable action buttons.
 * Buttons are laid out left-to-right within `barRect` via the shared
 * `layoutActions` helper, and each button is rendered into EXACTLY the same
 * `rect.width` cells that get registered as its mouse hit-region — one width
 * computation feeds both, so rendered x-range and hit x-range can never
 * diverge (no borders on hit cells; no independent Box sizing/margins).
 * Enabled buttons render as inverse-video chips (visible buttons, not just
 * colored text); disabled buttons render dim with no inverse and ignore
 * clicks/keys. Non-clickable navigation hints (Tab/move/scroll/Enter/Esc —
 * see keymap.ts) are appended after the buttons, dim.
 */
export const ActionBar: React.FC<{ actions: Action[]; barRect: Rect }> = ({ actions, barRect }) => {
  const layout = layoutActions(actions, barRect);
  const regions: Region[] = layout.map(({ action, rect }) => ({
    id: `action-${action.key}`,
    rect,
    onClick: () => { if (action.enabled) action.onRun(); },
  }));
  useMouseRegions(regions);

  return (
    <Box>
      {layout.map(({ action, rect }) => (
        <Text key={action.key} inverse={action.enabled} dimColor={!action.enabled}>
          {padCell(buttonText(action), rect.width)}
        </Text>
      ))}
      <Text dimColor>  {formatKeymapHints()}</Text>
    </Box>
  );
};
