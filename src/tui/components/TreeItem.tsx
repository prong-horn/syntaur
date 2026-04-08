import React from 'react';
import { Text, Box } from 'ink';
import type { FlatNode } from '../types.js';
import { statusColors, priorityColors, priorityIndicator } from '../colors.js';

interface TreeItemProps {
  node: FlatNode;
  isSelected: boolean;
}

export function TreeItem({ node, isSelected }: TreeItemProps) {
  const indent = '  '.repeat(node.depth);
  const statusColor = statusColors[node.status] ?? 'white';

  if (node.kind === 'mission') {
    const chevron = node.expanded ? '▾' : '▸';
    const progressText = node.progress
      ? `${node.progress.completed}/${node.progress.total}`
      : '';

    return (
      <Box>
        <Text inverse={isSelected} bold={isSelected}>
          {indent}
          <Text>{chevron} </Text>
          <Text bold>{node.label}</Text>
          <Text> </Text>
          <Text color={statusColor}>{node.status}</Text>
          {progressText ? <Text dimColor> {progressText} done</Text> : null}
        </Text>
      </Box>
    );
  }

  const prio = priorityIndicator(node.priority);
  const prioColor = node.priority ? priorityColors[node.priority] : undefined;

  return (
    <Box>
      <Text inverse={isSelected} bold={isSelected}>
        {indent}
        <Text dimColor>{'▪ '}</Text>
        <Text>{node.label}</Text>
        <Text> </Text>
        <Text color={statusColor}>{node.status.replace('_', ' ')}</Text>
        {prio ? <Text color={prioColor}> {prio}</Text> : null}
        {node.assignee ? <Text dimColor> @{node.assignee}</Text> : null}
      </Text>
    </Box>
  );
}
