import React from 'react';
import { Box, Text, useInput } from 'ink';
import { TreeView } from '../components/TreeView.js';
import { useProjects } from '../hooks/useProjects.js';
import { useTreeState } from '../hooks/useTreeState.js';
import { isMouseSequence } from '../mouse/parse.js';
import type { ProjectTreeProps } from './railTypes.js';

const VIEWPORT_HEIGHT = 10;

/**
 * Keyboard-navigated project/assignment tree (v1 mouse scope excludes
 * click-to-select-tree-row; see task-11 brief). Owns its own `useProjects` +
 * `useTreeState` and keyboard handling, mirroring `App.tsx`'s browse UX, but
 * calls `onSelectAssignment` instead of launching a session.
 */
export const ProjectTree: React.FC<ProjectTreeProps> = ({ projectsDir, active, onSelectAssignment }) => {
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
        if (currentNode.kind === 'project') {
          toggle(currentNode.id);
        } else if (currentNode.kind === 'assignment') {
          onSelectAssignment(currentNode.projectSlug, currentNode.slug);
        }
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

  return <TreeView nodes={flatList} cursor={cursor} viewportHeight={VIEWPORT_HEIGHT} />;
};
