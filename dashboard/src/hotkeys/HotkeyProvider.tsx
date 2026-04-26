import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTheme } from '../theme';
import { matchesPattern } from './match';
import {
  useProjects,
  useAssignmentsBoard,
  usePlaybooks,
  useServers,
} from '../hooks/useProjects';
import { useAllTodos } from '../hooks/useTodos';
import { buildIndex, resolveRoute, type PaletteEntry } from './paletteIndex';
import { buildActionsIndex, type Action } from './actionsIndex';
import { CommandPalette } from './CommandPalette';
import { ActionPalette } from './ActionPalette';
import { CheatsheetDialog } from './CheatsheetDialog';
import { buildShellMeta } from '../lib/routes';

export type HotkeyScope =
  | 'global'
  | 'list:projects'
  | 'list:assignments'
  | 'list:todos'
  | 'assignment'
  | 'project';

export interface HotkeyBinding {
  id: number;
  keys: string;
  handler: (event: KeyboardEvent) => void;
  scope: HotkeyScope;
  description: string;
  when?: () => boolean;
}

export const HOTKEY_CHORD_TIMEOUT_MS = 1500;

// R1: parse workspace from pathname because useParams returns {} outside matched routes.
export function getWorkspaceFromPathname(pathname: string): string {
  const m = pathname.match(/^\/w\/([^/]+)(?:\/|$)/);
  return m ? `/w/${m[1]}` : '';
}

interface HotkeyContextValue {
  register: (b: Omit<HotkeyBinding, 'id'>) => number;
  unregister: (id: number) => void;
  pushScope: (s: HotkeyScope) => void;
  popScope: (s: HotkeyScope) => void;
  openPalette: () => void;
  closePalette: () => void;
  paletteOpen: boolean;
  openCheatsheet: () => void;
  closeCheatsheet: () => void;
  cheatsheetOpen: boolean;
  openActionsPalette: () => void;
  closeActionsPalette: () => void;
  actionsPaletteOpen: boolean;
  listBindings: () => HotkeyBinding[];
  wsPrefix: string;
  paletteEntries: PaletteEntry[];
  actionEntries: Action[];
}

const HotkeyContext = createContext<HotkeyContextValue | null>(null);

type ChordState = { phase: 'idle' } | { phase: 'awaiting-second'; startedAt: number };

