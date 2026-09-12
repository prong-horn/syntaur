import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, CheckCircle2, RotateCcw } from 'lucide-react';
import { cn } from '../../lib/utils';
import {
  answerChatPermission,
  answerChatQuestion,
  sendChatMessage,
} from '../../lib/chat-api';
import {
  orderPermissionOptions,
  permissionButtonTone,
  preferredAllowOption,
} from '../../lib/chat-format';
import {
  ticketHref,
  chatItemHref,
  chatReplyText,
  commentsEndpoint,
  isSnoozable,
  planApproveEndpoint,
  resolveCommentEndpoint,
  rowKey,
  rowKind,
  snoozeEndpoint,
  transitionEndpoint,
  type EndpointDescriptor,
  type InboxItem,
} from '../../lib/inbox';

export interface InboxRowActionProps {
  onMutated: () => void;
  onError: (message: string) => void;
  onSuccess: (message: string) => void;
}

const ACTION_BTN = 'shell-action inline-flex items-center gap-1.5';

export async function runMutation(
  endpoint: EndpointDescriptor,
  body: Record<string, unknown> | undefined,
  props: Pick<InboxRowActionProps, 'onMutated' | 'onError' | 'onSuccess'>,
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
    props.onMutated();
    return true;
  } catch (err) {
    props.onError(err instanceof Error ? err.message : String(err));
    return false;
  }
}

export async function runMutationTask(
  task: () => Promise<unknown>,
  props: Pick<InboxRowActionProps, 'onMutated' | 'onError' | 'onSuccess'>,
  successMessage: string,
): Promise<boolean> {
  try {
    await task();
    props.onSuccess(successMessage);
    props.onMutated();
    return true;
  } catch (err) {
    props.onError(err instanceof Error ? err.message : String(err));
    return false;
  }
}

function SnoozeMenu({
  item,
  onMutated,
  onError,
  onSuccess,
}: InboxRowActionProps & { item: InboxItem }) {
  if (!isSnoozable(item)) return null;
  const key = rowKey(item);
  const props = { onMutated, onError, onSuccess };

  async function snooze(body: Record<string, unknown>) {
    await runMutation(snoozeEndpoint(key), body, props, 'Snoozed');
  }

  return (
    <details className="relative inline-block text-sm">
      <summary className="cursor-pointer list-none shell-action inline-flex items-center">
        Not now
      </summary>
      <div className="absolute z-10 mt-1 min-w-[10rem] rounded-md border border-border bg-background p-1 shadow-md">
        <button type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-muted" onClick={() => void snooze({ untilDays: 1 })}>
          One day
        </button>
        <button type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-muted" onClick={() => void snooze({ untilDays: 7 })}>
          One week
        </button>
        <button type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-muted" onClick={() => void snooze({ untilChange: true })}>
          Until it changes
        </button>
      </div>
    </details>
  );
}

export function InboxRowActions({ item, onMutated, onError, onSuccess }: InboxRowActionProps & { item: InboxItem }) {
  const menu = (
    <SnoozeMenu item={item} onMutated={onMutated} onError={onError} onSuccess={onSuccess} />
  );

  switch (rowKind(item)) {
    case 'reply':
      return (
        <div className="space-y-2">
          {menu}
          <ReplyActions item={item} onMutated={onMutated} onError={onError} onSuccess={onSuccess} />
        </div>
      );
    case 'permission':
      return (
        <div className="space-y-2">
          {menu}
          <PermissionActions item={item} onMutated={onMutated} onError={onError} onSuccess={onSuccess} />
        </div>
      );
    case 'ask':
      return (
        <div className="space-y-2">
          {menu}
          <AskActions item={item} onMutated={onMutated} onError={onError} onSuccess={onSuccess} />
        </div>
      );
    case 'plain-question':
      return (
        <div className="space-y-2">
          {menu}
          <PlainQuestionActions item={item} onMutated={onMutated} onError={onError} onSuccess={onSuccess} />
        </div>
      );
    case 'review':
      return (
        <div className="space-y-2">
          {menu}
          <ReviewActions item={item} onMutated={onMutated} onError={onError} onSuccess={onSuccess} />
        </div>
      );
    case 'plan-approval':
      return (
        <div className="space-y-2">
          {menu}
          <PlanActions item={item} onMutated={onMutated} onError={onError} onSuccess={onSuccess} />
        </div>
      );
    default:
      return null;
  }
}

