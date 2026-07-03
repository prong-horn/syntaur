import React from 'react';
import { Box, Text } from 'ink';
import { useMouseRegions } from '../mouse/hooks.js';
import type { Rect, Region } from '../mouse/registry.js';
import { layoutActions, buttonText, padCell, type Action } from './actionBarLayout.js';

export type { Action };

/**
 * Bottom-row strip of context-sensitive, mouse-clickable action buttons.
 * Buttons are laid out left-to-right within `barRect` via the shared
 * `layoutActions` helper, and each button is rendered into EXACTLY the same
 * `rect.width` cells that get registered as its mouse hit-region — one width
 * computation feeds both, so rendered x-range and hit x-range can never
 * diverge (no borders on hit cells; no independent Box sizing/margins).
 * Disabled actions render dim and ignore clicks/keys.
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
      {layout.map(({ action, rect }) => {
        const keyPart = `[${action.key}]`;
        const cell = padCell(buttonText(action), rect.width);
        return (
          <Text key={action.key} dimColor={!action.enabled}>
            <Text color={action.enabled ? 'cyan' : 'gray'}>{keyPart}</Text>
            {cell.slice(keyPart.length)}
          </Text>
        );
      })}
    </Box>
  );
};
