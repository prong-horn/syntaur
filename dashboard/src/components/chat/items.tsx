import { useState } from 'react';
import {
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
import { cn } from '../../lib/utils';
import {
  agentColorClasses,
  formatDuration,
  formatLocations,
  orderPermissionOptions,
  permissionButtonTone,
  summarizeTurn,
  summarizeWork,
  workInProgress,
} from '../../lib/chat-format';
import { RawIoDisclosure, ToolContentBlock } from './blocks';
import type {
  AgentMessageItem,
  AgentPlanItem,
  AgentThoughtItem,
  AgentWorkItem,
  ChatItem,
  PermissionRequestItem,
  SystemItem,
  ToolKind,
  ToolRow,
  TurnStatusItem,
  UserMessageItem,
} from '../../lib/chat-types';

/** One row per §5.3 item type. All presentational; state lives in the hook. */

export interface ItemViewContext {
  agentName: string;
  agentColor: string;
  onWithdraw: (messageId: string) => void;
  onAnswerPermission: (requestId: string, optionId: string) => void;
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

export function UserMessageBubble({
  item,
  onWithdraw,
}: {
  item: UserMessageItem;
  onWithdraw: (messageId: string) => void;
}) {
  const queued = item.state === 'queued';
  const withdrawn = item.state === 'withdrawn';
  return (
    <div className="flex justify-end">
      <div
        className={cn(
          'max-w-[85%] rounded-lg rounded-br-sm border px-3 py-2 text-sm',
          withdrawn
            ? 'border-dashed border-border/60 bg-muted/20 text-muted-foreground line-through'
            : 'border-primary/30 bg-primary/10 text-foreground',
          queued && 'border-dashed opacity-80',
        )}
      >
        <div className="whitespace-pre-wrap break-words">{item.text}</div>
        {(queued || withdrawn || item.state === 'replayed') && (
          <div className="mt-1 flex items-center justify-end gap-2 text-[11px] text-muted-foreground">
            <span>
              {queued ? 'Queued — will send when the current turn ends' : null}
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

export function AgentMessage({
  item,
  agentName,
  agentColor,
}: {
  item: AgentMessageItem;
  agentName: string;
  agentColor: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', agentColorClasses(agentColor))}>
          {agentName}
        </span>
      </div>
      <div className="rounded-lg rounded-tl-sm border border-border/60 bg-background px-3 py-2">
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

export function WorkCard({ item }: { item: AgentWorkItem }) {
  const [open, setOpen] = useState(false);
  const running = workInProgress(item);
  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-muted/10">
      {item.lead && (
        // The fold rule: a short narration that preceded the first tool call
        // becomes this header line instead of its own bubble (§5.3).
        <div className="border-b border-border/50 px-3 py-2 text-sm text-foreground">{item.lead}</div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        {running ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        ) : (
          <Wrench className="h-3.5 w-3.5 shrink-0" />
        )}
        <span>{summarizeWork(item.summary)}</span>
        <span className="ml-auto">{item.tools.length} step{item.tools.length === 1 ? '' : 's'}</span>
      </button>
      {open && (
        <div className="border-t border-border/50 bg-background">
          {item.tools.map((row) => (
            <ToolRowView key={row.toolCallId} row={row} />
          ))}
        </div>
      )}
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
  onAnswer: (requestId: string, optionId: string) => void;
}) {
  const answered = item.answer !== undefined || item.cancelled || item.timedOut;
  const options = orderPermissionOptions(item.options);
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2">
      <div className="text-sm text-foreground">
        The agent wants to run <span className="font-mono text-xs">{item.toolCall.title ?? 'a tool'}</span>
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
        </div>
      )}
    </div>
  );
}

export function TurnStatusRow({ item, agentName }: { item: TurnStatusItem; agentName: string }) {
  const running = item.state === 'running';
  return (
    <div className="flex items-center gap-2 py-0.5 text-[11px] text-muted-foreground">
      {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <span className="h-px w-3 bg-border" />}
      <span>
        {running
          ? `${agentName} is working…`
          : summarizeTurn({
              agentName,
              durationMs: item.durationMs,
              totalTokens: item.usage?.totalTokens ?? null,
              cost: item.cost ?? null,
              stopReason: item.stopReason,
            })}
      </span>
      <span className="h-px flex-1 bg-border/60" />
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
      return <UserMessageBubble item={item} onWithdraw={context.onWithdraw} />;
    case 'agent.message':
      return <AgentMessage item={item} agentName={context.agentName} agentColor={context.agentColor} />;
    case 'agent.thought':
      return <ThoughtRow item={item} />;
    case 'agent.work':
      return <WorkCard item={item} />;
    case 'agent.plan':
      return <PlanCard item={item} />;
    case 'permission.request':
      return <PermissionCard item={item} onAnswer={context.onAnswerPermission} />;
    case 'turn.status':
      return <TurnStatusRow item={item} agentName={context.agentName} />;
    case 'system':
      return <SystemRow item={item} />;
    default:
      return null;
  }
}

export { formatDuration };
