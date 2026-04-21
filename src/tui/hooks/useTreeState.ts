import { useState, useMemo, useCallback } from 'react';
import type { TreeNode, FlatNode } from '../types.js';

export function useTreeState(nodes: TreeNode[], filteredIds: Set<string> | null) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);

  const flatList = useMemo(() => {
    const result: FlatNode[] = [];
    for (const project of nodes) {
      if (filteredIds && !filteredIds.has(project.id)) {
        const hasMatchingChild = project.children?.some((c) => filteredIds.has(c.id));
        if (!hasMatchingChild) continue;
      }

      const isExpanded = expanded.has(project.id) ||
        (filteredIds !== null && project.children?.some((c) => filteredIds.has(c.id)));

      result.push({
        ...project,
        depth: 0,
        expanded: isExpanded,
        hasChildren: (project.children?.length ?? 0) > 0,
      });

      if (isExpanded && project.children) {
        for (const child of project.children) {
          if (filteredIds && !filteredIds.has(child.id) && !filteredIds.has(project.id)) continue;
          result.push({
            ...child,
            depth: 1,
            expanded: false,
            hasChildren: false,
          });
        }
      }
    }
    return result;
  }, [nodes, expanded, filteredIds]);

  const moveUp = useCallback(() => {
    setCursor((c) => Math.max(0, c - 1));
  }, []);

  const moveDown = useCallback(() => {
    setCursor((c) => Math.min(flatList.length - 1, c + 1));
  }, [flatList.length]);

  const toggle = useCallback(
    (nodeId: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(nodeId)) {
          next.delete(nodeId);
        } else {
          next.add(nodeId);
        }
        return next;
      });
    },
    [],
  );

  const expandNode = useCallback((nodeId: string) => {
    setExpanded((prev) => {
      if (prev.has(nodeId)) return prev;
      const next = new Set(prev);
      next.add(nodeId);
      return next;
    });
  }, []);

  const collapseNode = useCallback((nodeId: string) => {
    setExpanded((prev) => {
      if (!prev.has(nodeId)) return prev;
      const next = new Set(prev);
      next.delete(nodeId);
      return next;
    });
  }, []);

  const currentNode = flatList[cursor] ?? null;

  return {
    flatList,
    cursor,
    setCursor,
    moveUp,
    moveDown,
    toggle,
    expandNode,
    collapseNode,
    currentNode,
  };
}
