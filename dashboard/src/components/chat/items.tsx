import { useState } from 'react';
import {
  ArrowRight,
  Brain,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  FilePen,
  FileText,
  FolderInput,
  Globe,
  Loader2,
  Search,
  Terminal,
  ToggleLeft,
  Trash2,
  Undo2,
  Wrench,
} from 'lucide-react';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { chatAttachmentUrl } from '../../lib/chat-attachments';
import { cn } from '../../lib/utils';
import {
  activitySummary,
  agentColorClasses,
  formatDuration,
  formatLocations,
  orderPermissionOptions,
  permissionButtonTone,
  preferredAllowOption,
  summarizeTurn,
  summarizeWork,
  workInProgress,
  type TurnActivity,
} from '../../lib/chat-format';
import type { ItemAuthor } from '../../lib/chat-api';
import { RawIoDisclosure, ToolContentBlock } from './blocks';
import type {
  AgentMessageItem,
  AgentPlanItem,
  AgentThoughtItem,
  AgentWorkItem,
  ChatItem,
  ChatRecordKind,
  HandoffItem,
  PermissionRequestItem,
  QuestionItem,
  SystemItem,
  ToolKind,
  ToolRow,
  TurnStatusItem,
  UserMessageItem,
} from '../../lib/chat-types';
import { OverflowMenu } from '../OverflowMenu';
import { RECORD_MENU } from '../../lib/chat-records';

/** One row per §5.3 item type. All presentational; state lives in the hook. */

export interface ItemViewContext {
  /** Who wrote this row — the human, an agent, or Syntaur itself. */
  authorOf: (item: { agentId: string }) => ItemAuthor;
  /** The turn's thoughts and tool rows, behind the Activity disclosure. */
  activityOf: (turnId: string | null) => TurnActivity | undefined;
  onWithdraw: (messageId: string) => void;
  onAnswerPermission: (
    requestId: string,
    optionId: string,
    opts?: { allowAllSession?: boolean },
  ) => void;
  onAnswerQuestion: (requestId: string, answer: { optionId?: string; text?: string }) => void;
  onFile: (item: UserMessageItem | AgentMessageItem, kind: ChatRecordKind) => void;
}

/** An author's colour chip: the avatar, then the name. */
export function AuthorBadge({ author }: { author: ItemAuthor }) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-medium',
          agentColorClasses(author.color),
        )}
        aria-hidden
      >
        {author.avatar}
      </span>
      <span className="text-[11px] font-medium text-muted-foreground">{author.name}</span>
    </div>
  );
}

const TOOL_ICONS: Record<ToolKind, typeof FileText> = {
  read: FileText,
  edit: FilePen,
  delete: Trash2,
  move: FolderInput,
  search: Search,
  execute: Terminal,
  think: Brain,
  fetch: Globe,
  switch_mode: ToggleLeft,
  other: Wrench,
};

function MessageRecordMenu({
  item,
  onFile,
}: {
  item: UserMessageItem | AgentMessageItem;
  onFile: (item: UserMessageItem | AgentMessageItem, kind: ChatRecordKind) => void;
}) {
  return (
    <div className="absolute right-1 top-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      <OverflowMenu
        align="end"
        items={RECORD_MENU.map((entry) => ({
          key: entry.kind,
          label: entry.label,
          onSelect: () => onFile(item, entry.kind),
        }))}
      />
    </div>
  );
}

