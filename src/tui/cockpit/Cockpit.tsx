import React, { useState } from 'react';
import { Box, Text, useInput, useApp, useWindowSize } from 'ink';
import { MouseProvider } from '../mouse/MouseContext.js';
import { isMouseSequence } from '../mouse/parse.js';
import { computeLayout, type FocusTarget } from './layout.js';

export const Cockpit: React.FC<{ projectsDir: string; assignmentsDir: string; tmuxAvailable: boolean }> = ({
  projectsDir,
  assignmentsDir,
  tmuxAvailable,
}) => {
  const { exit } = useApp();
  const size = useWindowSize();
  const columns = size.columns || 80;
  const rows = size.rows || 24;
  const layout = computeLayout(columns, rows);
  const [focus, setFocus] = useState<FocusTarget>('rail');

  useInput((input, key) => {
    if (isMouseSequence(input)) return; // mouse bytes also reach Ink input
    if (input === 'q' || key.escape) exit();
    if (key.tab) setFocus((f) => (f === 'rail' ? 'detail' : 'rail'));
  });

  // CRITICAL: no borders on hit-tested regions and EXPLICIT width/height from
  // `layout.regions` (never flexGrow) — so each rendered Box occupies exactly
  // its layout rect and mouse (x,y) maps 1:1. Focus is shown via header color,
  // not a border (a border insets content by 1 cell and desyncs coordinates).
  const { rail, detail, actionBar } = layout.regions;
  return (
    <MouseProvider>
      <Box flexDirection="column" width={columns} height={rows}>
        <Box flexDirection={layout.columns === 2 ? 'row' : 'column'} height={rows - actionBar.height}>
          <Box width={rail.width} height={rail.height} flexDirection="column">
            <Text bold color={focus === 'rail' ? 'cyan' : undefined}>{`Rail (projectsDir=${projectsDir})`}</Text>
          </Box>
          <Box width={detail.width} height={detail.height} flexDirection="column">
            <Text bold color={focus === 'detail' ? 'cyan' : undefined}>{`Detail (assignmentsDir=${assignmentsDir})`}</Text>
          </Box>
        </Box>
        <Box height={actionBar.height}>
          <Text dimColor>
            {`q quit · tab focus · ${tmuxAvailable ? 'tmux ready' : 'no tmux (launch/attach limited)'}`}
          </Text>
        </Box>
      </Box>
    </MouseProvider>
  );
};