export function HotkeyProvider({ children }: { children: ReactNode }) {
  const { toggleTheme } = useTheme();
  const location = useLocation();
  const navigate = useNavigate();
  const wsPrefix = getWorkspaceFromPathname(location.pathname);

  // Eager data hooks for the palette index.
  const projectsState = useProjects();
  const assignmentsState = useAssignmentsBoard();
  const playbooksState = usePlaybooks();
  const serversState = useServers();
  const todosState = useAllTodos();

  const paletteEntries = useMemo<PaletteEntry[]>(() => {
    const projects = projectsState.data ?? [];
    const assignments = assignmentsState.data?.assignments ?? [];
    const playbooks = playbooksState.data?.playbooks ?? [];
    const servers = serversState.data?.sessions ?? [];
    const todoList = todosState.data?.workspaces ?? [];
    const todos = todoList.flatMap((w) =>
      w.items.map((it) => ({ ...it, workspace: w.workspace })),
    );
    return buildIndex({ projects, assignments, playbooks, servers, todos, wsPrefix });
  }, [
    projectsState.data,
    assignmentsState.data,
    playbooksState.data,
    serversState.data,
    todosState.data,
    wsPrefix,
  ]);

  const shellMeta = useMemo(() => buildShellMeta(location.pathname), [location.pathname]);
  const currentProjectSlug = shellMeta.projectSlug;
  const currentProject = useMemo(() => {
    if (!currentProjectSlug) return null;
    return projectsState.data?.find((p) => p.slug === currentProjectSlug) ?? null;
  }, [projectsState.data, currentProjectSlug]);
  const currentProjectTitle = currentProject?.title ?? null;
  const currentProjectWorkspace = currentProject?.workspace ?? null;

  const actionEntries = useMemo<Action[]>(
    () =>
      buildActionsIndex({
        playbooks: playbooksState.data?.playbooks ?? [],
        projectSlug: currentProjectSlug,
        currentProjectTitle,
        currentProjectWorkspace,
        wsPrefix,
        refetchPlaybooks: playbooksState.refetch,
        navigate,
        toggleTheme,
      }),
    [
      playbooksState.data,
      playbooksState.refetch,
      currentProjectSlug,
      currentProjectTitle,
      currentProjectWorkspace,
      wsPrefix,
      navigate,
      toggleTheme,
    ],
  );

  const registryRef = useRef<Map<number, HotkeyBinding>>(new Map());
  const scopeStackRef = useRef<HotkeyScope[]>(['global']);
  const chordRef = useRef<ChordState>({ phase: 'idle' });
  const chordTimerRef = useRef<number | null>(null);
  const nextIdRef = useRef(1);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  const [actionsPaletteOpen, setActionsPaletteOpen] = useState(false);

  const register = useCallback((b: Omit<HotkeyBinding, 'id'>) => {
    const id = nextIdRef.current++;
    registryRef.current.set(id, { ...b, id });
    return id;
  }, []);
  const unregister = useCallback((id: number) => {
    registryRef.current.delete(id);
  }, []);
  const pushScope = useCallback((s: HotkeyScope) => {
    scopeStackRef.current.push(s);
  }, []);
  const popScope = useCallback((s: HotkeyScope) => {
    const stack = scopeStackRef.current;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i] === s) {
        stack.splice(i, 1);
        return;
      }
    }
  }, []);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const openCheatsheet = useCallback(() => setCheatsheetOpen(true), []);
  const closeCheatsheet = useCallback(() => setCheatsheetOpen(false), []);
  const openActionsPalette = useCallback(() => setActionsPaletteOpen(true), []);
  const closeActionsPalette = useCallback(() => setActionsPaletteOpen(false), []);
  const listBindings = useCallback(() => Array.from(registryRef.current.values()), []);

  // Clear chord on route change
  useEffect(() => {
    chordRef.current = { phase: 'idle' };
    if (chordTimerRef.current !== null) {
      window.clearTimeout(chordTimerRef.current);
      chordTimerRef.current = null;
    }
  }, [location.pathname]);

  useEffect(() => {
    function isEditableTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (target.isContentEditable) return true;
      // R5e: role-based editable ancestors
      if (target.closest('[role="combobox"], [role="textbox"]')) return true;
      return false;
    }

    function isOpenDialogPresent(): boolean {
      // R3 fix: Radix AlertDialog uses role="alertdialog", not "dialog".
      return !!(
        document.querySelector('[role="dialog"][data-state="open"]') ||
        document.querySelector('[role="alertdialog"][data-state="open"]')
      );
    }

    function activeScope(): HotkeyScope {
      const stack = scopeStackRef.current;
      return stack[stack.length - 1] ?? 'global';
    }

    function isBindingActive(b: HotkeyBinding): boolean {
      if (b.scope === 'global') return true;
      return b.scope === activeScope();
    }

    function handleKeydown(event: KeyboardEvent) {
      const isCmdK = matchesPattern(event, 'Mod+k');
      const isCmdShiftK = matchesPattern(event, 'Mod+Shift+k');
      const isEsc = event.key === 'Escape';
      const isAlwaysAllowed = isCmdK || isCmdShiftK || isEsc;

      if (isOpenDialogPresent() && !isAlwaysAllowed) return;
      if (isEditableTarget(event.target) && !isAlwaysAllowed) return;

      // ---- Chord: second-key phase ----
      const chord = chordRef.current;
      if (chord.phase === 'awaiting-second') {
        const elapsed = Date.now() - chord.startedAt;
        if (elapsed > HOTKEY_CHORD_TIMEOUT_MS) {
          chordRef.current = { phase: 'idle' };
          if (chordTimerRef.current !== null) {
            window.clearTimeout(chordTimerRef.current);
            chordTimerRef.current = null;
          }
        } else {
          const bindings = Array.from(registryRef.current.values());
          for (const b of bindings) {
            if (!isBindingActive(b)) continue;
            const parts = b.keys.split(' ');
            if (parts.length !== 2 || parts[0] !== 'g') continue;
            if (!matchesPattern(event, parts[1])) continue;
            if (b.when && !b.when()) continue;
            event.preventDefault();
            chordRef.current = { phase: 'idle' };
            if (chordTimerRef.current !== null) {
              window.clearTimeout(chordTimerRef.current);
              chordTimerRef.current = null;
            }
            b.handler(event);
            return;
          }
          chordRef.current = { phase: 'idle' };
          if (chordTimerRef.current !== null) {
            window.clearTimeout(chordTimerRef.current);
            chordTimerRef.current = null;
          }
        }
      }

      // ---- Normal single-key bindings ----
      const bindings = Array.from(registryRef.current.values());
      for (const b of bindings) {
        if (!isBindingActive(b)) continue;
        const parts = b.keys.split(' ');
        if (parts.length !== 1) continue;
        if (!matchesPattern(event, parts[0])) continue;
        if (b.when && !b.when()) continue;
        event.preventDefault();
        b.handler(event);
        return;
      }

      // ---- Chord start: bare "g" ----
      if (
        event.key === 'g' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        const hasChord = Array.from(registryRef.current.values()).some(
          (b) => isBindingActive(b) && b.keys.startsWith('g '),
        );
        if (hasChord) {
          event.preventDefault();
          chordRef.current = { phase: 'awaiting-second', startedAt: Date.now() };
          if (chordTimerRef.current !== null) window.clearTimeout(chordTimerRef.current);
          chordTimerRef.current = window.setTimeout(() => {
            chordRef.current = { phase: 'idle' };
            chordTimerRef.current = null;
          }, HOTKEY_CHORD_TIMEOUT_MS);
        }
      }
    }

    window.addEventListener('keydown', handleKeydown);
    return () => {
      window.removeEventListener('keydown', handleKeydown);
      if (chordTimerRef.current !== null) {
        window.clearTimeout(chordTimerRef.current);
        chordTimerRef.current = null;
      }
    };
  }, []);

  // Shift+T smoke-test binding
  useEffect(() => {
    const id = register({
      keys: 'Shift+t',
      handler: () => toggleTheme(),
      scope: 'global',
      description: 'Toggle light/dark theme',
    });
    return () => unregister(id);
  }, [register, unregister, toggleTheme]);

  // "?" opens the cheatsheet.
  useEffect(() => {
    const id = register({
      keys: '?',
      scope: 'global',
      description: 'Show keyboard shortcuts',
      handler: () => openCheatsheet(),
    });
    return () => unregister(id);
  }, [register, unregister, openCheatsheet]);

  // Cmd+K / Ctrl+K opens the palette (no-op while another Radix dialog is open).
  useEffect(() => {
    const id = register({
      keys: 'Mod+k',
      scope: 'global',
      description: 'Open command palette',
      handler: () => {
        if (paletteOpen) {
          closePalette();
          return;
        }
        if (
          document.querySelector(
            '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
          )
        ) {
          return;
        }
        openPalette();
      },
    });
    return () => unregister(id);
  }, [register, unregister, openPalette, closePalette, paletteOpen]);

  // Cmd+Shift+K / Ctrl+Shift+K opens the actions palette.
  useEffect(() => {
    const id = register({
      keys: 'Mod+Shift+k',
      scope: 'global',
      description: 'Open actions palette',
      handler: () => {
        if (actionsPaletteOpen) {
          closeActionsPalette();
          return;
        }
        if (
          document.querySelector(
            '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
          )
        ) {
          return;
        }
        openActionsPalette();
      },
    });
    return () => unregister(id);
  }, [register, unregister, openActionsPalette, closeActionsPalette, actionsPaletteOpen]);

  // g-chord navigation (R1 + R2).
  useEffect(() => {
    const chords: Array<{ suffix: string; basePath: string; desc: string }> = [
      { suffix: 'o', basePath: '/',            desc: 'Go to Overview' },
      { suffix: 'm', basePath: '/projects',    desc: 'Go to Projects' },
      { suffix: 'a', basePath: '/assignments', desc: 'Go to Assignments' },
      { suffix: 't', basePath: '/todos',       desc: 'Go to Todos' },
      { suffix: 's', basePath: '/servers',     desc: 'Go to Servers' },
      { suffix: '!', basePath: '/attention',   desc: 'Go to Attention' },
      { suffix: ',', basePath: '/settings',    desc: 'Go to Settings' },
    ];
    const ids = chords.map((c) =>
      register({
        keys: `g ${c.suffix}`,
        scope: 'global',
        description: c.desc,
        handler: () => navigate(resolveRoute(c.basePath, wsPrefix)),
      }),
    );
    return () => ids.forEach(unregister);
  }, [register, unregister, navigate, wsPrefix]);

  const value = useMemo<HotkeyContextValue>(
    () => ({
      register,
      unregister,
      pushScope,
      popScope,
      openPalette,
      closePalette,
      paletteOpen,
      openCheatsheet,
      closeCheatsheet,
      cheatsheetOpen,
      openActionsPalette,
      closeActionsPalette,
      actionsPaletteOpen,
      listBindings,
      wsPrefix,
      paletteEntries,
      actionEntries,
    }),
    [
      register,
      unregister,
      pushScope,
      popScope,
      openPalette,
      closePalette,
      paletteOpen,
      openCheatsheet,
      closeCheatsheet,
      cheatsheetOpen,
      openActionsPalette,
      closeActionsPalette,
      actionsPaletteOpen,
      listBindings,
      wsPrefix,
      paletteEntries,
      actionEntries,
    ],
  );

  return (
    <HotkeyContext.Provider value={value}>
      {children}
      <CommandPalette entries={paletteEntries} />
      <ActionPalette entries={actionEntries} />
      <CheatsheetDialog />
    </HotkeyContext.Provider>
  );
}

export function useHotkeyContext(): HotkeyContextValue {
  const ctx = useContext(HotkeyContext);
  if (!ctx) throw new Error('useHotkeyContext must be used within HotkeyProvider');
  return ctx;
}
