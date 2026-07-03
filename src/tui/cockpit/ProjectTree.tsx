import React from 'react';
import { Box, Text, useInput } from 'ink';
import { TreeView, windowTreeRows } from '../components/TreeView.js';
import { useProjects } from '../hooks/useProjects.js';
import { useTreeState } from '../hooks/useTreeState.js';
import { isMouseSequence } from '../mouse/parse.js';
import { useMouseRegions } from '../mouse/hooks.js';
import { resolveRowIndex } from './railTypes.js';
import type { ProjectTreeProps } from './railTypes.js';

/** Number of rows a single wheel tick moves the cursor (the tree's window is derived FROM the cursor — see `windowTreeRows`). */
const WHEEL_STEP = 3;

/**
 * Keyboard- and mouse-navigated project/assignment tree. Owns its own
 * `useProjects` + `useTreeState` and keyboard handling, mirroring `App.tsx`'s
 * browse UX, but calls `onSelectAssignment` instead of launching a session.
 * Click hit-testing reuses `windowTreeRows` — the SAME window TreeView
 * renders — so a scrolled click can never select the wrong node.
 */
export const ProjectTree: React.FC<ProjectTreeProps> = ({ projectsDir, contentRect, active, onSelectAssignment }) => {
  const { nodes, loading, error } = useProjects(projectsDir);
  const {
    flatList,
    cursor,
    setCursor,
    moveUp,
    moveDown,
    toggle,
    expandNode,
    collapseNode,
    currentNode,
  } = useTreeState(nodes, null);

  const viewportHeight = Math.max(1, contentRect.height);

  const selectNode = (node: typeof currentNode) => {
    if (!node) return;
    if (node.kind === 'project') {
      toggle(node.id);
    } else if (node.kind === 'assignment') {
      onSelectAssignment(node.projectSlug, node.slug);
    }
  };

  useMouseRegions([
    {
      id: 'project-tree',
      rect: contentRect,
      onScroll: (e) => {
        const delta = e.action === 'scroll-up' ? -WHEEL_STEP : WHEEL_STEP;
        setCursor((c) => Math.min(Math.max(c + delta, 0), Math.max(0, flatList.length - 1)));
      },
      onClick: (e) => {
        const { start, end } = windowTreeRows(flatList.length, cursor, viewportHeight);
        const idx = resolveRowIndex(contentRect, e.y, 0);
        if (idx === null || idx >= end - start) return;
        const node = flatList[start + idx];
        if (!node) return;
        setCursor(start + idx);
        // Same semantics as the Enter handler for every column of the row —
        // project rows toggle (this also covers a click on the ▸/▾ glyph:
        // "toggle only", not select+navigate), assignment rows select.
        selectNode(node);
      },
    },
  ]);

  useInput(
    (input, key) => {
      if (isMouseSequence(input)) return;

      if (key.upArrow || input === 'k') {
        moveUp();
        return;
      }

      if (key.downArrow || input === 'j') {
        moveDown();
        return;
      }

      if (key.pageUp) {
        setCursor((c) => Math.max(0, c - viewportHeight));
        return;
      }

      if (key.pageDown) {
        setCursor((c) => Math.min(Math.max(0, flatList.length - 1), c + viewportHeight));
        return;
      }

      if (key.rightArrow && currentNode?.kind === 'project') {
        expandNode(currentNode.id);
        return;
      }

      if (key.leftArrow) {
        if (currentNode?.kind === 'project') {
          collapseNode(currentNode.id);
        } else if (currentNode?.kind === 'assignment') {
          // Jump to parent project
          const parentId = `m:${currentNode.projectSlug}`;
          const parentIndex = flatList.findIndex((n) => n.id === parentId);
          if (parentIndex >= 0) {
            setCursor(parentIndex);
          }
        }
        return;
      }

      if (key.return && currentNode) {
        selectNode(currentNode);
        return;
      }
    },
    { isActive: active },
  );

  if (loading) {
    return (
      <Box paddingLeft={1}>
        <Text dimColor>Loading projects...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box paddingLeft={1}>
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  return <TreeView nodes={flatList} cursor={cursor} viewportHeight={viewportHeight} />;
};
