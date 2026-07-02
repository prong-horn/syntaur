import React from 'react';
import { Box, Text } from 'ink';
import { useMouseRegions } from '../mouse/hooks.js';
import type { Rect, Region } from '../mouse/registry.js';
import { layoutActions, type Action } from './actionBarLayout.js';

export type { Action };

/**
 * Bottom-row strip of context-sensitive, mouse-clickable action buttons.
 * Buttons are laid out left-to-right within `barRect` via the shared
 * `layoutActions` helper, so the rendered `[k] Label` cells line up exactly
 * with their registered mouse regions (no borders, explicit widths).
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
      {actions.map((a) => (
        <Box key={a.key} marginRight={2}>
          <Text dimColor={!a.enabled}>
            <Text color={a.enabled ? 'cyan' : 'gray'}>[{a.key}]</Text> {a.label}
          </Text>
        </Box>
      ))}
    </Box>
  );
};
