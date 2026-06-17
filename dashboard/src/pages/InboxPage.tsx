import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  HelpCircle,
  Inbox,
  RotateCcw,
  Unlock,
} from 'lucide-react';
import { SectionCard } from '../components/SectionCard';
import { EmptyState } from '../components/EmptyState';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { CopyButton } from '../components/CopyButton';
import { useToast, Toaster } from '../components/Toast';
import { useInbox } from '../hooks/useInbox';
import {
  assignmentHref,
  commentsEndpoint,
  formatAge,
  groupInboxItems,
  parseTransitionCommand,
  resolveCommentEndpoint,
  transitionEndpoint,
  type EndpointDescriptor,
  type InboxItem,
} from '../lib/inbox';

/**
 * The "Needs me" decision inbox. Aggregates every assignment awaiting human
 * action (review / blocked / unanswered question / plan-awaiting-approval),
 * grouped by category (stable order, oldest-first within each group), each with
 * an inline quick-action wired to an EXISTING dashboard mutation endpoint.
 *
 * Live-updates via `useInbox` (WS-refreshed on assignment/project broadcasts).
 * After any mutating action we also call `refetch()` defensively so the view
 * settles even if a broadcast is missed.
 */
export function InboxPage() {
  const { items, total, loading, error, refetch } = useInbox();
  const { toast, showToast, dismissToast } = useToast();

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

  const groups = groupInboxItems(items);

  if (groups.length === 0) {
    return (
      <div className="space-y-4">
        <Toaster toast={toast} onDismiss={dismissToast} />
        <InboxHeader total={0} />
        <EmptyState
          title="Nothing needs you right now"
          description="No reviews, blocks, open questions, or plans awaiting approval across your projects. New items appear here the moment something needs a human decision."
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Toaster toast={toast} onDismiss={dismissToast} />
      <InboxHeader total={total} />
      {groups.map((group) => (
        <SectionCard
          key={group.category}
          title={group.label}
          actions={
            <span className="rounded-full bg-foreground px-2.5 py-0.5 text-xs font-semibold text-background">
              {group.count}
            </span>
          }
        >
          <ul className="space-y-3">
            {group.items.map((item) => (
              <InboxItemRow
                key={`${item.category}:${item.assignmentId}:${item.since}`}
                item={item}
                onMutated={refetch}
                onError={(message) => showToast(message, 'error')}
                onSuccess={(message) => showToast(message, 'success')}
              />
            ))}
          </ul>
        </SectionCard>
      ))}
    </div>
  );
}

function InboxHeader({ total }: { total: number }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-card text-foreground shadow-sm ring-1 ring-border/60">
        <Inbox className="h-4 w-4" />
      </span>
      <div>
        <h1 className="text-lg font-semibold text-foreground">Needs me</h1>
        <p className="text-sm text-muted-foreground">
          {total === 0
            ? 'Everything is handled.'
            : `${total} ${total === 1 ? 'item' : 'items'} awaiting your decision.`}
        </p>
      </div>
    </div>
  );
}

interface RowProps {
  item: InboxItem;
  onMutated: () => void;
  onError: (message: string) => void;
  onSuccess: (message: string) => void;
}

/** Run a mutating fetch against a derived endpoint; surface success/error toasts. */
async function runMutation(
  endpoint: EndpointDescriptor,
  body: Record<string, unknown> | undefined,
  props: Pick<RowProps, 'onMutated' | 'onError' | 'onSuccess'>,
  successMessage: string,
): Promise<boolean> {
  try {
    const response = await fetch(endpoint.url, {
      method: endpoint.method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(
        (payload as { error?: string } | null)?.error || `HTTP ${response.status}`,
      );
    }
    props.onSuccess(successMessage);
    // The WS broadcast will refetch; also refetch defensively in case it's missed.
    props.onMutated();
    return true;
  } catch (err) {
    props.onError(err instanceof Error ? err.message : String(err));
    return false;
  }
}

function InboxItemRow({ item, onMutated, onError, onSuccess }: RowProps) {
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border/70 bg-background/40 p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <Link
          to={assignmentHref(item)}
          className="text-sm font-semibold text-foreground hover:underline"
        >
          {item.title}
        </Link>
        <span className="text-xs text-muted-foreground">
          {item.project ? item.project : 'standalone'}
        </span>
        <span className="ml-auto text-xs text-muted-foreground" title={item.since}>
          {formatAge(item.ageMs)}
        </span>
      </div>

      {item.summary ? (
        <p className="text-sm text-muted-foreground">{item.summary}</p>
      ) : null}

      <InboxItemActions
        item={item}
        onMutated={onMutated}
        onError={onError}
        onSuccess={onSuccess}
      />

      {/* The exact CLI form, so the user can copy it too. */}
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-muted/60 px-2 py-1 font-mono text-[11px] text-muted-foreground">
          {item.action.command}
        </code>
        <CopyButton
          value={item.action.command}
          label="Copy"
          onError={(e) => onError(e.message)}
        />
      </div>
    </li>
  );
}

function InboxItemActions(props: RowProps) {
  switch (props.item.category) {
    case 'review':
      return <ReviewActions {...props} />;
    case 'blocked':
      return <BlockedActions {...props} />;
    case 'question':
      return <QuestionActions {...props} />;
    case 'plan-approval':
      return <PlanApprovalActions {...props} />;
    default:
      return null;
  }
}

