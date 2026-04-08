import { watch } from 'chokidar';
import { relative, sep } from 'node:path';
import type { WsMessage } from './types.js';

export interface WatcherOptions {
  missionsDir: string;
  serversDir?: string;
  playbooksDir?: string;
  todosDir?: string;
  onMessage: (message: WsMessage) => void;
  debounceMs?: number;
}

export function createWatcher(options: WatcherOptions): { close: () => Promise<void> } {
  const { missionsDir, serversDir, playbooksDir, todosDir, onMessage, debounceMs = 300 } = options;
  const pendingEvents = new Map<string, NodeJS.Timeout>();

  // --- Missions watcher (existing logic) ---
  const missionsWatcher = watch(missionsDir, {
    ignoreInitial: true,
    persistent: true,
    depth: 10,
    ignored: /(^|[\/\\])\../,
  });

  function handleMissionChange(filePath: string): void {
    const rel = relative(missionsDir, filePath);
    const parts = rel.split(sep);

    if (parts.length === 0) return;

    const missionSlug = parts[0];
    let assignmentSlug: string | undefined;

    if (parts.length >= 3 && parts[1] === 'assignments') {
      assignmentSlug = parts[2];
    }

    const debounceKey = assignmentSlug
      ? `${missionSlug}/${assignmentSlug}`
      : missionSlug;

    const existing = pendingEvents.get(debounceKey);
    if (existing) clearTimeout(existing);

    // Session events are now emitted by the API write path, not the file watcher
    const messageType = assignmentSlug
      ? 'assignment-updated'
      : 'mission-updated';

    pendingEvents.set(
      debounceKey,
      setTimeout(() => {
        pendingEvents.delete(debounceKey);
        const message: WsMessage = {
          type: messageType,
          missionSlug,
          assignmentSlug,
          timestamp: new Date().toISOString(),
        };
        onMessage(message);
      }, debounceMs),
    );
  }

  missionsWatcher.on('change', handleMissionChange);
  missionsWatcher.on('add', handleMissionChange);
  missionsWatcher.on('unlink', handleMissionChange);

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

  return {
    close: async () => {
      pendingEvents.forEach((timeout) => {
        clearTimeout(timeout);
      });
      pendingEvents.clear();
      await missionsWatcher.close();
      if (serversWatcher) await serversWatcher.close();
      if (playbooksWatcher) await playbooksWatcher.close();
      if (todosWatcher) await todosWatcher.close();
    },
  };
}
