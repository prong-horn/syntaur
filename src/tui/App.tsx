import React, { useState, useCallback } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useProjects } from './hooks/useProjects.js';
import { useTreeState } from './hooks/useTreeState.js';
import { useSearch } from './hooks/useSearch.js';
import { TreeView } from './components/TreeView.js';
import { SearchBar } from './components/SearchBar.js';
import { StatusBar } from './components/StatusBar.js';
import type { LaunchOptions } from './launch.js';

interface AppProps {
  projectsDir: string;
  onLaunch: (options: Omit<LaunchOptions, 'agent' | 'cwdOverride'>) => void;
}

export function App({ projectsDir, onLaunch }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const terminalHeight = stdout?.rows ?? 24;
  const viewportHeight = Math.max(5, terminalHeight - 6);

  const { nodes, loading, error } = useProjects(projectsDir);
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
        onLaunch({
          projectsDir,
          projectSlug: currentNode.projectSlug,
          assignmentSlug: currentNode.slug,
        });
      }
      return;
    }
  });

  if (loading) {
    return (
      <Box paddingLeft={1}>
        <Text>Loading projects...</Text>
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

  const projectCount = nodes.length;
  const matchCount = filteredIds?.size ?? flatList.length;

  return (
    <Box flexDirection="column">
      <Box paddingLeft={1} marginBottom={0}>
        <Text bold color="cyan">Syntaur</Text>
        <Text dimColor> {projectCount} project{projectCount !== 1 ? 's' : ''}</Text>
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
