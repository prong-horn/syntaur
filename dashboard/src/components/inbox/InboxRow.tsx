import { Link } from 'react-router-dom';
import {
  ClipboardCheck,
  Eye,
  MessageCircleQuestion,
} from 'lucide-react';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { authorOf } from '../../lib/chat-api';
import type { ChatAgentSummary } from '../../lib/chat-types';
import { agentColorClasses } from '../../lib/chat-format';
import {
  ticketHref,
  chatItemHref,
  formatAge,
  rowKey,
  rowKind,
  snoozeLabel,
  unsnoozeEndpoint,
  waitingLabel,
  type InboxItem,
} from '../../lib/inbox';
import { InboxRowActions, runMutation, type InboxRowActionProps } from './InboxRowActions';

export interface InboxRowProps extends InboxRowActionProps {
  item: InboxItem;
  agents: readonly ChatAgentSummary[];
  highlighted?: boolean;
  snoozed?: boolean;
}

function rowIcon(item: InboxItem) {
  const kind = rowKind(item);
  if (kind === 'plan-approval') return ClipboardCheck;
  if (kind === 'review') return Eye;
  if (kind === 'plain-question') return MessageCircleQuestion;
  return null;
}

export function InboxRow({ item, agents, highlighted, snoozed = false, ...actionProps }: InboxRowProps) {
  const kind = rowKind(item);
  const chatAuthor = item.chat ? authorOf({ agentId: item.chat.agentId }, agents) : null;
  const label = waitingLabel(item, chatAuthor ? { name: chatAuthor.name } : undefined);
  const Icon = rowIcon(item);
  const now = Date.now();

  const titleHref =
    kind === 'plan-approval'
      ? ticketHref(item, 'plan')
      : item.chat
        ? chatItemHref(item)
        : ticketHref(item);

  return (
    <li
      id={rowKey(item)}
      className={`flex gap-3 rounded-lg border border-border/70 bg-background/40 p-3${highlighted ? ' ring-2 ring-primary' : ''}${snoozed ? ' opacity-60' : ''}`}
    >
      <div className="shrink-0 pt-0.5">
        {chatAuthor ? (
          <span
            className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold ${agentColorClasses(chatAuthor.color)}`}
            title={chatAuthor.name}
          >
            {chatAuthor.avatar}
          </span>
        ) : Icon ? (
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Icon className="h-4 w-4" />
          </span>
        ) : null}
      </div>

      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>

        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <Link to={titleHref} className="text-sm font-semibold text-foreground hover:underline">
            {item.title}
          </Link>
          <span className="text-xs text-muted-foreground">
            {item.project ?? 'standalone'}
          </span>
          <span className="ml-auto text-xs text-muted-foreground" title={item.since}>
            {formatAge(item.ageMs)}
          </span>
        </div>

        {item.category === 'question' ? (
          <div className="prose prose-sm max-w-none text-sm text-muted-foreground dark:prose-invert">
            <MarkdownRenderer content={item.body ?? item.summary} />
          </div>
        ) : item.category === 'review' ? (
          <p className="text-sm text-muted-foreground">{item.summary}</p>
        ) : item.category === 'plan-approval' ? (
          <p className="text-sm text-muted-foreground">The latest plan awaits approval</p>
        ) : null}

        {snoozed ? (
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>{snoozeLabel(item.snoozed?.until ?? null, now)}</span>
            <button
              type="button"
              className="shell-action"
              onClick={() =>
                void runMutation(
                  unsnoozeEndpoint(rowKey(item)),
                  undefined,
                  actionProps,
                  'Unsnoozed',
                  item.ticketId,
                  item.project,
                )
              }
            >
              Unsnooze
            </button>
          </div>
        ) : (
          <InboxRowActions item={item} {...actionProps} />
        )}
      </div>
    </li>
  );
}