export function UserMessageBubble({
  item,
  author,
  onWithdraw,
  onFile,
}: {
  item: UserMessageItem;
  author: ItemAuthor;
  onWithdraw: (messageId: string) => void;
  onFile?: (item: UserMessageItem | AgentMessageItem, kind: ChatRecordKind) => void;
}) {
  const queued = item.state === 'queued';
  const withdrawn = item.state === 'withdrawn';
  const targets = item.targets ?? [];
  const delivered = item.deliveredTo ?? [];
  const pending = targets.filter((id) => !delivered.includes(id));
  return (
    <div id={item.itemId} className="flex flex-col items-end gap-1">
      <AuthorBadge author={author} />
      <div
        className={cn(
          'group relative max-w-[85%] rounded-lg rounded-br-sm border px-3 py-2 text-sm',
          withdrawn
            ? 'border-dashed border-border/60 bg-muted/20 text-muted-foreground line-through'
            : 'border-primary/30 bg-primary/10 text-foreground',
          queued && 'border-dashed opacity-80',
        )}
      >
        {onFile &&
          !withdrawn &&
          item.state !== 'replayed' &&
          item.text.trim().length > 0 && <MessageRecordMenu item={item} onFile={onFile} />}
        {item.text.trim().length > 0 && (
          <div className="whitespace-pre-wrap break-words">{item.text}</div>
        )}
        {item.attachments && item.attachments.length > 0 && (
          <div className={cn('flex flex-wrap gap-2', item.text.trim().length > 0 && 'mt-2')}>
            {item.attachments.map((att) => (
              <a
                key={att.id}
                href={chatAttachmentUrl(item.ticketId, att.id)}
                target="_blank"
                rel="noreferrer"
                className="block"
              >
                <img
                  src={chatAttachmentUrl(item.ticketId, att.id)}
                  alt={att.name}
                  className="max-h-40 rounded object-contain"
                />
              </a>
            ))}
          </div>
        )}
        {/* Who it went to, but only when it went to more than one agent —
            a single-target message already says so with its @mention. */}
        {targets.length > 1 && !withdrawn && (
          <div className="mt-1 text-right text-[11px] text-muted-foreground">
            {targets.map((id) => `@${id}`).join(', ')}
          </div>
        )}
        {(queued || withdrawn || item.state === 'partial' || item.state === 'replayed') && (
          <div className="mt-1 flex items-center justify-end gap-2 text-[11px] text-muted-foreground">
            <span>
              {queued ? 'Queued — will send when the current turn ends' : null}
              {item.state === 'partial'
                ? `Delivering to ${pending.map((id) => `@${id}`).join(', ')}…`
                : null}
              {withdrawn ? 'Withdrawn' : null}
              {item.state === 'replayed' ? 'From the agent’s own history' : null}
            </span>
            {queued && (
              <button
                type="button"
                onClick={() => onWithdraw(item.messageId)}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
              >
                <Undo2 className="h-3 w-3" />
                Withdraw
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One agent handing the conversation to another (§5.3). A thin row rather than
 * a bubble: it is a routing fact, not something anyone said.
 */
export function HandoffRow({ item }: { item: HandoffItem }) {
  return (
    <div className="flex items-center gap-2 py-0.5 text-[11px] text-muted-foreground">
      <ArrowRight className="h-3 w-3 shrink-0" />
      <span>
        <span className="font-mono">@{item.fromAgentId}</span>
        {' → '}
        <span className="font-mono">@{item.toAgentId}</span>
        {` · hop ${item.hop} of ${item.budget}`}
      </span>
      {item.triggerItemId && (
        <a
          href={`#${item.triggerItemId}`}
          className="underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
          the message
        </a>
      )}
      <span className="h-px flex-1 bg-border/60" />
    </div>
  );
}

export function AgentMessage({
  item,
  author,
  onFile,
}: {
  item: AgentMessageItem;
  author: ItemAuthor;
  onFile?: (item: UserMessageItem | AgentMessageItem, kind: ChatRecordKind) => void;
}) {
  return (
    <div className="space-y-1" id={item.itemId}>
      <AuthorBadge author={author} />
      <div className="group relative rounded-lg rounded-tl-sm border border-border/60 bg-background px-3 py-2">
        {onFile && item.sealed && item.text.trim().length > 0 && (
          <MessageRecordMenu item={item} onFile={onFile} />
        )}
        <MarkdownRenderer content={item.text} emptyState="…" className="text-sm" />
        {!item.sealed && (
          // A blinking caret is the only "still streaming" signal there is —
          // claude-agent-acp emits no thinking events at all.
          <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-foreground/60 align-middle" />
        )}
      </div>
    </div>
  );
}

export function ThoughtRow({ item }: { item: AgentThoughtItem }) {
  const [open, setOpen] = useState(false);
  const preview = item.text.trim().split('\n')[0]?.slice(0, 90) ?? '';
  return (
    <div className="rounded-md border border-dashed border-border/60 bg-muted/20">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <Brain className="h-3 w-3 shrink-0" />
        <span className="truncate">{open ? 'Thinking' : preview || 'Thinking…'}</span>
      </button>
      {open && (
        <div className="px-3 pb-2 pl-8 text-xs text-muted-foreground">
          <div className="whitespace-pre-wrap">{item.text}</div>
        </div>
      )}
    </div>
  );
}

function ToolRowView({ row }: { row: ToolRow }) {
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICONS[row.kind] ?? Wrench;
  const locations = formatLocations(row.locations);
  return (
    <div className="border-t border-border/50 first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted/40"
      >
        {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-foreground">{row.title}</span>
        {locations && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{locations}</span>}
        <span className="ml-auto shrink-0">
          {row.status === 'running' && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          {row.status === 'completed' && <CircleCheck className="h-3.5 w-3.5 text-emerald-500" />}
          {row.status === 'failed' && <CircleAlert className="h-3.5 w-3.5 text-rose-500" />}
        </span>
      </button>
      {open && (
        <div className="space-y-2 px-3 pb-2 pl-8">
          {row.content.map((block, index) => (
            <ToolContentBlock key={index} block={block} />
          ))}
          <RawIoDisclosure rawInput={row.rawInput} rawOutput={row.rawOutput} />
        </div>
      )}
    </div>
  );
}

/**
 * A work card in the CHAT column: its header line only (Decision 5). The
 * per-tool rows — diffs, terminal output, raw I/O — are reachable from the
 * turn's Activity disclosure, so the conversation reads as a conversation.
 */
export function WorkCard({ item }: { item: AgentWorkItem }) {
  const running = workInProgress(item);
  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-muted/10">
      {item.lead && (
        // The fold rule: a short narration that preceded the first tool call
        // becomes this header line instead of its own bubble (§5.3).
        <div className="border-b border-border/50 px-3 py-2 text-sm text-foreground">{item.lead}</div>
      )}
      <div className="flex w-full items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
        {running ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        ) : (
          <Wrench className="h-3.5 w-3.5 shrink-0" />
        )}
        <span>{summarizeWork(item.summary)}</span>
        <span className="ml-auto">{item.tools.length} step{item.tools.length === 1 ? '' : 's'}</span>
      </div>
    </div>
  );
}

/** The same card, expanded — only ever rendered inside the disclosure. */
export function WorkCardDetail({ item }: { item: AgentWorkItem }) {
  return (
    <div className="overflow-hidden rounded-md border border-border/50 bg-background">
      <div className="border-b border-border/50 px-3 py-1.5 text-[11px] text-muted-foreground">
        {summarizeWork(item.summary)}
      </div>
      {item.tools.map((row) => (
        <ToolRowView key={row.toolCallId} row={row} />
      ))}
    </div>
  );
}

export function PlanCard({ item, pinned = false }: { item: AgentPlanItem; pinned?: boolean }) {
  return (
    <div
      className={cn(
        'rounded-lg border bg-background',
        pinned ? 'border-primary/40 shadow-sm' : 'border-border/60',
      )}
    >
      <div className="border-b border-border/50 px-3 py-1.5 text-xs font-medium text-muted-foreground">
        Plan{pinned ? ' · in progress' : ''}
      </div>
      <ul className="space-y-1 px-3 py-2">
        {item.entries.map((entry, index) => (
          <li key={index} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 shrink-0">
              {entry.status === 'completed' && <CircleCheck className="h-3.5 w-3.5 text-emerald-500" />}
              {entry.status === 'in_progress' && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
              {entry.status === 'pending' && (
                <span className="block h-3.5 w-3.5 rounded-full border border-border" />
              )}
            </span>
            <span className={cn(entry.status === 'completed' && 'text-muted-foreground line-through')}>
              {entry.content}
            </span>
          </li>
        ))}
        {item.entries.length === 0 && <li className="text-xs text-muted-foreground">No plan entries.</li>}
      </ul>
    </div>
  );
}

export function PermissionCard({
  item,
  onAnswer,
}: {
  item: PermissionRequestItem;
  onAnswer: (
    requestId: string,
    optionId: string,
    opts?: { allowAllSession?: boolean },
  ) => void;
}) {
  const title = item.toolCall.title ?? 'a tool';
  if (item.auto) {
    return (
      <div className="py-0.5 text-[11px] text-muted-foreground">Auto-approved: {title}</div>
    );
  }
  const answered = item.answer !== undefined || item.cancelled || item.timedOut;
  const options = orderPermissionOptions(item.options);
  return (
    <div id={item.itemId} className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2">
      <div className="text-sm text-foreground">
        The agent wants to run <span className="font-mono text-xs">{title}</span>
      </div>
      {answered ? (
        <div className="mt-1.5 text-xs text-muted-foreground">
          {item.timedOut
            ? 'No answer in time — denied, and filed as a question in the Inbox.'
            : item.cancelled
              ? 'Cancelled with the turn.'
              : `Answered: ${options.find((o) => o.optionId === item.answer)?.name ?? item.answer}`}
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {options.map((option) => {
            const tone = permissionButtonTone(option.kind);
            return (
              <button
                key={option.optionId}
                type="button"
                onClick={() => onAnswer(item.requestId, option.optionId)}
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
            onClick={() =>
              onAnswer(item.requestId, preferredAllowOption(item.options).optionId, {
                allowAllSession: true,
              })
            }
            className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium hover:bg-muted"
          >
            Allow all this session
          </button>
        </div>
      )}
    </div>
  );
}

export function QuestionCard({
  item,
  onAnswer,
}: {
  item: QuestionItem;
  onAnswer: (requestId: string, answer: { optionId?: string; text?: string }) => void;
}) {
  const [freeText, setFreeText] = useState('');
  const answered = item.answer !== null || item.cancelled || item.timedOut;
  const options = item.options ?? [];
  return (
    <div id={item.itemId} className="rounded-lg border border-sky-500/40 bg-sky-500/5 px-3 py-2">
      <div className="text-sm text-foreground">{item.text}</div>
      {answered ? (
        <div className="mt-1.5 text-xs text-muted-foreground">
          {item.timedOut
            ? 'No answer in time — the turn moved on.'
            : item.cancelled
              ? 'Cancelled with the turn.'
              : `Answered: ${item.answer}`}
        </div>
      ) : options.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => onAnswer(item.requestId, { optionId: option.id })}
              className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium hover:bg-muted"
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : (
        <div className="mt-2 flex gap-2">
          <input
            type="text"
            value={freeText}
            onChange={(event) => setFreeText(event.target.value)}
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
            placeholder="Your answer…"
          />
          <button
            type="button"
            disabled={freeText.trim().length === 0}
            onClick={() => onAnswer(item.requestId, { text: freeText.trim() })}
            className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
}

export function TurnStatusRow({
  item,
  author,
  activity,
}: {
  item: TurnStatusItem;
  author: ItemAuthor;
  activity?: TurnActivity;
}) {
  const [open, setOpen] = useState(false);
  const running = item.state === 'running';
  const summary = activity ? activitySummary(activity) : '';
  const hop = item.trigger?.kind === 'handoff' ? item.trigger : null;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 py-0.5 text-[11px] text-muted-foreground">
        {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <span className="h-px w-3 bg-border" />}
        <span>
          {running
            ? `${author.name} is working…`
            : summarizeTurn({
                agentName: author.name,
                durationMs: item.durationMs,
                totalTokens: item.usage?.totalTokens ?? null,
                cost: item.cost ?? null,
                stopReason: item.stopReason,
              })}
          {hop ? ` · triggered by @${hop.fromAgentId}, hop ${hop.hop}` : ''}
        </span>
        {summary && (
          // The activity disclosure (Decision 5): thoughts and the full tool
          // rows for this turn, out of the conversation but one click away.
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
          >
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Activity · {summary}
          </button>
        )}
        <span className="h-px flex-1 bg-border/60" />
      </div>
      {open && activity && (
        <div className="space-y-2 pl-5">
          {activity.thoughts.map((thought) => (
            <ThoughtRow key={thought.itemId} item={thought as AgentThoughtItem} />
          ))}
          {activity.work.map((card) => (
            <WorkCardDetail key={card.itemId} item={card as AgentWorkItem} />
          ))}
        </div>
      )}
    </div>
  );
}

export function SystemRow({ item }: { item: SystemItem }) {
  return (
    <div
      className={cn(
        'py-0.5 text-[11px]',
        item.level === 'error' ? 'text-rose-500' : item.level === 'warn' ? 'text-amber-600' : 'text-muted-foreground',
      )}
    >
      {item.text}
    </div>
  );
}

/** Switch on the item type — the single place the union is unpacked. */
export function ChatItemView({ item, context }: { item: ChatItem; context: ItemViewContext }) {
  switch (item.type) {
    case 'user.message':
      return (
        <UserMessageBubble
          item={item}
          author={context.authorOf(item)}
          onWithdraw={context.onWithdraw}
          onFile={context.onFile}
        />
      );
    case 'handoff':
      return <HandoffRow item={item} />;
    case 'agent.message':
      return <AgentMessage item={item} author={context.authorOf(item)} onFile={context.onFile} />;
    case 'agent.thought':
      // Thoughts live behind the turn's Activity disclosure, not in the chat
      // column — `isChatColumnItem` filters them out before this switch.
      return <ThoughtRow item={item} />;
    case 'agent.work':
      return <WorkCard item={item} />;
    case 'agent.plan':
      return <PlanCard item={item} />;
    case 'permission.request':
      return <PermissionCard item={item} onAnswer={context.onAnswerPermission} />;
    case 'question':
      return <QuestionCard item={item} onAnswer={context.onAnswerQuestion} />;
    case 'turn.status':
      return (
        <TurnStatusRow
          item={item}
          author={context.authorOf(item)}
          activity={context.activityOf(item.turnId)}
        />
      );
    case 'system':
      return <SystemRow item={item} />;
    default:
      return null;
  }
}

export { formatDuration };
