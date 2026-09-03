import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Loader2, Send, Square } from 'lucide-react';
import { useAssignmentChat } from '../../hooks/useAssignmentChat';
import { agentColorClasses, formatDuration, pinnedPlan } from '../../lib/chat-format';
import { cn } from '../../lib/utils';
import { EmptyState } from '../EmptyState';
import { ChatItemView, PlanCard } from './items';
import type { AgentPlanItem, ChatSessionState } from '../../lib/chat-types';

/**
 * The Chat tab: an agent chip with the session state, a scrolling item list, a
 * pinned plan while a turn runs, and the composer.
 *
 * The working indicator is driven by Syntaur's own clock, not by adapter
 * activity — claude-agent-acp emits no thinking signal and is silent for ~25 s
 * at the inherited xhigh effort (RESULTS.md §09).
 */

const STATE_LABELS: Record<ChatSessionState, string> = {
  none: 'not started',
  spawning: 'starting…',
  ready: 'ready',
  running: 'working',
  idle: 'idle',
  stopped: 'stopped',
  error: 'error',
};

const STATE_TONES: Record<ChatSessionState, string> = {
  none: 'bg-muted text-muted-foreground',
  spawning: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  ready: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  running: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  idle: 'bg-muted text-muted-foreground',
  stopped: 'bg-muted text-muted-foreground',
  error: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
};

export interface ChatTabProps {
  /** The assignment's frontmatter `id` — every chat route is keyed on it. */
  assignmentId: string;
}

export function ChatTab({ assignmentId }: ChatTabProps) {
  const {
    items,
    sessions,
    attached,
    agents,
    loading,
    error,
    hasMore,
    working,
    send,
    withdraw,
    cancel,
    answerPermission,
    loadOlder,
  } = useAssignmentChat(assignmentId);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const pinnedAtBottom = useRef(true);

  // Task 7 replaces this header with one chip per attached agent; until then it
  // shows the first attached agent, which is the default in a one-agent chat.
  const agent = attached[0] ?? agents.find((a) => a.default) ?? agents[0];
  const session = agent ? (sessions.get(agent.id) ?? null) : null;
  const workingNow = agent ? (working.get(agent.id) ?? null) : null;
  const agentName = agent?.name ?? session?.agentId ?? 'Agent';
  const agentColor = agent?.color ?? 'slate';
  const state: ChatSessionState = session?.state ?? 'none';
  const plan = pinnedPlan(items) as AgentPlanItem | null;

  // Follow the stream only while the reader is already at the bottom, so
  // scrolling back through history is not yanked away by the next chunk.
  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    pinnedAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 40 && hasMore) void loadOlder();
  }, [hasMore, loadOlder]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && pinnedAtBottom.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const canSend = draft.trim().length > 0 && !sending && agents.length > 0 && !agent?.missing;

  const submit = useCallback(async () => {
    if (!canSend) return;
    const text = draft;
    setSending(true);
    try {
      await send(text, agent?.id ?? null);
      setDraft('');
    } catch {
      // `error` is surfaced from the hook; keep the draft so nothing is lost.
    } finally {
      setSending(false);
    }
  }, [agent?.id, canSend, draft, send]);

  useEffect(() => {
    if (!error) return;
    pinnedAtBottom.current = true;
  }, [error]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-1 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading chat…
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-18rem)] min-h-[26rem] flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className={cn('rounded px-2 py-0.5 text-xs font-medium', agentColorClasses(agentColor))}>
          {agentName}
        </span>
        <span className={cn('rounded px-2 py-0.5 text-[11px]', STATE_TONES[state])}>{STATE_LABELS[state]}</span>
        {session?.model && <span className="text-[11px] text-muted-foreground">{session.model}</span>}
        {workingNow && (
          <span className="text-[11px] text-muted-foreground">working {formatDuration(workingNow?.elapsedMs)}</span>
        )}
        <span className="flex-1" />
        {workingNow && (
          <button
            type="button"
            onClick={() => void cancel(agent?.id ?? null)}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
          >
            <Square className="h-3 w-3" />
            Interrupt
          </button>
        )}
      </div>

      {agent?.missing && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          {agent.harness} is not on PATH. Install it with <code className="font-mono">{agent.missing}</code>.
        </div>
      )}
      {session?.error && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/5 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
          {session.error}
        </div>
      )}
      {error && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/5 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
          {error}
        </div>
      )}

      <div
        ref={listRef}
        onScroll={onScroll}
        className="flex-1 space-y-2 overflow-y-auto rounded-md border border-border/60 bg-muted/10 p-3"
      >
        {hasMore && items.length > 0 && (
          <button
            type="button"
            onClick={() => void loadOlder()}
            className="mx-auto block rounded px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            Load older messages
          </button>
        )}
        {items.length === 0 ? (
          <EmptyState
            title="No messages yet"
            description="Send a message to start the agent in this assignment's worktree. The adapter is spawned on the first message and torn down when the chat goes idle."
          />
        ) : (
          items.map((item) => (
            <ChatItemView
              key={item.itemId}
              item={item}
              context={{
                agentName,
                agentColor,
                onWithdraw: (messageId) => void withdraw(messageId),
                onAnswerPermission: (requestId, optionId) => void answerPermission(requestId, optionId),
              }}
            />
          ))
        )}
      </div>

      {plan && (
        <div className="shrink-0">
          <PlanCard item={plan} pinned />
        </div>
      )}

      <div className="shrink-0 space-y-2">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter is a newline — the chat convention.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            rows={2}
            placeholder={
              agents.length === 0
                ? 'No agent definitions available'
                : `Message ${agentName}… (Enter to send, Shift+Enter for a newline)`
            }
            disabled={agents.length === 0}
            className="min-h-[3rem] flex-1 resize-y rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-60"
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSend}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send
          </button>
        </div>
        {(session?.queued.length ?? 0) > 0 && (
          <div className="text-[11px] text-muted-foreground">
            {session!.queued.length} message{session!.queued.length === 1 ? '' : 's'} queued — they send when the
            current turn ends.
          </div>
        )}
      </div>
    </div>
  );
}
