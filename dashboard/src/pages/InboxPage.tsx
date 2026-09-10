import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Inbox } from 'lucide-react';
import { EmptyState } from '../components/EmptyState';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { useToast, Toaster } from '../components/Toast';
import { InboxRow } from '../components/inbox/InboxRow';
import { useInbox } from '../hooks/useInbox';
import { useProjects } from '../hooks/useProjects';
import { fetchChatAgents } from '../lib/chat-api';
import type { ChatAgentSummary } from '../lib/chat-types';
import {
  notificationPermission,
  type NotificationApi,
  type NotificationState,
} from '../lib/inbox-notify';

/**
 * The "Needs me" reply queue: a flat, oldest-first list of things waiting on
 * a reply from you, with inline affordances wired to existing dashboard routes.
 */
export function InboxPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const project = searchParams.get('project') || null;
  const { items, total, loading, error, refetch } = useInbox({ project });
  const { data: projects } = useProjects();
  const [agents, setAgents] = useState<readonly ChatAgentSummary[]>([]);
  const { toast, showToast, dismissToast } = useToast();

  useEffect(() => {
    fetchChatAgents()
      .then((result) => setAgents(result.agents))
      .catch(() => setAgents([]));
  }, []);

  const onError = (message: string) => showToast(message, 'error');
  const onSuccess = (message: string) => showToast(message, 'success');

  if (loading && items.length === 0) {
    return <LoadingState label="Loading your inbox…" />;
  }

  if (error && items.length === 0) {
    return (
      <ErrorState
        title="Inbox unavailable"
        error={error}
        action={
          <button type="button" className="shell-action" onClick={refetch}>
            Retry
          </button>
        }
      />
    );
  }

  const header = (
    <>
      <Toaster toast={toast} onDismiss={dismissToast} />
      <InboxHeader
        total={total}
        project={project}
        projects={projects ?? []}
        onProjectChange={(slug) => {
          const next = new URLSearchParams(searchParams);
          if (slug) next.set('project', slug);
          else next.delete('project');
          setSearchParams(next);
        }}
      />
    </>
  );

  if (items.length === 0) {
    return (
      <div className="space-y-4">
        {header}
        <EmptyState
          title="Nothing is waiting on you"
          description="When an agent asks a question, a permission card goes unanswered, a plan needs approval, or an assignment awaits your review, it appears here so you can reply in place."
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {header}
      <ul className="space-y-3">
        {items.map((item) => (
          <InboxRow
            key={item.commentId ?? item.chat?.itemId ?? `${item.category}:${item.assignmentId}`}
            item={item}
            agents={agents}
            onMutated={refetch}
            onError={onError}
            onSuccess={onSuccess}
          />
        ))}
      </ul>
    </div>
  );
}

function NotificationsControl() {
  const [state, setState] = useState<NotificationState>(() =>
    notificationPermission(
      typeof Notification === 'undefined'
        ? undefined
        : (Notification as unknown as NotificationApi),
    ),
  );

  if (state !== 'default') return null;

  return (
    <button
      type="button"
      className="shell-action"
      onClick={() => {
        if (typeof Notification === 'undefined') return;
        void Notification.requestPermission().then((answer) => setState(answer));
      }}
    >
      Enable notifications
    </button>
  );
}

function InboxHeader({
  total,
  project,
  projects,
  onProjectChange,
}: {
  total: number;
  project: string | null;
  projects: Array<{ slug: string; title: string }>;
  onProjectChange: (slug: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-card text-foreground shadow-sm ring-1 ring-border/60">
        <Inbox className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <h1 className="text-lg font-semibold text-foreground">Needs me</h1>
        <p className="text-sm text-muted-foreground">
          {total === 0
            ? 'Nothing is waiting on you'
            : `${total} waiting`}
        </p>
      </div>
      <NotificationsControl />
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="sr-only">Project filter</span>
        <select
          className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground"
          value={project ?? ''}
          onChange={(e) => onProjectChange(e.target.value || null)}
        >
          <option value="">All projects</option>
          {[...projects]
            .sort((a, b) => a.slug.localeCompare(b.slug))
            .map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.slug}
              </option>
            ))}
        </select>
      </label>
    </div>
  );
}
