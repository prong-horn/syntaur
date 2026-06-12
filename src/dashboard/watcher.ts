import { watch } from 'chokidar';
import { basename, dirname, isAbsolute, relative, sep } from 'node:path';
import type { WsMessage } from './types.js';

/** Minimal slice of `node:path` the matcher needs. Injectable so tests can
 * exercise `path.win32` / `path.posix` behavior deterministically on any OS. */
type PathApi = { relative: typeof relative; isAbsolute: typeof isAbsolute };
const defaultPathApi: PathApi = { relative, isAbsolute };

/**
 * Build a chokidar `ignored` matcher scoped to a single watched root.
 *
 * Ignores only dot-prefixed path segments AT OR BELOW `root` — never the root
 * itself, and never a (possibly dot-named, e.g. `.syntaur`) ANCESTOR. This
 * replaces the old `ignored: /(^|[\/\\])\../` regex: chokidar 4 tests `ignored`
 * against the full absolute path, and because every watched root lives under
 * `~/.syntaur`, that regex matched the `.syntaur` ancestor and suppressed the
 * entire tree (0 events fired). Returning `true` means "ignore".
 *
 * @param pathApi overrides `node:path` (default) — used by tests to verify
 *   Windows separator / cross-drive behavior on a posix host.
 */
export function ignoreDotSegmentsBelow(
  root: string,
  pathApi: PathApi = defaultPathApi,
): (p: string) => boolean {
  return (p: string): boolean => {
    const rel = pathApi.relative(root, p);
    if (!rel) return false; // the watched root itself
    if (pathApi.isAbsolute(rel)) return false; // different drive (Windows) → outside root
    const parts = rel.split(/[\\/]/); // tolerate either separator
    // Exact first-segment `..` means the path is above/outside the root (this
    // is what spares the dot-named ancestor). Use an exact segment match, not
    // `startsWith('..')`, so an in-root file literally named `..foo` is still
    // treated as a dotfile below the root.
    if (parts[0] === '..') return false;
    return parts.some((segment) => segment.startsWith('.'));
  };
}

export interface WatcherOptions {
  projectsDir: string;
  assignmentsDir?: string;
  serversDir?: string;
  playbooksDir?: string;
  todosDir?: string;
  /** Absolute path to ~/.syntaur/config.md. When set, changes trigger
   * `onConfigChanged` — derive rules may have changed, so the server runs a
   * recompute-all sweep (design v3, Piece 3 trigger set). */
  configPath?: string;
  /** Debounced per-assignment hook fired alongside `assignment-updated` —
   * the server wires this to `recomputeAndWrite` so out-of-band edits
   * (agents/humans editing files directly) re-derive. The recompute's own
   * write fires one more event that no-ops (no change → no write), so the
   * cycle terminates. */
  onAssignmentChanged?: (projectSlug: string | null, assignmentSlug: string) => void;
  /** Debounced hook for config.md changes (recompute-all trigger). */
  onConfigChanged?: () => void;
  /** Absolute path to ~/.syntaur/syntaur.db. When set, watch the parent dir
   * for changes to this file and its WAL siblings (-wal, -shm) and broadcast
   * `leases-updated`. chokidar 4 removed glob support so we must filter by
   * basename in the change handler. */
  dbPath?: string;
  onMessage: (message: WsMessage) => void;
  debounceMs?: number;
}

