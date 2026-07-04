import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { FlatNode } from '../types.js';
import { TreeItem } from './TreeItem.js';

interface TreeViewProps {
  nodes: FlatNode[];
  cursor: number;
  viewportHeight: number;
}

export interface TreeWindow {
  start: number;
  end: number;
}

/**
 * Cursor-centered scroll window over `count` rows. Exported so ProjectTree's
 * click hit-testing can compute the EXACT same visible slice TreeView renders
 * — a single source of truth, mirroring `actionBarLayout.ts`'s render/hit-rect
 * invariant, so the two can never diverge.
 */
export function windowTreeRows(count: number, cursor: number, viewportHeight: number): TreeWindow {
  const half = Math.floor(viewportHeight / 2);
  let start = cursor - half;
  if (start < 0) start = 0;
  let end = start + viewportHeight;
  if (end > count) {
    end = count;
    start = Math.max(0, end - viewportHeight);
  }
  return { start, end };
}

export function TreeView({ nodes, cursor, viewportHeight }: TreeViewProps) {
  const { start, end } = useMemo(
    () => windowTreeRows(nodes.length, cursor, viewportHeight),
    [cursor, viewportHeight, nodes.length],
  );

  if (nodes.length === 0) {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Text dimColor>No projects found. Run `syntaur create-project` to get started.</Text>
      </Box>
    );
  }

  const visible = nodes.slice(start, end);

  return (
    <Box flexDirection="column">
      {visible.map((node, i) => (
        <TreeItem
          key={node.id}
          node={node}
          isSelected={start + i === cursor}
        />
      ))}
    </Box>
  );
}
