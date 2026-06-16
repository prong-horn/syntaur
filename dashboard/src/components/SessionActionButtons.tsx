import { Terminal, GitFork, Square } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { cn } from '../lib/utils';
import { useRecreateFlow } from './useRecreateFlow';
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
 * Resume/Fork are preflight-gated through {@link useRecreateFlow}: a missing
 * worktree raises the recreate popup (instead of a dead `cd` in the terminal),
 * and the clicked `mode` is preserved through recreate so a fork never silently
 * degrades into a resume.
 *
 * Resume's disabled state exists to prevent two processes from interleaving
 * writes into the same transcript file — the server reports `isLive: true`
 * when the original process may still be running, and the tooltip points
 * the user at Fork instead.
 *
 * Fallback: when neither resume nor fork is supported, we render a disabled
 * "Reopen" affordance + reason tooltip rather than collapsing the row to
 * id + status, so the box always explains why reopen isn't available. This
 * applies both to a custom agent whose config defines no resume/fork, and to
 * the builtin launch-only agents (openclaw/hermes) that ship without a recipe
 * (claude/codex/pi do carry recipes and inherit them via getAgents).
 *
 *   | Terminal (Reopen) | never (only when neither R nor F) | always | (none) |
 */
export function SessionActionButtons({ session, onMarkStopped }: SessionActionButtonsProps) {
  const flow = useRecreateFlow();
  const sessionTarget = { kind: 'session' as const, id: session.sessionId };

  const iconClass = 'size-3.5';
  const btnClass = cn(
    'shell-action',
    'inline-flex items-center justify-center px-2 py-1 text-xs',
    'disabled:cursor-not-allowed disabled:opacity-50',
  );
  // Disabled <button> elements don't emit hover/focus events reliably across
  // browsers, so a tooltip attached directly to one won't show and isn't
  // keyboard reachable. Wrap disabled buttons in a focusable span and use that
  // as the TooltipTrigger (same pattern as OverflowMenu / ContextMenuPopover).
  const disabledTriggerClass = 'inline-flex outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm';

  const reopenUnavailable = !session.resumeSupported && !session.forkSupported;

  return (
    <>
      <TooltipProvider delayDuration={200}>
        <div className="inline-flex items-center gap-1">
          {reopenUnavailable && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0} className={disabledTriggerClass}>
                  <button
                    type="button"
                    disabled
                    aria-disabled
                    className={btnClass}
                  >
                    <Terminal className={iconClass} />
                    <span>Reopen</span>
                  </button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                Reopen unavailable — this agent has no resume/fork command configured
              </TooltipContent>
            </Tooltip>
          )}

          {session.resumeSupported && (
            session.isLive ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0} className={disabledTriggerClass}>
                    <button
                      type="button"
                      disabled
                      aria-disabled
                      className={btnClass}
                    >
                      <Terminal className={iconClass} />
                      <span>Resume</span>
                    </button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  Session appears active — fork instead to avoid transcript corruption
                </TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={btnClass}
                    disabled={flow.pending}
                    onClick={() => void flow.open(sessionTarget, 'resume')}
                  >
                    <Terminal className={iconClass} />
                    <span>Resume</span>
                  </button>
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
                <button
                  type="button"
                  className={btnClass}
                  disabled={flow.pending}
                  onClick={() => void flow.open(sessionTarget, 'fork')}
                >
                  <GitFork className={iconClass} />
                  <span>Fork</span>
                </button>
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
                  disabled={flow.pending}
                  onClick={() => onMarkStopped(session.sessionId)}
                >
                  <Square className={iconClass} />
                  <span>Mark stopped</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {session.resumeSupported
                  ? 'Tell the dashboard this session has ended so Resume re-enables'
                  : 'Tell the dashboard this session has ended'}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </TooltipProvider>
      {flow.dialogs}
    </>
  );
}