export function createWatcher(options: WatcherOptions): { close: () => Promise<void> } {
  const {
    projectsDir,
    assignmentsDir,
    serversDir,
    playbooksDir,
    todosDir,
    dbPath,
    configPath,
    onMessage,
    onAssignmentChanged,
    onConfigChanged,
    debounceMs = 300,
  } = options;
  const pendingEvents = new Map<string, NodeJS.Timeout>();

  // --- Projects watcher (existing logic) ---
  const projectsWatcher = watch(projectsDir, {
    ignoreInitial: true,
    persistent: true,
    depth: 10,
    ignored: ignoreDotSegmentsBelow(projectsDir),
  });

  function handleProjectChange(filePath: string): void {
    const rel = relative(projectsDir, filePath);
    const parts = rel.split(sep);

    if (parts.length === 0) return;

    const projectSlug = parts[0];
    let assignmentSlug: string | undefined;
    let isProjectTodos = false;

    if (parts.length >= 3 && parts[1] === 'assignments') {
      assignmentSlug = parts[2];
    } else if (parts.length >= 2 && parts[1] === 'todos') {
      isProjectTodos = true;
    }

    const debounceKey = isProjectTodos
      ? `todos:${projectSlug}`
      : assignmentSlug
        ? `${projectSlug}/${assignmentSlug}`
        : projectSlug;

    const existing = pendingEvents.get(debounceKey);
    if (existing) clearTimeout(existing);

    // Session events are now emitted by the API write path, not the file watcher
    const messageType: WsMessage['type'] = isProjectTodos
      ? 'todos-updated'
      : assignmentSlug
        ? 'assignment-updated'
        : 'project-updated';

    pendingEvents.set(
      debounceKey,
      setTimeout(() => {
        pendingEvents.delete(debounceKey);
        const message: WsMessage = isProjectTodos
          ? {
              type: 'todos-updated',
              projectSlug,
              timestamp: new Date().toISOString(),
            }
          : {
              type: messageType,
              projectSlug,
              assignmentSlug,
              timestamp: new Date().toISOString(),
            };
        onMessage(message);
        if (assignmentSlug && onAssignmentChanged) {
          onAssignmentChanged(projectSlug, assignmentSlug);
        }
      }, debounceMs),
    );
  }

  projectsWatcher.on('change', handleProjectChange);
  projectsWatcher.on('add', handleProjectChange);
  projectsWatcher.on('unlink', handleProjectChange);

  // --- Standalone assignments watcher ---
  let standaloneWatcher: ReturnType<typeof watch> | null = null;

  if (assignmentsDir) {
    standaloneWatcher = watch(assignmentsDir, {
      ignoreInitial: true,
      persistent: true,
      depth: 5,
      ignored: ignoreDotSegmentsBelow(assignmentsDir),
    });

    function handleStandaloneChange(filePath: string): void {
      const rel = relative(assignmentsDir!, filePath);
      const parts = rel.split(sep);
      if (parts.length === 0) return;
      const assignmentId = parts[0];
      if (!assignmentId) return;

      const debounceKey = `__standalone__/${assignmentId}`;
      const existing = pendingEvents.get(debounceKey);
      if (existing) clearTimeout(existing);

      pendingEvents.set(
        debounceKey,
        setTimeout(() => {
          pendingEvents.delete(debounceKey);
          const message: WsMessage = {
            type: 'assignment-updated',
            projectSlug: null,
            assignmentSlug: assignmentId,
            timestamp: new Date().toISOString(),
          };
          onMessage(message);
          if (onAssignmentChanged) onAssignmentChanged(null, assignmentId);
        }, debounceMs),
      );
    }

    standaloneWatcher.on('change', handleStandaloneChange);
    standaloneWatcher.on('add', handleStandaloneChange);
    standaloneWatcher.on('unlink', handleStandaloneChange);
  }

  // --- Servers watcher (new) ---
  let serversWatcher: ReturnType<typeof watch> | null = null;

  if (serversDir) {
    serversWatcher = watch(serversDir, {
      ignoreInitial: true,
      persistent: true,
      depth: 1,
      ignored: ignoreDotSegmentsBelow(serversDir),
    });

    function handleServerChange(): void {
      const debounceKey = '__servers__';
      const existing = pendingEvents.get(debounceKey);
      if (existing) clearTimeout(existing);

      pendingEvents.set(
        debounceKey,
        setTimeout(() => {
          pendingEvents.delete(debounceKey);
          const message: WsMessage = {
            type: 'servers-updated',
            timestamp: new Date().toISOString(),
          };
          onMessage(message);
        }, debounceMs),
      );
    }

    serversWatcher.on('change', handleServerChange);
    serversWatcher.on('add', handleServerChange);
    serversWatcher.on('unlink', handleServerChange);
  }

  // --- Playbooks watcher ---
  let playbooksWatcher: ReturnType<typeof watch> | null = null;

  if (playbooksDir) {
    playbooksWatcher = watch(playbooksDir, {
      ignoreInitial: true,
      persistent: true,
      depth: 1,
      ignored: ignoreDotSegmentsBelow(playbooksDir),
    });

    function handlePlaybookChange(): void {
      const debounceKey = '__playbooks__';
      const existing = pendingEvents.get(debounceKey);
      if (existing) clearTimeout(existing);

      pendingEvents.set(
        debounceKey,
        setTimeout(() => {
          pendingEvents.delete(debounceKey);
          const message: WsMessage = {
            type: 'playbooks-updated',
            timestamp: new Date().toISOString(),
          };
          onMessage(message);
        }, debounceMs),
      );
    }

    playbooksWatcher.on('change', handlePlaybookChange);
    playbooksWatcher.on('add', handlePlaybookChange);
    playbooksWatcher.on('unlink', handlePlaybookChange);
  }

  // --- Todos watcher ---
  let todosWatcher: ReturnType<typeof watch> | null = null;

  if (todosDir) {
    todosWatcher = watch(todosDir, {
      ignoreInitial: true,
      persistent: true,
      depth: 1,
      ignored: ignoreDotSegmentsBelow(todosDir),
    });

    function handleTodoChange(): void {
      const debounceKey = '__todos__';
      const existing = pendingEvents.get(debounceKey);
      if (existing) clearTimeout(existing);

      pendingEvents.set(
        debounceKey,
        setTimeout(() => {
          pendingEvents.delete(debounceKey);
          const message: WsMessage = {
            type: 'todos-updated',
            timestamp: new Date().toISOString(),
          };
          onMessage(message);
        }, debounceMs),
      );
    }

    todosWatcher.on('change', handleTodoChange);
    todosWatcher.on('add', handleTodoChange);
    todosWatcher.on('unlink', handleTodoChange);
  }

  // --- DB watcher (leases + agent sessions share syntaur.db) ---
  // SQLite WAL-mode writes mostly go to `<db>-wal`, not the main file. Watch
  // the parent directory and filter by basename to catch the main DB and its
  // -wal / -shm siblings. chokidar 4 has no glob support, so a literal pattern
  // like `${dbPath}*` would be silently a no-op.
  let leasesDbWatcher: ReturnType<typeof watch> | null = null;

  if (dbPath) {
    const dbDir = dirname(dbPath);
    const dbBase = basename(dbPath);

    leasesDbWatcher = watch(dbDir, {
      ignoreInitial: true,
      persistent: true,
      depth: 0,
      ignored: ignoreDotSegmentsBelow(dbDir),
    });

    function handleDbChange(filePath: string): void {
      if (!basename(filePath).startsWith(dbBase)) return;
      const debounceKey = '__leases-db__';
      const existing = pendingEvents.get(debounceKey);
      if (existing) clearTimeout(existing);

      pendingEvents.set(
        debounceKey,
        setTimeout(() => {
          pendingEvents.delete(debounceKey);
          const timestamp = new Date().toISOString();
          onMessage({ type: 'leases-updated', timestamp });
          // Session register/stop now write the DB directly from hook/CLI
          // processes (no REST mutation to broadcast), so the file watcher is
          // the dashboard's only realtime signal for those rows.
          onMessage({ type: 'agent-sessions-updated', timestamp });
        }, debounceMs),
      );
    }

    leasesDbWatcher.on('change', handleDbChange);
    leasesDbWatcher.on('add', handleDbChange);
    leasesDbWatcher.on('unlink', handleDbChange);
  }

  // --- config.md watcher (derive rules → recompute-all) ---
  let configWatcher: ReturnType<typeof watch> | null = null;

  if (configPath && onConfigChanged) {
    configWatcher = watch(configPath, {
      ignoreInitial: true,
      persistent: true,
      depth: 0,
    });

    function handleConfigChange(): void {
      const debounceKey = '__config__';
      const existing = pendingEvents.get(debounceKey);
      if (existing) clearTimeout(existing);
      pendingEvents.set(
        debounceKey,
        setTimeout(() => {
          pendingEvents.delete(debounceKey);
          onConfigChanged!();
        }, debounceMs),
      );
    }

    configWatcher.on('change', handleConfigChange);
    configWatcher.on('add', handleConfigChange);
  }

  return {
    close: async () => {
      pendingEvents.forEach((timeout) => {
        clearTimeout(timeout);
      });
      pendingEvents.clear();
      await projectsWatcher.close();
      if (standaloneWatcher) await standaloneWatcher.close();
      if (serversWatcher) await serversWatcher.close();
      if (playbooksWatcher) await playbooksWatcher.close();
      if (todosWatcher) await todosWatcher.close();
      if (leasesDbWatcher) await leasesDbWatcher.close();
      if (configWatcher) await configWatcher.close();
    },
  };
}
