import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import {
  Monitor,
  RefreshCw,
  Trash2,
  GitBranch,
  ExternalLink,
  LinkIcon,
  Plus,
  ServerOff,
  Terminal,
} from 'lucide-react';
import { CopyButton } from '../components/CopyButton';
import { useServers, useProjects, useWorkspacePrefix } from '../hooks/useProjects';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import type { TrackedSession, TrackedPane } from '../types';

export function ServersPage() {
  const { workspace } = useParams<{ workspace?: string }>();
  const { data: projectsData } = useProjects();
  const { data, loading, error, refetch } = useServers();
  const [registering, setRegistering] = useState(false);
  const [newSessionName, setNewSessionName] = useState('');
  const [refreshingAll, setRefreshingAll] = useState(false);
  const location = useLocation();

  // Palette → servers: navigate with #server-<name> hash; scroll + highlight.
  useEffect(() => {
    const m = location.hash.match(/^#server-(.+)/);
    if (!m) return;
    const name = decodeURIComponent(m[1]);
    const node = document.querySelector<HTMLElement>(
      `[data-server-name="${window.CSS.escape(name)}"]`,
    );
    if (!node) return;
    node.scrollIntoView({ block: 'nearest' });
    node.classList.add('ring-2', 'ring-primary/60');
    const t = window.setTimeout(
      () => node.classList.remove('ring-2', 'ring-primary/60'),
      1500,
    );
    return () => window.clearTimeout(t);
  }, [location.hash, data]);

  const filteredSessions = (() => {
    if (!workspace || !data) return data?.sessions ?? [];
    if (!projectsData) return [];
    const workspaceProjects = new Set(
      projectsData
        .filter((m) => workspace === '_ungrouped' ? m.workspace === null : m.workspace === workspace)
        .map((m) => m.slug),
    );
    return data.sessions.filter((session) =>
      session.windows.some((win) =>
        win.panes.some((pane) =>
          pane.assignment && workspaceProjects.has(pane.assignment.project),
        ),
      ),
    );
  })();

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    if (!newSessionName.trim()) return;
    try {
      await fetch('/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newSessionName.trim() }),
      });
      setNewSessionName('');
      setRegistering(false);
      refetch();
    } catch {
      // Error handling — refetch will show current state
    }
  }

  async function handleRefreshAll() {
    setRefreshingAll(true);
    try {
      await fetch('/api/servers/refresh', { method: 'POST' });
      refetch();
    } finally {
      setRefreshingAll(false);
    }
  }

  async function handleRemove(name: string) {
    await fetch(`/api/servers/${encodeURIComponent(name)}`, { method: 'DELETE' });
    refetch();
  }

  async function handleRefreshOne(name: string) {
    await fetch(`/api/servers/${encodeURIComponent(name)}/refresh`, { method: 'POST' });
    refetch();
  }

  if (loading) return <LoadingState label="Loading servers…" />;
  if (error) return <ErrorState error={error} />;
  if (!data) return null;

  if (!data.tmuxAvailable) {
    return (
      <>
        <div className="surface-panel mt-4 flex flex-col items-center gap-3 py-12 text-center">
          <Terminal className="h-10 w-10 text-muted-foreground/40" />
          <p className="text-sm font-medium text-foreground">tmux is not installed</p>
          <p className="max-w-md text-sm text-muted-foreground">
            Server tracking requires tmux. Install it with <code className="rounded bg-muted px-1.5 py-0.5 text-xs">brew install tmux</code> to get started.
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {registering ? (
          <form onSubmit={handleRegister} className="flex items-center gap-2">
            <input
              type="text"
              value={newSessionName}
              onChange={(e) => setNewSessionName(e.target.value)}
              placeholder="tmux session name"
              className="editor-input text-sm"
              autoFocus
            />
            <button type="submit" className="shell-action">Add</button>
            <button type="button" className="shell-action" onClick={() => setRegistering(false)}>Cancel</button>
          </form>
        ) : (
          <button className="shell-action" onClick={() => setRegistering(true)}>
            <Plus className="h-3.5 w-3.5" />
            Track Session
          </button>
        )}
        <button
          className="shell-action"
          onClick={handleRefreshAll}
          disabled={refreshingAll}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshingAll ? 'animate-spin' : ''}`} />
          Refresh All
        </button>
      </div>

      {filteredSessions.length === 0 ? (
        <EmptyState
          title="No sessions tracked"
          description="Register a tmux session to start tracking your dev servers."
        />
      ) : (
        <div className="mt-4 space-y-4">
          {filteredSessions.map((session) => (
            <SessionCard
              key={session.name}
              session={session}
              onRefresh={() => handleRefreshOne(session.name)}
              onRemove={() => handleRemove(session.name)}
              onRefetch={refetch}
            />
          ))}
        </div>
      )}
    </>
  );
}

function SessionCard({
  session,
  onRefresh,
  onRemove,
  onRefetch,
}: {
  session: TrackedSession;
  onRefresh: () => void;
  onRemove: () => void;
  onRefetch: () => void;
}) {
  return (
    <div className="surface-panel" data-server-name={session.name}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Monitor className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold text-foreground">{session.name}</span>
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
              session.alive
                ? 'border border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400'
                : 'border border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-400'
            }`}
          >
            {session.alive ? 'alive' : 'dead'}
          </span>
          <span className="text-xs text-muted-foreground">
            Last refreshed: {new Date(session.lastRefreshed).toLocaleString()}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button className="shell-action" onClick={onRefresh} title="Refresh">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button className="shell-action" onClick={onRemove} title="Remove">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {session.alive && session.windows.length > 0 && (
        <div className="mt-3 space-y-3">
          {session.windows.map((win) => (
            <div key={win.index}>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Window {win.index}: {win.name}
              </p>
              <div className="space-y-1.5">
                {win.panes.map((pane) => (
                  <PaneRow
                    key={`${win.index}:${pane.index}`}
                    pane={pane}
                    sessionName={session.name}
                    windowIndex={win.index}
                    onRefetch={onRefetch}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {!session.alive && (
        <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
          <ServerOff className="h-4 w-4" />
          <span>{session.kind === 'process' ? 'Process no longer running' : 'Session no longer exists'}</span>
        </div>
      )}
    </div>
  );
}

function PaneRow({
  pane,
  sessionName: _sessionName,
  windowIndex: _windowIndex,
  onRefetch: _onRefetch,
}: {
  pane: TrackedPane;
  sessionName: string;
  windowIndex: number;
  onRefetch: () => void;
}) {
  const wsPrefix = useWorkspacePrefix();
  const shortCwd = pane.cwd.replace(/^\/Users\/[^/]+/, '~');

  return (
    <div className="flex items-center gap-3 rounded-md border border-border/40 bg-background/60 px-3 py-2 text-sm">
      <span className="shrink-0 font-mono text-xs text-muted-foreground/60">:{pane.index}</span>
      <span className="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 font-mono text-xs">{pane.command}</span>
      <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span className="truncate" title={pane.cwd}>{shortCwd}</span>
        <CopyButton value={pane.cwd} />
      </span>
      {pane.branch && (
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <GitBranch className="h-3 w-3" />
          {pane.branch}
          {pane.worktree && (
            <span className="rounded bg-violet-100 px-1 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-950/40 dark:text-violet-400">
              worktree
            </span>
          )}
        </span>
      )}
      {pane.ports.length > 0 && (
        <div className="flex shrink-0 items-center gap-1.5">
          {pane.urls.map((url) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded border border-teal-200 bg-teal-50 px-1.5 py-0.5 text-xs font-medium text-teal-700 hover:bg-teal-100 dark:border-teal-900 dark:bg-teal-950/40 dark:text-teal-400 dark:hover:bg-teal-950/60"
            >
              {url.replace('http://localhost:', ':')}
              <ExternalLink className="h-2.5 w-2.5" />
            </a>
          ))}
        </div>
      )}
      <div className="ml-auto shrink-0">
        {pane.assignment ? (
          <Link
            to={`${wsPrefix}/projects/${pane.assignment.project}/assignments/${pane.assignment.slug}`}
            className="inline-flex items-center gap-1 rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-primary/20"
          >
            <LinkIcon className="h-2.5 w-2.5" />
            {pane.assignment.title}
          </Link>
        ) : (
          <span className="text-xs text-muted-foreground/40">unlinked</span>
        )}
      </div>
    </div>
  );
}
