import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Square, Users } from 'lucide-react';
import { useAssignmentChat } from '../../hooks/useAssignmentChat';
import {
  agentColorClasses,
  formatDuration,
  groupByTurn,
  isChatColumnItem,
  pinnedPlan,
} from '../../lib/chat-format';
import { staleNote } from '../../lib/agent-editor';
import { cn } from '../../lib/utils';
import { EmptyState } from '../EmptyState';
import { AgentPickerPanel } from './AgentPickerPanel';
import { ChatComposer } from './ChatComposer';
import { ChatItemView, PlanCard } from './items';
import type { AgentPlanItem, ChatAgentSummary, ChatCommand, ChatCommandsSource, ChatSessionState } from '../../lib/chat-types';

/**
 * The Chat tab: one chip per attached agent, a scrolling item list, a pinned
 * plan while a turn runs, and the composer with `@agent` autocomplete.
 *
 * Two things drive the shape. Several agents can be in one chat, so the header
 * is a row of chips and every row carries its own author rather than inheriting
 * the tab's. And the working indicator is driven by Syntaur's own clock, not by
 * adapter activity — claude-agent-acp emits no thinking signal and is silent
 * for ~25 s at the inherited xhigh effort (RESULTS.md §09).
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
    participants,
    agents,
    attached,
    chips,
    loading,
    error,
    hasMore,
    working,
    authorOf,
    send,
    withdraw,
    cancel,
    setParticipants,
    answerPermission,
    answerQuestion,
    loadOlder,
  } = useAssignmentChat(assignmentId);

  const [pickerOpen, setPickerOpen] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const pinnedAtBottom = useRef(true);

  const plan = pinnedPlan(items) as AgentPlanItem | null;
  const activity = useMemo(() => groupByTurn(items), [items]);
  const column = useMemo(() => items.filter(isChatColumnItem), [items]);
  const activityOf = useCallback((turnId: string | null) => (turnId ? activity.get(turnId) : undefined), [
    activity,
  ]);
  const missing = attached.filter((agent) => agent.missing);

  const commandsByAgent = useMemo(() => {
    const map = new Map<string, { commands: ChatCommand[]; source: ChatCommandsSource | null }>();
    for (const [agentId, session] of sessions) {
      map.set(agentId, { commands: session.commands ?? [], source: session.commandsSource ?? null });
    }
    return map;
  }, [sessions]);

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
  }, [column]);

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

  // Where the agents run: the default agent's session, else any session that
  // has resolved a directory. Every agent in one chat resolves the same chain.
  const cwdSession =
    (participants?.defaultAgent ? sessions.get(participants.defaultAgent) : undefined) ??
    [...sessions.values()].find((s) => s.cwd);

  return (
    <div className="flex h-[calc(100vh-18rem)] min-h-[26rem] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {chips.map((agent) => (
          <AgentChip
            key={agent.id}
            agent={agent}
            detached={!attached.some((a) => a.id === agent.id)}
            isDefault={participants?.defaultAgent === agent.id}
            state={sessions.get(agent.id)?.state ?? 'none'}
            model={sessions.get(agent.id)?.model ?? null}
            queued={sessions.get(agent.id)?.queued.length ?? 0}
            workingMs={working.get(agent.id)?.elapsedMs ?? null}
            onCancel={() => void cancel(agent.id)}
          />
        ))}
        {chips.length === 0 && (
          <span className="text-xs text-muted-foreground">No agents attached</span>
        )}
        <span className="flex-1" />
        {working.size > 1 && (
          <button
            type="button"
            onClick={() => void cancel()}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
          >
            <Square className="h-3 w-3" />
            Interrupt all
          </button>
        )}
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
        >
          <Users className="h-3 w-3" />
          Manage agents
        </button>
      </div>
      {cwdSession?.cwd && (
        <div className="px-1 text-xs text-muted-foreground" data-testid="chat-cwd">
          Running in <code className="font-mono">{cwdSession.cwd}</code>
          {cwdSession.cwdTier ? ` (${cwdSession.cwdTier})` : ''}
          {cwdSession.cwdTier === 'home' &&
            ' — no worktree on this assignment; create one from the assignment header.'}
        </div>
      )}

      {missing.map((agent) => (
        <div
          key={agent.id}
          className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
        >
          {agent.name} needs {agent.harness}, which is not on PATH. Install it with{' '}
          <code className="font-mono">{agent.missing}</code>.
        </div>
      ))}
      {[...sessions.values()]
        .map((session) => staleNote(session))
        .filter((note): note is string => note !== null)
        .map((note) => (
          <div
            key={note}
            className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground"
          >
            {note}
          </div>
        ))}
      {[...sessions.values()]
        .filter((session) => session.error)
        .map((session) => (
          <div
            key={session.agentId}
            className="rounded-md border border-rose-500/40 bg-rose-500/5 px-3 py-2 text-xs text-rose-600 dark:text-rose-400"
          >
            @{session.agentId}: {session.error}
          </div>
        ))}
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
        {hasMore && column.length > 0 && (
          <button
            type="button"
            onClick={() => void loadOlder()}
            className="mx-auto block rounded px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            Load older messages
          </button>
        )}
        {column.length === 0 ? (
          <EmptyState
            title="No messages yet"
            description="Send a message to start an agent. It will run in the assignment's worktree, repository, or home directory. Mention an agent with @ to address it directly; anything unmentioned goes to the default agent."
          />
        ) : (
          column.map((item) => (
            <ChatItemView
              key={item.itemId}
              item={item}
              context={{
                authorOf,
                activityOf,
                onWithdraw: (messageId) => void withdraw(messageId),
                onAnswerPermission: (requestId, optionId, opts) =>
                  void answerPermission(requestId, optionId, opts),
                onAnswerQuestion: (requestId, answer) => void answerQuestion(requestId, answer),
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
        <ChatComposer
          agents={attached}
          defaultAgentId={participants?.defaultAgent ?? null}
          commandsByAgent={commandsByAgent}
          disabled={attached.length === 0}
          onSend={(text) => send(text)}
        />
      </div>

      <AgentPickerPanel
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        agents={agents}
        participants={participants}
        onSave={setParticipants}
      />
    </div>
  );
}

/** One agent's presence chip: who, what state, how long it has been working. */
function AgentChip({
  agent,
  detached,
  isDefault,
  state,
  model,
  queued,
  workingMs,
  onCancel,
}: {
  agent: ChatAgentSummary;
  /** Still finishing a turn after being detached — kept for its interrupt. */
  detached: boolean;
  isDefault: boolean;
  state: ChatSessionState;
  model: string | null;
  queued: number;
  workingMs: number | null;
  onCancel: () => void;
}) {
  return (
    <div
      className={cn(
        'group inline-flex items-center gap-1.5 rounded-md border bg-background px-1.5 py-1',
        detached ? 'border-amber-500/50 border-dashed' : 'border-border/60',
      )}
      title={`${agent.name} · ${agent.harness}${model ? ` · ${model}` : ''}`}
    >
      <span
        className={cn(
          'flex h-5 w-5 items-center justify-center rounded text-[10px] font-medium',
          agentColorClasses(agent.color),
        )}
        aria-hidden
      >
        {agent.avatar}
      </span>
      <span className="text-xs font-medium">{agent.name}</span>
      {detached ? (
        <span className="text-[10px] text-amber-600 dark:text-amber-400">detached</span>
      ) : (
        isDefault && <span className="text-[10px] text-muted-foreground">default</span>
      )}
      {workingMs === null ? (
        <span className={cn('rounded px-1.5 py-0.5 text-[10px]', STATE_TONES[state])}>
          {STATE_LABELS[state]}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-600 dark:text-sky-400">
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
          {formatDuration(workingMs)}
        </span>
      )}
      {queued > 0 && (
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          +{queued} queued
        </span>
      )}
      {workingMs !== null && (
        <button
          type="button"
          onClick={onCancel}
          aria-label={`Interrupt ${agent.name}`}
          className="hidden rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground group-hover:inline-flex"
        >
          <Square className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
