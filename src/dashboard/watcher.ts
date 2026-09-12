import { watch } from 'chokidar';
import { basename, dirname, isAbsolute, relative, sep } from 'node:path';
import { invalidateWorkflowLibraryCache } from '../utils/workflow-library.js';
import type { WsMessage } from './types.js';
import { parseTicketFolderName } from '../utils/ticket-folder.js';

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
  ticketsDir?: string;
  playbooksDir?: string;
  /** Absolute path to ~/.syntaur/workflows/. When set, changes to per-file stage
   * workflows invalidate the workflow-library cache and fire `onConfigChanged`
   * (the same recompute-all signal a config.md change triggers) — the config
   * watcher is `depth:0` on config.md, so it never sees per-file workflow edits. */
  workflowsDir?: string;
  /** Absolute path to ~/.syntaur/config.md. When set, changes trigger
   * `onConfigChanged` — derive rules may have changed, so the server runs a
   * recompute-all sweep (design v3, Piece 3 trigger set). */
  configPath?: string;
  /** Debounced per-ticket hook fired alongside `ticket-updated` —
   * the server wires this to `recomputeAndWrite` so out-of-band edits
   * (agents/humans editing files directly) re-derive. The recompute's own
   * write fires one more event that no-ops (no change → no write), so the
   * cycle terminates. */
  onTicketChanged?: (projectSlug: string | null, ticketSlug: string) => void;
  /** Debounced hook for config.md changes (recompute-all trigger). */
  onConfigChanged?: () => void;
  /** Absolute path to ~/.syntaur/syntaur.db. When set, watch the parent dir
   * for changes to this file and its WAL siblings (-wal, -shm) and broadcast
   * `agent-sessions-updated`. chokidar 4 removed glob support so we must filter by
   * basename in the change handler. */
  dbPath?: string;
  onMessage: (message: WsMessage) => void;
  debounceMs?: number;
}

export function createWatcher(options: WatcherOptions): { close: () => Promise<void> } {
  const {
    projectsDir,
    playbooksDir,
    workflowsDir,
    dbPath,
    configPath,
    onMessage,
    onTicketChanged,
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
    let ticketFolder: string | undefined;
    let ticketId: string | undefined;
    let ticketSlug: string | undefined;

    if (parts.length >= 3 && parts[1] === 'tickets') {
      ticketFolder = parts[2];
      const parsed = ticketFolder ? parseTicketFolderName(ticketFolder) : null;
      if (parsed) {
        ticketId = parsed.id;
        ticketSlug = parsed.slug;
      }
    }

    const debounceKey = ticketId
      ? `${projectSlug}/${ticketId}`
      : projectSlug;

    const existing = pendingEvents.get(debounceKey);
    if (existing) clearTimeout(existing);

    // Session events are now emitted by the API write path, not the file watcher
    const messageType: WsMessage['type'] = ticketId
      ? 'ticket-updated'
      : 'project-updated';

    pendingEvents.set(
      debounceKey,
      setTimeout(() => {
        pendingEvents.delete(debounceKey);
        const message: WsMessage = {
          type: messageType,
          projectSlug,
          ticketId,
          ticketSlug,
          timestamp: new Date().toISOString(),
        };
        onMessage(message);
        if (ticketId && onTicketChanged) {
          onTicketChanged(projectSlug, ticketId);
        }
      }, debounceMs),
    );
  }

  projectsWatcher.on('change', handleProjectChange);
  projectsWatcher.on('add', handleProjectChange);
  projectsWatcher.on('unlink', handleProjectChange);

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

  // --- Workflows watcher (per-file stage workflows) ---
  // Per-file workflows live in ~/.syntaur/workflows/*.md. The config watcher is
  // depth:0 on config.md, so a workflow-file edit fires nothing today. Model this
  // on the playbooks watcher, but on change invalidate the workflow-library cache
  // and fire the config watcher's recompute signal (a stage/route/gate change can
  // move where tickets sit, exactly like a derive-rule change).
  let workflowsWatcher: ReturnType<typeof watch> | null = null;

  if (workflowsDir) {
    workflowsWatcher = watch(workflowsDir, {
      ignoreInitial: true,
      persistent: true,
      depth: 1,
      ignored: ignoreDotSegmentsBelow(workflowsDir),
    });

    function handleWorkflowsChange(): void {
      const debounceKey = '__workflows__';
      const existing = pendingEvents.get(debounceKey);
      if (existing) clearTimeout(existing);

      pendingEvents.set(
        debounceKey,
        setTimeout(() => {
          pendingEvents.delete(debounceKey);
          // Drop the stale per-file library BEFORE the recompute reads it.
          invalidateWorkflowLibraryCache();
          if (onConfigChanged) onConfigChanged();
        }, debounceMs),
      );
    }

    workflowsWatcher.on('change', handleWorkflowsChange);
    workflowsWatcher.on('add', handleWorkflowsChange);
    workflowsWatcher.on('unlink', handleWorkflowsChange);
  }

  // --- DB watcher (agent sessions share syntaur.db) ---
  // SQLite WAL-mode writes mostly go to `<db>-wal`, not the main file. Watch
  // the parent directory and filter by basename to catch the main DB and its
  // -wal / -shm siblings. chokidar 4 has no glob support, so a literal pattern
  // like `${dbPath}*` would be silently a no-op.
  let sessionsDbWatcher: ReturnType<typeof watch> | null = null;

  if (dbPath) {
    const dbDir = dirname(dbPath);
    const dbBase = basename(dbPath);

    sessionsDbWatcher = watch(dbDir, {
      ignoreInitial: true,
      persistent: true,
      depth: 0,
      ignored: ignoreDotSegmentsBelow(dbDir),
    });

    function handleDbChange(filePath: string): void {
      if (!basename(filePath).startsWith(dbBase)) return;
      const debounceKey = '__sessions-db__';
      const existing = pendingEvents.get(debounceKey);
      if (existing) clearTimeout(existing);

      pendingEvents.set(
        debounceKey,
        setTimeout(() => {
          pendingEvents.delete(debounceKey);
          const timestamp = new Date().toISOString();
          // Session register/stop now write the DB directly from hook/CLI
          // processes (no REST mutation to broadcast), so the file watcher is
          // the dashboard's only realtime signal for those rows.
          onMessage({ type: 'agent-sessions-updated', timestamp });
        }, debounceMs),
      );
    }

    sessionsDbWatcher.on('change', handleDbChange);
    sessionsDbWatcher.on('add', handleDbChange);
    sessionsDbWatcher.on('unlink', handleDbChange);
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
      if (playbooksWatcher) await playbooksWatcher.close();
      if (workflowsWatcher) await workflowsWatcher.close();
      if (sessionsDbWatcher) await sessionsDbWatcher.close();
      if (configWatcher) await configWatcher.close();
    },
  };
}
