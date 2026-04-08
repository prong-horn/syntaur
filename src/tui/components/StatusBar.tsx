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
        <Text dimColor>Enter select</Text>
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
