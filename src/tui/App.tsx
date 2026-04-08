import React, { useState, useCallback } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useMissions } from './hooks/useMissions.js';
import { useTreeState } from './hooks/useTreeState.js';
import { useSearch } from './hooks/useSearch.js';
import { TreeView } from './components/TreeView.js';
import { SearchBar } from './components/SearchBar.js';
import { StatusBar } from './components/StatusBar.js';
import type { LaunchOptions } from './launch.js';

interface AppProps {
  missionsDir: string;
  onLaunch: (options: LaunchOptions) => void;
}

export function App({ missionsDir, onLaunch }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const terminalHeight = stdout?.rows ?? 24;
  const viewportHeight = Math.max(5, terminalHeight - 6);

  const { nodes, loading, error } = useMissions(missionsDir);
  const { query, setQuery, searchActive, setSearchActive, filteredIds } = useSearch(nodes);
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
  } = useTreeState(nodes, filteredIds);

  useInput((input, key) => {
    if (searchActive) {
      if (key.escape) {
        setSearchActive(false);
        setQuery('');
        return;
      }
      if (key.return) {
        setSearchActive(false);
        return;
      }
      // Text input is handled by TextInput component
      return;
    }

    // Navigation mode
    if (input === 'q' || key.escape) {
      exit();
      return;
    }

    if (input === '/') {
      setSearchActive(true);
      return;
    }

    if (key.upArrow || input === 'k') {
      moveUp();
      return;
    }

    if (key.downArrow || input === 'j') {
      moveDown();
      return;
    }

    if (key.rightArrow && currentNode?.kind === 'mission') {
      expandNode(currentNode.id);
      return;
    }

    if (key.leftArrow) {
      if (currentNode?.kind === 'mission') {
        collapseNode(currentNode.id);
      } else if (currentNode?.kind === 'assignment') {
        // Jump to parent mission
        const parentId = `m:${currentNode.missionSlug}`;
        const parentIndex = flatList.findIndex((n) => n.id === parentId);
        if (parentIndex >= 0) {
          setCursor(parentIndex);
        }
      }
      return;
    }

    if (key.return && currentNode) {
      if (currentNode.kind === 'mission') {
        toggle(currentNode.id);
      } else if (currentNode.kind === 'assignment') {
        onLaunch({
          missionsDir,
          missionSlug: currentNode.missionSlug,
          assignmentSlug: currentNode.slug,
        });
      }
      return;
    }
  });

  if (loading) {
    return (
      <Box paddingLeft={1}>
        <Text>Loading missions...</Text>
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

  const missionCount = nodes.length;
  const matchCount = filteredIds?.size ?? flatList.length;

  return (
    <Box flexDirection="column">
      <Box paddingLeft={1} marginBottom={0}>
        <Text bold color="cyan">Syntaur</Text>
        <Text dimColor> {missionCount} mission{missionCount !== 1 ? 's' : ''}</Text>
      </Box>
      <SearchBar
        active={searchActive}
        query={query}
        onChange={setQuery}
        resultCount={matchCount}
      />
      <TreeView
        nodes={flatList}
        cursor={cursor}
        viewportHeight={viewportHeight}
      />
      <StatusBar currentNode={currentNode} searchActive={searchActive} />
    </Box>
  );
}
