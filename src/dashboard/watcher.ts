import { watch } from 'chokidar';
import { basename, dirname, relative, sep } from 'node:path';
import type { WsMessage } from './types.js';

export interface WatcherOptions {
  projectsDir: string;
  assignmentsDir?: string;
  serversDir?: string;
  playbooksDir?: string;
  todosDir?: string;
  /** Absolute path to ~/.syntaur/syntaur.db. When set, watch the parent dir
   * for changes to this file and its WAL siblings (-wal, -shm) and broadcast
   * `leases-updated`. chokidar 4 removed glob support so we must filter by
   * basename in the change handler. */
  dbPath?: string;
  onMessage: (message: WsMessage) => void;
  debounceMs?: number;
}

export function createWatcher(options: WatcherOptions): { close: () => Promise<void> } {
  const { projectsDir, assignmentsDir, serversDir, playbooksDir, todosDir, dbPath, onMessage, debounceMs = 300 } = options;
  const pendingEvents = new Map<string, NodeJS.Timeout>();

  // --- Projects watcher (existing logic) ---
  const projectsWatcher = watch(projectsDir, {
    ignoreInitial: true,
    persistent: true,
    depth: 10,
    ignored: /(^|[\/\\])\../,
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
      ignored: /(^|[\/\\])\../,
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
      ignored: /(^|[\/\\])\../,
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
      ignored: /(^|[\/\\])\../,
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
      ignored: /(^|[\/\\])\../,
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

  // --- Leases DB watcher ---
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
      ignored: /(^|[\/\\])\../,
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
          const message: WsMessage = {
            type: 'leases-updated',
            timestamp: new Date().toISOString(),
          };
          onMessage(message);
        }, debounceMs),
      );
    }

    leasesDbWatcher.on('change', handleDbChange);
    leasesDbWatcher.on('add', handleDbChange);
    leasesDbWatcher.on('unlink', handleDbChange);
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
    },
  };
}
