import { watch } from 'chokidar';
import { basename, dirname, isAbsolute, relative, sep } from 'node:path';
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
  playbooksDir?: string;
  /** Optional debounced per-ticket hook fired alongside `ticket-updated`. */
  onTicketChanged?: (projectSlug: string | null, ticketSlug: string) => void;
  /** Absolute path to ~/.syntaur/syntaur.db. When set, watch the parent dir
   * for changes to this file and its WAL siblings (-wal, -shm) and broadcast
   * `agent-sessions-updated`. chokidar 4 removed glob support so we must filter by
   * basename in the change handler. */
  dbPath?: string;
  /** Absolute path to `<root>/config.md`. A change broadcasts
   * `config-updated` with `payload.kind: 'config'` (theme/search/hotkeys/…
   * sections all live in this one file). */
  configPath?: string;
  /** Absolute path to `<root>/view-prefs.json` → `config-updated`
   * `payload.kind: 'view-prefs'`. */
  viewPrefsPath?: string;
  /** `<root>/agents` — external edits broadcast `agents-updated` (API writes
   * already emit `chat-agents` from the broker). */
  agentsDir?: string;
  /** `<root>/templates` — home template packages → `templates-updated`. */
  templatesDir?: string;
  onMessage: (message: WsMessage) => void;
  debounceMs?: number;
}

export function createWatcher(options: WatcherOptions): { close: () => Promise<void> } {
  const {
    projectsDir,
    playbooksDir,
    dbPath,
    configPath,
    viewPrefsPath,
    agentsDir,
    templatesDir,
    onMessage,
    onTicketChanged,
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

  // --- Config / view-prefs / agents / templates watchers ---
  // None of these had a realtime signal before, so the dashboard's cached
  // config/template/agent reads only refreshed on reload. Each is debounced
  // under its own key; the client coalesces further before refetching.
  function debounced(key: string, build: () => WsMessage): void {
    const existing = pendingEvents.get(key);
    if (existing) clearTimeout(existing);
    pendingEvents.set(
      key,
      setTimeout(() => {
        pendingEvents.delete(key);
        onMessage(build());
      }, debounceMs),
    );
  }

  const extraWatchers: Array<ReturnType<typeof watch>> = [];

  // config.md and view-prefs.json are single files in the root. Watch their
  // parent directories (depth 0) and filter by basename: editors and
  // writeFileAtomic replace the file by rename, which a direct file watch can
  // lose track of.
  const rootFiles = new Map<string, Map<string, ConfigUpdateKind>>();
  for (const [path, kind] of [
    [configPath, 'config'],
    [viewPrefsPath, 'view-prefs'],
  ] as Array<[string | undefined, ConfigUpdateKind]>) {
    if (!path) continue;
    const dir = dirname(path);
    const byName = rootFiles.get(dir) ?? new Map<string, ConfigUpdateKind>();
    byName.set(basename(path), kind);
    rootFiles.set(dir, byName);
  }
  for (const [dir, byName] of rootFiles) {
    const w = watch(dir, {
      ignoreInitial: true,
      persistent: true,
      depth: 0,
      ignored: ignoreDotSegmentsBelow(dir),
    });
    const handle = (filePath: string): void => {
      const kind = byName.get(basename(filePath));
      if (!kind || dirname(filePath) !== dir) return;
      debounced(`__config__:${kind}`, () => configUpdatedMessage(kind));
    };
    w.on('change', handle);
    w.on('add', handle);
    w.on('unlink', handle);
    extraWatchers.push(w);
  }

  for (const [dir, type, depth] of [
    [agentsDir, 'agents-updated', 0],
    [templatesDir, 'templates-updated', 2],
  ] as Array<[string | undefined, 'agents-updated' | 'templates-updated', number]>) {
    if (!dir) continue;
    const w = watch(dir, {
      ignoreInitial: true,
      persistent: true,
      depth,
      ignored: ignoreDotSegmentsBelow(dir),
    });
    const handle = (): void => {
      debounced(`__${type}__`, () => ({ type, timestamp: new Date().toISOString() }));
    };
    w.on('change', handle);
    w.on('add', handle);
    w.on('unlink', handle);
    w.on('addDir', handle);
    w.on('unlinkDir', handle);
    extraWatchers.push(w);
  }

  return {
    close: async () => {
      pendingEvents.forEach((timeout) => {
        clearTimeout(timeout);
      });
      pendingEvents.clear();
      await projectsWatcher.close();
      if (playbooksWatcher) await playbooksWatcher.close();
      if (sessionsDbWatcher) await sessionsDbWatcher.close();
      for (const w of extraWatchers) await w.close();
    },
  };
}

export type ConfigUpdateKind = 'config' | 'view-prefs';

/** The `config-updated` frame: which config family changed, never its content. */
export function configUpdatedMessage(kind: ConfigUpdateKind): WsMessage {
  return { type: 'config-updated', timestamp: new Date().toISOString(), payload: { kind } };
}