/** Reuse `shell-action` button styling consistent with the rest of the SPA. */
const ACTION_BTN = 'shell-action inline-flex items-center gap-1.5';

function ReviewActions({ item, onMutated, onError, onSuccess }: RowProps) {
  const [busy, setBusy] = useState<string | null>(null);
  // Accept command is derived (from the lifecycle status-config) and carried in
  // `action.command`; parse it back rather than hardcoding `complete`.
  const acceptCommand = parseTransitionCommand(item.action.command);

  async function run(command: string, verb: string) {
    setBusy(command);
    await runMutation(
      transitionEndpoint(item, command),
      undefined,
      { onMutated, onError, onSuccess },
      `${verb} — ${item.title}`,
    );
    setBusy(null);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={ACTION_BTN}
        disabled={busy !== null || !acceptCommand}
        title={acceptCommand ? undefined : 'Could not derive the accept command — use the CLI form below.'}
        onClick={() => acceptCommand && run(acceptCommand, 'Accepted')}
      >
        <Check className="h-3.5 w-3.5" />
        {busy === acceptCommand ? 'Accepting…' : 'Accept'}
      </button>
      <button
        type="button"
        className={ACTION_BTN}
        disabled={busy !== null}
        onClick={() => run('reopen', 'Reopened')}
      >
        <RotateCcw className="h-3.5 w-3.5" />
        {busy === 'reopen' ? 'Reopening…' : 'Reopen'}
      </button>
    </div>
  );
}

function BlockedActions({ item, onMutated, onError, onSuccess }: RowProps) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    const ok = await runMutation(
      transitionEndpoint(item, 'unblock'),
      reason.trim() ? { reason: reason.trim() } : undefined,
      { onMutated, onError, onSuccess },
      `Unblocked — ${item.title}`,
    );
    setBusy(false);
    if (ok) setReason('');
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="text"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (optional)"
        className="min-w-[12rem] flex-1 rounded border border-border bg-background px-2 py-1 text-sm"
      />
      <button type="button" className={ACTION_BTN} disabled={busy} onClick={run}>
        <Unlock className="h-3.5 w-3.5" />
        {busy ? 'Unblocking…' : 'Unblock'}
      </button>
    </div>
  );
}

function QuestionActions({ item, onMutated, onError, onSuccess }: RowProps) {
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);

  // Post an answer (reply) then mark the question resolved. We can't target the
  // specific commentId from the inbox payload's reply, so this posts a top-level
  // answer comment; the question is resolved via the comment id parsed from the
  // CLI command (`--reply-to <id>`), keeping parity with the CLI answer flow.
  const replyToId = parseReplyToId(item.action.command);

  async function postReply() {
    if (!reply.trim()) return;
    setBusy(true);
    const ok = await runMutation(
      commentsEndpoint(item),
      {
        body: reply.trim(),
        type: 'note',
        author: 'human',
        ...(replyToId ? { replyTo: replyToId } : {}),
      },
      { onMutated, onError, onSuccess },
      `Replied — ${item.title}`,
    );
    setBusy(false);
    if (ok) setReply('');
  }

  async function resolve() {
    if (!replyToId) {
      onError('Could not determine which question to resolve — open the assignment to resolve it.');
      return;
    }
    setBusy(true);
    await runMutation(
      { ...resolveCommentEndpoint(item, replyToId) },
      { resolved: true },
      { onMutated, onError, onSuccess },
      `Resolved — ${item.title}`,
    );
    setBusy(false);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Link to={assignmentHref(item, 'comments')} className={ACTION_BTN}>
          <ArrowRight className="h-3.5 w-3.5" />
          Open to answer
        </Link>
        <button
          type="button"
          className={ACTION_BTN}
          disabled={busy || !replyToId}
          title={replyToId ? undefined : 'Open the assignment to resolve this question.'}
          onClick={resolve}
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          Resolve
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          placeholder="Reply inline…"
          className="min-w-[12rem] flex-1 rounded border border-border bg-background px-2 py-1 text-sm"
        />
        <button
          type="button"
          className={ACTION_BTN}
          disabled={busy || !reply.trim()}
          onClick={postReply}
        >
          <HelpCircle className="h-3.5 w-3.5" />
          {busy ? 'Posting…' : 'Reply'}
        </button>
      </div>
    </div>
  );
}

function PlanApprovalActions({ item }: RowProps) {
  // No approve HTTP route exists (it's CLI-only), so an inline approve would be a
  // new mutation primitive (barred). We jump the human to the plan view, where
  // they read and approve. The exact CLI approve command is shown below the row.
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link to={assignmentHref(item, 'plan')} className={ACTION_BTN}>
        <ArrowRight className="h-3.5 w-3.5" />
        Review plan
      </Link>
    </div>
  );
}

/**
 * Pull the `--reply-to <id>` comment id out of a question item's CLI command
 * (`syntaur comment <slug> "<answer>" --reply-to <commentId> ...`). Returns null
 * when absent so callers fall back to a top-level reply / the jump link.
 */
function parseReplyToId(command: string): string | null {
  const match = /--reply-to\s+(\S+)/.exec(command);
  return match ? match[1] : null;
}
