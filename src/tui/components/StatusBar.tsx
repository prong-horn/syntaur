import React from 'react';
import { Box, Text } from 'ink';
import type { FlatNode } from '../types.js';

interface StatusBarProps {
  currentNode: FlatNode | null;
  searchActive: boolean;
}

export function StatusBar({ currentNode, searchActive }: StatusBarProps) {
  return (
    <Box flexDirection="column" borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} paddingLeft={1}>
      <Box gap={2}>
        <Text dimColor>↑↓ navigate</Text>
        <Text dimColor>←→ expand/collapse</Text>
        {/* Enter only expands a project. It used to launch an agent on an
            assignment; that went with the launch stack (phase 4), so the hint
            is hidden rather than promising an action that no longer exists. */}
        {currentNode?.kind === 'project' ? <Text dimColor>Enter expand</Text> : null}
        {searchActive ? (
          <Text dimColor>Esc clear search</Text>
        ) : (
          <Text dimColor>/ search</Text>
        )}
        <Text dimColor>q quit</Text>
      </Box>
      {currentNode?.kind === 'assignment' && currentNode.workspace?.worktreePath ? (
        <Text dimColor>workspace: {currentNode.workspace.worktreePath}</Text>
      ) : null}
    </Box>
  );
}
