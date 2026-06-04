import { useCallback, useEffect, useState } from 'react';
import { TODO_SECTIONS, type TodoSectionId } from '@shared/todo-sections';

// Per-client persistence for the todos accordion collapse state. Kept out of the
// assignments-board `view-prefs` system (which is scoped to that board); this is
// a small localStorage pref, mirroring the SSR/quota-safe guard in useViewPrefs.

const STORAGE_KEY = 'syntaur.todos.sections.collapsed.v1';

type CollapseMap = Partial<Record<TodoSectionId, boolean>>;
type CollapseStore = Record<string, CollapseMap>;

const DEFAULT_COLLAPSED: Record<TodoSectionId, boolean> = Object.fromEntries(
  TODO_SECTIONS.map((s) => [s.id, s.defaultCollapsed]),
) as Record<TodoSectionId, boolean>;

function readStore(): CollapseStore {
  if (typeof window === 'undefined' || !window.localStorage) return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as CollapseStore) : {};
  } catch {
    return {};
  }
}

function writeStore(store: CollapseStore): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage may be unavailable in private mode or quota-full; skip.
  }
}

export interface TodoSectionCollapse {
  isCollapsed: (id: TodoSectionId) => boolean;
  toggle: (id: TodoSectionId) => void;
}

// `viewKey` namespaces the collapse state per view (e.g. `workspace:<ws>`,
// `project:<id>`, `all`). Falls back to each section's `defaultCollapsed` when
// no preference is stored.
export function useTodoSectionCollapse(viewKey: string): TodoSectionCollapse {
  const [map, setMap] = useState<CollapseMap>(() => readStore()[viewKey] ?? {});

  // Reload when the view changes — the page component is reused (not remounted)
  // when navigating between workspaces/projects, so without this the prior
  // view's collapse map would bleed into the new one.
  useEffect(() => {
    setMap(readStore()[viewKey] ?? {});
  }, [viewKey]);

  const isCollapsed = useCallback(
    (id: TodoSectionId): boolean => map[id] ?? DEFAULT_COLLAPSED[id],
    [map],
  );

  // Read-modify-write against storage keyed by the current viewKey so a stale
  // React `map` (e.g. mid-viewKey-change) can never clobber another view's state.
  const toggle = useCallback(
    (id: TodoSectionId): void => {
      const store = readStore();
      const currentMap = store[viewKey] ?? {};
      const current = currentMap[id] ?? DEFAULT_COLLAPSED[id];
      const nextMap: CollapseMap = { ...currentMap, [id]: !current };
      store[viewKey] = nextMap;
      writeStore(store);
      setMap(nextMap);
    },
    [viewKey],
  );

  return { isCollapsed, toggle };
}
