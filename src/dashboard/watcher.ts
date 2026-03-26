import { watch } from 'chokidar';
import { relative, sep, basename } from 'node:path';
import type { WsMessage } from './types.js';

export interface WatcherOptions {
  missionsDir: string;
  serversDir?: string;
  onMessage: (message: WsMessage) => void;
  debounceMs?: number;
}

export function createWatcher(options: WatcherOptions): { close: () => Promise<void> } {
  const { missionsDir, serversDir, onMessage, debounceMs = 300 } = options;
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

    // Determine message type — _index-sessions.md changes get their own event
    const isSessionsIndex = basename(filePath) === '_index-sessions.md';
    const messageType = isSessionsIndex
      ? 'agent-sessions-updated'
      : assignmentSlug
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

  return {
    close: async () => {
      pendingEvents.forEach((timeout) => {
        clearTimeout(timeout);
      });
      pendingEvents.clear();
      await missionsWatcher.close();
      if (serversWatcher) await serversWatcher.close();
    },
  };
}
