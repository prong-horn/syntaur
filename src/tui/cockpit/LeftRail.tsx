import React from 'react';
import { Box, Text } from 'ink';
import { statusColors } from '../colors.js';
import { useMouseRegions } from '../mouse/hooks.js';
import { resolveRowIndex } from './railTypes.js';
import type { LeftRailProps } from './railTypes.js';
import { ProjectTree } from './ProjectTree.js';

const HEADER_ROWS = 1; // "Live Sessions" title on row 0

/**
 * Left rail: a mouse-clickable Live Sessions list above a keyboard-navigated
 * project/assignment tree. Row-level mouse hit-testing (v1 scope) applies
 * only to the Live Sessions list; the tree remains keyboard-driven.
 */
export const LeftRail: React.FC<LeftRailProps> = ({
  projectsDir,
  railRect,
  sessions,
  focused,
  active,
  onSelectSession,
  onSelectAssignment,
}) => {
  useMouseRegions([
    {
      id: 'rail-sessions',
      rect: { x: railRect.x, y: railRect.y, width: railRect.width, height: sessions.length + HEADER_ROWS },
      onClick: (e) => {
        const idx = resolveRowIndex(railRect, e.y, HEADER_ROWS);
        if (idx !== null && idx < sessions.length) onSelectSession(sessions[idx]);
      },
    },
  ]);

  return (
    <Box flexDirection="column">
      <Text bold underline color={focused ? 'cyan' : undefined}>Live Sessions</Text>
      {sessions.length === 0 ? (
        <Text dimColor>  (none)</Text>
      ) : (
        sessions.map((s) => (
          <Text key={s.sessionId}>
            <Text color={s.isLive ? 'green' : 'gray'}>{s.isLive ? '●' : '○'} </Text>
            <Text color={statusColors[s.status] ?? 'white'}>{s.agent}</Text>
            <Text dimColor> {s.sessionId.slice(0, 8)}</Text>
          </Text>
        ))
      )}
      <Box marginTop={1}>
        <Text bold underline>Projects</Text>
      </Box>
      <ProjectTree projectsDir={projectsDir} active={active} onSelectAssignment={onSelectAssignment} />
    </Box>
  );
};
