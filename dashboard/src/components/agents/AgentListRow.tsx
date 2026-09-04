import { Pencil, Play, Trash2 } from 'lucide-react';
import { agentBadges, BUILTIN_DELETE_TITLE } from '../../lib/agent-editor';
import { agentColorClasses } from '../../lib/chat-format';
import { cn } from '../../lib/utils';
import type { AgentTestResult, ChatAgentSummary } from '../../lib/chat-types';
import { AgentTestResultLine } from './AgentTestResultLine';

export interface AgentListRowProps {
  agent: ChatAgentSummary;
  testResult: AgentTestResult | 'loading' | null;
  onEdit: () => void;
  onTest: () => void;
  onDelete: () => void;
}

export function AgentListRow({
  agent,
  testResult,
  onEdit,
  onTest,
  onDelete,
}: AgentListRowProps) {
  const badges = agentBadges(agent);
  const deleteDisabled = agent.builtin && !agent.overridesBuiltin;
  const deleteTitle = deleteDisabled
    ? `\`${agent.id}\` ${BUILTIN_DELETE_TITLE}`
    : undefined;

  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded text-xs font-medium',
                agentColorClasses(agent.color),
              )}
              aria-hidden
            >
              {agent.avatar}
            </span>
            <span className="font-medium">{agent.name}</span>
            <span className="font-mono text-xs text-muted-foreground">@{agent.id}</span>
            {badges.map((badge) => (
              <span
                key={badge}
                className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                {badge}
              </span>
            ))}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {agent.harness}
            {agent.missing ? (
              <span className="text-amber-600 dark:text-amber-400">
                {' '}
                — not on PATH; install with <code className="font-mono">{agent.missing}</code>
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {[
              agent.model ?? 'inherited model',
              agent.mode ?? 'inherited mode',
              agent.effort ?? 'inherited effort',
              `responds to ${agent.respondsTo}`,
            ].join(' · ')}
          </div>
          {agent.description ? (
            <p className="mt-1 text-xs text-muted-foreground">{agent.description}</p>
          ) : null}
          <AgentTestResultLine testResult={testResult} className="mt-2" />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-muted"
          >
            <Pencil className="h-3 w-3" />
            Edit
          </button>
          <button
            type="button"
            onClick={onTest}
            disabled={testResult === 'loading'}
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
          >
            <Play className="h-3 w-3" />
            Test
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={deleteDisabled}
            title={deleteTitle}
            className="inline-flex items-center gap-1 rounded border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 className="h-3 w-3" />
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
