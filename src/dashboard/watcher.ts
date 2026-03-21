import { watch } from 'chokidar';
import { relative, sep } from 'node:path';
import type { WsMessage } from './types.js';

export interface WatcherOptions {
  missionsDir: string;
  onMessage: (message: WsMessage) => void;
  debounceMs?: number;
}

export function createWatcher(options: WatcherOptions): { close: () => Promise<void> } {
  const { missionsDir, onMessage, debounceMs = 300 } = options;
  const pendingEvents = new Map<string, NodeJS.Timeout>();

  const watcher = watch(missionsDir, {
    ignoreInitial: true,
    persistent: true,
    depth: 10,
    ignored: /(^|[\/\\])\../,
  });

  function handleChange(filePath: string): void {
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

    pendingEvents.set(
      debounceKey,
      setTimeout(() => {
        pendingEvents.delete(debounceKey);
        const message: WsMessage = {
          type: assignmentSlug ? 'assignment-updated' : 'mission-updated',
          missionSlug,
          assignmentSlug,
          timestamp: new Date().toISOString(),
        };
        onMessage(message);
      }, debounceMs),
    );
  }

  watcher.on('change', handleChange);
  watcher.on('add', handleChange);
  watcher.on('unlink', handleChange);

  return {
    close: async () => {
      pendingEvents.forEach((timeout) => {
        clearTimeout(timeout);
      });
      pendingEvents.clear();
      await watcher.close();
    },
  };
}