function ReplyActions({ item, onMutated, onError, onSuccess }: InboxRowActionProps & { item: InboxItem }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const agentId = item.chat?.agentId ?? 'claude';

  async function send() {
    if (!text.trim()) return;
    setBusy(true);
    const ok = await runMutationTask(
      () => sendChatMessage(item.ticketId, chatReplyText(agentId, text)),
      { onMutated, onError, onSuccess },
      `Sent to @${agentId} — the row clears when it answers`,
    );
    if (ok) {
      setSent(true);
      setText('');
    }
    setBusy(false);
  }

  return (
    <div className="space-y-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`Reply to @${agentId}…`}
        rows={2}
        disabled={busy || sent}
        className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={ACTION_BTN} disabled={busy || sent || !text.trim()} onClick={send}>
          {busy ? 'Sending…' : 'Send'}
        </button>
        {sent ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">Sent</span>
        ) : null}
        <Link to={chatItemHref(item)} className="text-xs text-muted-foreground hover:text-foreground">
          Open chat
        </Link>
      </div>
    </div>
  );
}

function PermissionActions({ item, onMutated, onError, onSuccess }: InboxRowActionProps & { item: InboxItem }) {
  const [busy, setBusy] = useState(false);
  const card = item.card?.kind === 'permission' ? item.card : null;

  async function answer(optionId: string, allowAllSession = false) {
    if (!card) return;
    setBusy(true);
    await runMutationTask(
      () =>
        answerChatPermission(item.ticketId, card.requestId, optionId, {
          allowAllSession: allowAllSession || undefined,
        }),
      { onMutated, onError, onSuccess },
      'Permission answered',
    );
    setBusy(false);
  }

  if (!card || card.settled) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>{card?.settled ? 'Answered — clearing' : 'Card no longer available'}</span>
        <Link to={chatItemHref(item)} className="text-xs hover:text-foreground">Open chat</Link>
      </div>
    );
  }

  const options = orderPermissionOptions(card.options);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const tone = permissionButtonTone(option.kind);
          return (
            <button
              key={option.optionId}
              type="button"
              disabled={busy}
              onClick={() => answer(option.optionId)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium',
                tone === 'primary' && 'bg-primary text-primary-foreground hover:opacity-90',
                tone === 'secondary' && 'border border-border bg-background hover:bg-muted',
                tone === 'destructive' &&
                  'border border-rose-500/40 bg-rose-500/10 text-rose-600 hover:bg-rose-500/20 dark:text-rose-400',
              )}
            >
              {option.name}
            </button>
          );
        })}
        <button
          type="button"
          disabled={busy}
          onClick={() => answer(preferredAllowOption(card.options).optionId, true)}
          className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium hover:bg-muted"
        >
          Allow all this session
        </button>
      </div>
      <Link to={chatItemHref(item)} className="text-xs text-muted-foreground hover:text-foreground">
        Open chat
      </Link>
    </div>
  );
}

