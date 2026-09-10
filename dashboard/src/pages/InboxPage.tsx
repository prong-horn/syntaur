import { useEffect, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { Inbox } from 'lucide-react';
import { EmptyState } from '../components/EmptyState';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { useToast, Toaster } from '../components/Toast';
import { InboxRow } from '../components/inbox/InboxRow';
import { useInbox } from '../hooks/useInbox';
import { useInboxWindow, type InboxWindow } from '../hooks/useInboxWindow';
import { useProjects } from '../hooks/useProjects';
import { fetchChatAgents } from '../lib/chat-api';
import type { ChatAgentSummary } from '../lib/chat-types';
import { rowKey } from '../lib/inbox';
import {
  notificationPermission,
  type NotificationApi,
  type NotificationState,
} from '../lib/inbox-notify';

/**
 * The "Needs me" reply queue: live permission and Cursor-question cards first,
 * then chat replies, plain questions, plans awaiting approval, and reviews —
 * oldest-first within each tier — with inline affordances wired to existing
 * dashboard routes.
 */
export function InboxPage() {
  const { window: inboxWindow, setWindow, maxAgeDays } = useInboxWindow();
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const lastScrolledHash = useRef<string | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  const project = searchParams.get('project') || null;
  const { items, total, snoozedCount, loading, error, refetch } = useInbox({
    project,
    maxAgeDays,
    includeSnoozed: showSnoozed,
  });
  const { data: projects } = useProjects();
  const [agents, setAgents] = useState<readonly ChatAgentSummary[]>([]);
  const { toast, showToast, dismissToast } = useToast();

  useEffect(() => {
    fetchChatAgents()
      .then((result) => setAgents(result.agents))
      .catch(() => setAgents([]));
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const raw = location.hash.replace(/^#/, '');
    if (!raw || items.length === 0) return;
    let hash = raw;
    try {
      hash = decodeURIComponent(raw);
    } catch {
      /* keep raw */
    }
    if (hash === lastScrolledHash.current) return;
    const el = document.getElementById(hash);
    if (!el) return;
    lastScrolledHash.current = hash;
    el.scrollIntoView({ block: 'center' });
    setHighlightedKey(hash);
    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
    }
    highlightTimerRef.current = window.setTimeout(() => {
      highlightTimerRef.current = null;
      setHighlightedKey(null);
    }, 2000);
  }, [items, location.hash]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = null;
      }
      lastScrolledHash.current = null;
    };
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const previous = document.title;
    document.title = total > 0 ? `(${total}) Needs me · Syntaur` : 'Needs me · Syntaur';
    return () => {
      document.title = previous;
    };
  }, [total]);

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
        inboxWindow={inboxWindow}
        onWindowChange={setWindow}
        onProjectChange={(slug) => {
          const next = new URLSearchParams(searchParams);
          if (slug) next.set('project', slug);
          else next.delete('project');
          setSearchParams(next);
        }}
      />
    </>
  );

  const snoozedFoot = (
    <SnoozedFoot
      snoozedCount={snoozedCount}
      showSnoozed={showSnoozed}
      onToggle={() => setShowSnoozed((v) => !v)}
    />
  );

  if (items.length === 0) {
    const emptyTitle =
      inboxWindow === '14d' ? 'Nothing in the last 14 days' : 'Nothing is waiting on you';
    const emptyDescription =
      inboxWindow === '14d'
        ? 'Older reviews and plan approvals are hidden. Switch to All to see the full queue, or snooze rows you are not ready to act on.'
        : 'When an agent asks a question, a permission card goes unanswered, a plan needs approval, or an assignment awaits your review, it appears here so you can reply in place.';

    return (
      <div className="space-y-4">
        {header}
        <EmptyState title={emptyTitle} description={emptyDescription} />
        {inboxWindow === '14d' ? (
          <p className="text-sm text-muted-foreground">
            <button type="button" className="underline hover:text-foreground" onClick={() => setWindow('all')}>
              Show all
            </button>
          </p>
        ) : null}
        {snoozedFoot}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {header}
      <ul className="space-y-3">
        {items.map((item) => (
          <InboxRow
            key={rowKey(item)}
            item={item}
            agents={agents}
            highlighted={highlightedKey === rowKey(item)}
            snoozed={Boolean(item.snoozed)}
            onMutated={refetch}
            onError={onError}
            onSuccess={onSuccess}
          />
        ))}
      </ul>
      {snoozedFoot}
    </div>
  );
}

function SnoozedFoot({
  snoozedCount,
  showSnoozed,
  onToggle,
}: {
  snoozedCount: number;
  showSnoozed: boolean;
  onToggle: () => void;
}) {
  if (snoozedCount <= 0) return null;
  return (
    <button type="button" className="shell-action text-sm" onClick={onToggle}>
      {showSnoozed ? 'Hide snoozed' : `Snoozed (${snoozedCount})`}
    </button>
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

function WindowToggle({
  inboxWindow,
  onWindowChange,
}: {
  inboxWindow: InboxWindow;
  onWindowChange: (value: InboxWindow) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-border p-0.5 text-xs">
      <button
        type="button"
        className={`rounded px-2 py-1 ${inboxWindow === '14d' ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground'}`}
        aria-pressed={inboxWindow === '14d'}
        onClick={() => onWindowChange('14d')}
      >
        Last 14 days
      </button>
      <button
        type="button"
        className={`rounded px-2 py-1 ${inboxWindow === 'all' ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground'}`}
        aria-pressed={inboxWindow === 'all'}
        onClick={() => onWindowChange('all')}
      >
        All
      </button>
    </div>
  );
}

function InboxHeader({
  total,
  project,
  projects,
  inboxWindow,
  onWindowChange,
  onProjectChange,
}: {
  total: number;
  project: string | null;
  projects: Array<{ slug: string; title: string }>;
  inboxWindow: InboxWindow;
  onWindowChange: (value: InboxWindow) => void;
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
      <WindowToggle inboxWindow={inboxWindow} onWindowChange={onWindowChange} />
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
