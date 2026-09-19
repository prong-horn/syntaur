import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import { Activity, ChevronDown, ChevronRight, CheckSquare, Square } from 'lucide-react';
import { CopyButton } from '../CopyButton';
import { SessionActionButtons } from '../SessionActionButtons';
import { cn } from '../../lib/utils';
import { formatCost, formatDateTime, formatTokens, toTitleCase } from '../../lib/format';
import type { AgentSessionWithLiveness } from '../../types';

export const SESSION_TABLE_COLUMN_COUNT = 12;

export function isEffectivelyPinned(s: { pinnedAt?: string | null }): boolean {
  return Boolean(s.pinnedAt);
}

export interface SessionRowProps {
  session: AgentSessionWithLiveness;
  selected: boolean;
  expanded: boolean;
  onToggle: () => void;
  onToggleExpand: () => void;
  onDelete: () => void;
  onMarkStopped: (sessionId: string) => void;
  onTogglePin: (sessionId: string, pinned: boolean) => void;
  onToggleArchive: (sessionId: string, archived: boolean) => void;
  onRename: (sessionId: string) => void;
  /** When set, session id links open the drawer instead of navigating away. */
  onOpenDetail?: (sessionId: string) => void;
}

export function SessionRow({
  session,
  selected,
  expanded,
  onToggle,
  onToggleExpand,
  onDelete,
  onMarkStopped,
  onTogglePin,
  onToggleArchive,
  onRename,
  onOpenDetail,
}: SessionRowProps) {
  const shortId = session.sessionId.length > 12 ? `${session.sessionId.slice(0, 8)}...` : session.sessionId;
  const shortPath = session.path ? session.path.replace(/^\/Users\/[^/]+/, '~') : '\u2014';
  const shortTranscript = session.transcriptPath
    ? session.transcriptPath.replace(/^\/Users\/[^/]+/, '~')
    : '\u2014';
  const modelBreakdown = session.usage?.models.length
    ? session.usage.models
        .map((m) => `${m.model}: ${formatCost(m.cost)} \u00b7 ${formatTokens(m.tokens)} tokens`)
        .join('\n')
    : undefined;
  const canExpand = Boolean(session.summary) || Boolean(session.usage?.models.length);
  const isAuto = session.descriptionSource === 'auto';

  return (
    <Fragment>
      <tr
        className={cn(
          'border-b border-border/20 last:border-0',
          isEffectivelyPinned(session) && 'border-l-2 border-l-primary bg-accent/20',
          session.archivedAt && 'opacity-60',
        )}
      >
        <td className="py-2 pr-3">
          <button
            type="button"
            onClick={onToggle}
            className="text-muted-foreground hover:text-foreground disabled:opacity-30"
            disabled={session.usageOnly}
            title={session.usageOnly ? 'Usage-only rows cannot be selected' : undefined}
          >
            {selected ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
          </button>
        </td>
        <td className="py-2 pr-3">
          {session.projectSlug ? (
            <Link
              to={`/board?project=${encodeURIComponent(session.projectSlug)}`}
              className="block truncate text-primary hover:underline"
              title={toTitleCase(session.projectSlug)}
            >
              {toTitleCase(session.projectSlug)}
            </Link>
          ) : session.ticketSlug ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide text-muted-foreground">
              Standalone
            </span>
          ) : (
            <span className="text-muted-foreground">&mdash;</span>
          )}
        </td>
        <td className="py-2 pr-3">
          {session.ticketId ? (
            <Link
              to={`/t/${session.ticketId}`}
              className="block truncate text-primary hover:underline"
              title={session.ticketSlug ? toTitleCase(session.ticketSlug) : session.ticketId}
            >
              {session.ticketSlug ? toTitleCase(session.ticketSlug) : session.ticketId}
            </Link>
          ) : (
            <span className="text-muted-foreground">&mdash;</span>
          )}
        </td>
        <td className="py-2 pr-3">
          {session.description ? (
            <div
              className="flex items-center gap-1 truncate text-xs text-muted-foreground"
              title={session.summary ? `${session.description}\n\n${session.summary}` : session.description}
            >
              {isAuto ? (
                <span
                  className="shrink-0 rounded bg-primary/10 px-1 text-[9px] font-medium uppercase text-primary"
                  title="Auto-generated from the session transcript"
                >
                  auto
                </span>
              ) : null}
              <span className="truncate">{session.description}</span>
            </div>
          ) : (
            <span className="text-muted-foreground">&mdash;</span>
          )}
        </td>
        <td className="py-2 pr-3">
          <span className="flex min-w-0 items-center gap-1.5">
            <Activity className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="block min-w-0 truncate">{session.agent}</span>
            {session.usageOnly ? (
              <span
                className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] font-mono uppercase tracking-wide text-muted-foreground"
                title="Spend recorded by the usage collector for a session Syntaur never tracked — no transcript or actions available."
              >
                Usage only
              </span>
            ) : null}
          </span>
        </td>
        <td className="py-2 pr-3 text-right text-xs tabular-nums" title={modelBreakdown}>
          {session.usage ? formatCost(session.usage.totalCost) : <span className="text-muted-foreground">&mdash;</span>}
        </td>
        <td className="py-2 pr-3 text-right text-xs tabular-nums text-muted-foreground" title={modelBreakdown}>
          {session.usage ? formatTokens(session.usage.totalTokens) : <span>&mdash;</span>}
        </td>
        <td className="hidden py-2 pr-3 lg:table-cell">
          <span className="flex min-w-0 items-center gap-1.5">
            {session.usageOnly ? (
              <span className="block min-w-0 truncate font-mono text-xs text-muted-foreground" title={session.sessionId}>
                {shortId}
              </span>
            ) : onOpenDetail ? (
              <button
                type="button"
                onClick={() => onOpenDetail(session.sessionId)}
                className="block min-w-0 truncate font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
                title={session.sessionId}
              >
                {shortId}
              </button>
            ) : (
              <Link
                to={`/sessions?session=${encodeURIComponent(session.sessionId)}`}
                className="block min-w-0 truncate font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
                title={session.sessionId}
              >
                {shortId}
              </Link>
            )}
            <CopyButton value={session.sessionId} />
          </span>
        </td>
        <td className="py-2 pr-3 text-xs text-muted-foreground">
          <span className="block truncate">{formatDateTime(session.started)}</span>
        </td>
        <td className="hidden py-2 pr-3 lg:table-cell">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="block min-w-0 truncate text-xs text-muted-foreground" title={session.path}>
              {shortPath}
            </span>
            {session.path ? <CopyButton value={session.path} /> : null}
          </span>
        </td>
        <td className="hidden py-2 pr-3 lg:table-cell">
          {session.transcriptPath ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className="block min-w-0 truncate font-mono text-xs text-muted-foreground"
                title={session.transcriptPath}
              >
                {shortTranscript}
              </span>
              <CopyButton value={session.transcriptPath} />
            </span>
          ) : (
            <span className="text-muted-foreground">&mdash;</span>
          )}
        </td>
        <td
          className={cn(
            'table-sticky-actions py-2 pl-2',
            isEffectivelyPinned(session) && 'table-sticky-actions--pinned',
          )}
        >
          <div className="flex items-center gap-1.5">
            {canExpand ? (
              <button
                type="button"
                onClick={onToggleExpand}
                className="text-muted-foreground hover:text-foreground"
                title={expanded ? 'Hide summary' : 'Show summary'}
                aria-expanded={expanded}
              >
                {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
            ) : null}
            {!session.usageOnly ? (
              <SessionActionButtons
                session={session}
                layout="compact"
                onMarkStopped={onMarkStopped}
                onTogglePin={onTogglePin}
                onToggleArchive={onToggleArchive}
                onRename={onRename}
                onDelete={onDelete}
              />
            ) : null}
            {session.usageOnly && !canExpand ? <span className="text-muted-foreground">&mdash;</span> : null}
          </div>
        </td>
      </tr>
      {expanded && canExpand ? (
        <tr className="border-b border-border/20 bg-muted/20">
          <td colSpan={SESSION_TABLE_COLUMN_COUNT} className="px-8 py-3">
            <div className="flex flex-col gap-3 text-xs">
              {session.summary ? (
                <div>
                  <div className="mb-1 font-medium uppercase tracking-wide text-muted-foreground">Summary</div>
                  <p className="max-w-3xl text-foreground/90">{session.summary}</p>
                </div>
              ) : null}
              {session.usage?.models.length ? (
                <div>
                  <div className="mb-1 font-medium uppercase tracking-wide text-muted-foreground">Spend by model</div>
                  <table className="text-xs">
                    <tbody>
                      {session.usage.models.map((m) => (
                        <tr key={m.model}>
                          <td className="pr-4 font-mono text-muted-foreground">{m.model}</td>
                          <td className="pr-4 text-right tabular-nums">{formatCost(m.cost)}</td>
                          <td className="text-right tabular-nums text-muted-foreground">
                            {formatTokens(m.tokens)} tokens
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}
