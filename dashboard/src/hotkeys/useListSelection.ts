import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useHotkey } from './useHotkey';
import type { HotkeyScope } from './HotkeyProvider';

export interface UseListSelectionOptions<T> {
  scope: HotkeyScope;
  onOpen: (item: T, index: number) => void;
  /** When false, the `o` binding is not registered (use for todo pages where `o` is a no-op). */
  bindO?: boolean;
}

export interface UseListSelectionResult {
  selectedIndex: number;
  hotkeyRowProps: (i: number) => {
    'data-hotkey-row-index': number;
    'data-hotkey-selected': 'true' | 'false';
  };
}

/**
 * Tracks selection over an array of list items. Responds to j/k/Enter/o and scrolls
 * the selected row into view by querying [data-hotkey-row-index].
 *
 * R5b: index resets on route change and clamps when items.length changes.
 * R4: works across all view modes (cards, kanban, table) because selection is DOM-query-based.
 */
export function useListSelection<T>(
  items: T[],
  opts: UseListSelectionOptions<T>,
): UseListSelectionResult {
  const [selectedIndex, setSelectedIndex] = useState(items.length === 0 ? -1 : 0);
  const location = useLocation();

  // Reset on route change
  useEffect(() => {
    setSelectedIndex(items.length === 0 ? -1 : 0);
    // only depend on pathname: intentional — want fresh start on nav.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  // Clamp when items.length changes (R5b)
  useEffect(() => {
    setSelectedIndex((i) => {
      if (items.length === 0) return -1;
      return Math.min(Math.max(0, i), items.length - 1);
    });
  }, [items.length]);

  // Scroll selected row into view + toggle selection data attribute for CSS.
  useEffect(() => {
    const nodes = document.querySelectorAll<HTMLElement>('[data-hotkey-row-index]');
    nodes.forEach((n) => {
      const idx = Number(n.getAttribute('data-hotkey-row-index'));
      n.setAttribute('data-hotkey-selected', idx === selectedIndex ? 'true' : 'false');
    });
    if (selectedIndex >= 0) {
      const sel = document.querySelector<HTMLElement>(
        `[data-hotkey-row-index="${selectedIndex}"]`,
      );
      sel?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex, items.length]);

  useHotkey({
    keys: 'j',
    scope: opts.scope,
    description: 'Select next row',
    handler: () =>
      setSelectedIndex((i) => {
        if (items.length === 0) return -1;
        return Math.min(items.length - 1, i < 0 ? 0 : i + 1);
      }),
  });
  useHotkey({
    keys: 'k',
    scope: opts.scope,
    description: 'Select previous row',
    handler: () =>
      setSelectedIndex((i) => {
        if (items.length === 0) return -1;
        return Math.max(0, i < 0 ? 0 : i - 1);
      }),
  });
  useHotkey({
    keys: 'Enter',
    scope: opts.scope,
    description: 'Open selected row',
    handler: () => {
      if (selectedIndex >= 0 && selectedIndex < items.length) {
        opts.onOpen(items[selectedIndex], selectedIndex);
      }
    },
  });
  useHotkey({
    keys: 'o',
    scope: opts.scope,
    description: 'Open selected row',
    enabled: opts.bindO ?? true,
    handler: () => {
      if (selectedIndex >= 0 && selectedIndex < items.length) {
        opts.onOpen(items[selectedIndex], selectedIndex);
      }
    },
  });

  const hotkeyRowProps = useCallback(
    (i: number) =>
      ({
        'data-hotkey-row-index': i,
        'data-hotkey-selected': (i === selectedIndex ? 'true' : 'false') as 'true' | 'false',
      }) as const,
    [selectedIndex],
  );

  return { selectedIndex, hotkeyRowProps };
}
