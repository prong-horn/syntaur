import { Terminal, GitFork, Square } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { cn } from '../lib/utils';
import type { AgentSessionWithLiveness } from '../types';

interface SessionActionButtonsProps {
  session: AgentSessionWithLiveness;
  /**
   * Invoked when the user clicks Mark-stopped. The callback should PATCH
   * `/api/agent-sessions/<sessionId>` with `{ status: 'stopped' }` and
   * rely on the websocket `agent-sessions-updated` event to refresh the
   * row — no local optimistic state.
   */
  onMarkStopped: (sessionId: string) => void;
}

/**
 * Per-row action group rendered on the standalone `/sessions` page and on
 * embedded `AgentSessionsSection` lists under assignment detail pages.
 *
 * Three affordances per the Design Summary in assignment.md:
 *
 *   | Icon            | Hidden when           | Disabled when     | Action |
 *   |-----------------|-----------------------|-------------------|--------|
 *   | Terminal (R)    | !resumeSupported      | isLive === true   | open?session=<id>&mode=resume |
 *   | GitFork (F)     | !forkSupported        | never             | open?session=<id>&mode=fork |
 *   | Square (Stop)   | status !== 'active'   | never             | PATCH /api/agent-sessions/<id> |
 *
 * Resume's disabled state exists to prevent two processes from interleaving
 * writes into the same transcript file — the server reports `isLive: true`
 * when the original process may still be running, and the tooltip points
 * the user at Fork instead.
 */
export function SessionActionButtons({ session, onMarkStopped }: SessionActionButtonsProps) {
  const resumeUrl = `syntaur://open?session=${encodeURIComponent(session.sessionId)}&mode=resume`;
  const forkUrl = `syntaur://open?session=${encodeURIComponent(session.sessionId)}&mode=fork`;

  const iconClass = 'size-3.5';
  const btnClass = cn(
    'shell-action',
    'inline-flex items-center justify-center px-2 py-1 text-xs',
    'disabled:cursor-not-allowed disabled:opacity-50',
  );

  return (
    <TooltipProvider delayDuration={200}>
      <div className="inline-flex items-center gap-1">
        {session.resumeSupported && (
          session.isLive ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  disabled
                  aria-disabled
                  className={btnClass}
                >
                  <Terminal className={iconClass} />
                  <span>Resume</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                Session appears active — fork instead to avoid transcript corruption
              </TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <a href={resumeUrl} className={btnClass}>
                  <Terminal className={iconClass} />
                  <span>Resume</span>
                </a>
              </TooltipTrigger>
              <TooltipContent side="top">
                Continue this session in its agent (same session id, same transcript)
              </TooltipContent>
            </Tooltip>
          )
        )}

        {session.forkSupported && (
          <Tooltip>
            <TooltipTrigger asChild>
              <a href={forkUrl} className={btnClass}>
                <GitFork className={iconClass} />
                <span>Fork</span>
              </a>
            </TooltipTrigger>
            <TooltipContent side="top">
              Branch a new session from this point — safe even when the original is still running
            </TooltipContent>
          </Tooltip>
        )}

        {session.status === 'active' && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={btnClass}
                onClick={() => onMarkStopped(session.sessionId)}
              >
                <Square className={iconClass} />
                <span>Mark stopped</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              Tell the dashboard this session has ended so Resume re-enables
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </TooltipProvider>
  );
}