function AskActions({ item, onMutated, onError, onSuccess }: InboxRowActionProps & { item: InboxItem }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const card = item.card?.kind === 'ask' ? item.card : null;

  async function choose(optionId: string) {
    if (!card) return;
    setBusy(true);
    await runMutationTask(
      () => answerChatQuestion(item.ticketId, card.requestId, { optionId }),
      { onMutated, onError, onSuccess },
      'Answer sent',
    );
    setBusy(false);
  }

  async function sendText() {
    if (!card || !text.trim()) return;
    setBusy(true);
    const ok = await runMutationTask(
      () => answerChatQuestion(item.ticketId, card.requestId, { text: text.trim() }),
      { onMutated, onError, onSuccess },
      'Answer sent',
    );
    if (ok) setText('');
    setBusy(false);
  }

  if (!card) {
    return (
      <div className="text-sm text-muted-foreground">
        Card no longer available —{' '}
        <Link to={chatItemHref(item)} className="hover:text-foreground">Open chat</Link>
      </div>
    );
  }

  if (card.settled) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>Answered — clearing</span>
        <Link to={chatItemHref(item)} className="text-xs hover:text-foreground">Open chat</Link>
      </div>
    );
  }

  if (card.options && card.options.length > 0) {
    return (
      <div className="flex flex-wrap gap-2">
        {card.options.map((option) => (
          <button
            key={option.id}
            type="button"
            disabled={busy}
            className={ACTION_BTN}
            onClick={() => choose(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Your answer…"
        className="min-w-[12rem] flex-1 rounded border border-border bg-background px-2 py-1 text-sm"
        disabled={busy}
      />
      <button type="button" className={ACTION_BTN} disabled={busy || !text.trim()} onClick={sendText}>
        Send
      </button>
    </div>
  );
}

function PlainQuestionActions({ item, onMutated, onError, onSuccess }: InboxRowActionProps & { item: InboxItem }) {
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const replyToId = item.commentId;

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
      onError('Could not determine which question to resolve — open the ticket to resolve it.');
      return;
    }
    setBusy(true);
    await runMutation(
      resolveCommentEndpoint(item, replyToId),
      { resolved: true },
      { onMutated, onError, onSuccess },
      `Resolved — ${item.title}`,
    );
    setBusy(false);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Link to={ticketHref(item, 'comments')} className={ACTION_BTN}>
          <ArrowRight className="h-3.5 w-3.5" />
          Open to answer
        </Link>
        <button type="button" className={ACTION_BTN} disabled={busy || !replyToId} onClick={resolve}>
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
          disabled={busy}
        />
        <button type="button" className={ACTION_BTN} disabled={busy || !reply.trim()} onClick={postReply}>
          Reply
        </button>
      </div>
    </div>
  );
}

function ReviewActions({ item, onMutated, onError, onSuccess }: InboxRowActionProps & { item: InboxItem }) {
  const [busy, setBusy] = useState<string | null>(null);
  const { acceptCommand, reopenCommand } = item;

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
      {acceptCommand ? (
        <button type="button" className={ACTION_BTN} disabled={busy !== null} onClick={() => run(acceptCommand, 'Accepted')}>
          <Check className="h-3.5 w-3.5" />
          {busy === acceptCommand ? 'Accepting…' : 'Accept'}
        </button>
      ) : null}
      {reopenCommand ? (
        <button type="button" className={ACTION_BTN} disabled={busy !== null} onClick={() => run(reopenCommand, 'Reopened')}>
          <RotateCcw className="h-3.5 w-3.5" />
          {busy === reopenCommand ? 'Reopening…' : 'Reopen'}
        </button>
      ) : null}
    </div>
  );
}

function PlanActions({ item, onMutated, onError, onSuccess }: InboxRowActionProps & { item: InboxItem }) {
  const [busy, setBusy] = useState(false);

  async function approve() {
    setBusy(true);
    await runMutation(
      planApproveEndpoint(item),
      undefined,
      { onMutated, onError, onSuccess },
      `Plan approved — ${item.title}`,
    );
    setBusy(false);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={ACTION_BTN} disabled={busy} onClick={approve}>
        <Check className="h-3.5 w-3.5" />
        {busy ? 'Approving…' : 'Approve'}
      </button>
      <Link to={ticketHref(item, 'plan')} className={ACTION_BTN}>
        <ArrowRight className="h-3.5 w-3.5" />
        Read plan
      </Link>
    </div>
  );
}
