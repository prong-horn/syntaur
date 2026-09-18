import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useChatAgents } from '../hooks/useChatAgents';
import type { StageHandoffDescriptor } from '../hooks/useProjects';
import type { StageDispatchActions } from '../hooks/useStageDispatch';
import { cn } from '../lib/utils';

interface StageHandoffControlProps {
  ticketId: string;
  descriptor: StageHandoffDescriptor;
  dispatch: StageDispatchActions;
}

function agentLabel(id: string): string {
  return `@${id}`;
}

export function StageHandoffControl({ ticketId, descriptor, dispatch }: StageHandoffControlProps) {
  const { data: agentsData } = useChatAgents();
  const agents = agentsData?.agents ?? [];

  const terminalStage = !descriptor.canDispatch && descriptor.stage === 'done';
  if (terminalStage) return null;

  // Automatic hand-offs always go to the entry's recorded target (the server
  // rejects a different agentId), so the picker only appears for manual
  // requests: manual stages, and new attempts after a terminal receipt.
  const automatic = dispatch.handOffSource === 'automatic';
  const showPicker = !automatic;
  const targetId = automatic
    ? descriptor.recordedTargetId
    : dispatch.selectedAgentId ?? descriptor.defaultAgentId ?? null;
  const targetLabel = targetId ? agentLabel(targetId) : automatic ? 'recorded agent' : null;
  const receipt = dispatch.receipt;
  const state = dispatch.clientState;
  const isActive = state === 'queued' || state === 'running' || state === 'unknown';

  const canHandOff = descriptor.canDispatch && !isActive && Boolean(targetLabel);

  // New-id attempts follow the server gate; same-id unknown lookup is always safe.
  const canRetryCompleted = descriptor.canDispatch && state === 'completed';
  const canRetryFailed = Boolean(
    receipt &&
      (receipt.state === 'failed' ||
        receipt.state === 'cancelled' ||
        receipt.state === 'interrupted' ||
        receipt.state === 'superseded'),
  );
  const canRetryFailedAction = descriptor.canDispatch && !isActive && canRetryFailed;
  const canRetryUnknown = state === 'unknown';

  const handOffDisabled =
    dispatch.busy ||
    !canHandOff ||
    Boolean(dispatch.disabledReason && !canRetryFailed);

  const handOffTitle =
    dispatch.disabledReason ??
    (targetLabel ? `Hand to ${targetLabel}` : 'Select an agent to hand off work');

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-2 py-1.5 text-xs">
      {showPicker ? (
        <label className="flex items-center gap-1.5 text-muted-foreground">
          <span className="sr-only">Handoff agent</span>
          <select
            className="max-w-[10rem] rounded border border-border bg-background px-1.5 py-0.5 text-xs text-foreground"
            value={dispatch.selectedAgentId ?? descriptor.defaultAgentId ?? ''}
            onChange={(e) => dispatch.setSelectedAgentId(e.target.value || null)}
            disabled={dispatch.busy || isActive}
          >
            <option value="">Select agent…</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id} disabled={agent.respondsTo === 'none'}>
                @{agent.id}
                {agent.respondsTo === 'none' ? ' (disabled)' : ''}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {isActive ? (
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          {dispatch.busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          Handoff {state}
          {receipt?.agentId ? ` → ${agentLabel(receipt.agentId)}` : ''}
        </span>
      ) : state === 'completed' ? (
        <span className="text-muted-foreground">
          Turn completed{receipt?.agentId ? ` (${agentLabel(receipt.agentId)})` : ''} — ticket not done
        </span>
      ) : receipt && canRetryFailed && !isActive ? (
        <span className="text-warning-foreground">{receipt.state}: {receipt.error ?? 'handoff failed'}</span>
      ) : descriptor.manualFallback ? (
        <span className="text-warning-foreground">Unrecorded stage entry — manual handoff only</span>
      ) : null}

      {dispatch.staleMessage ? (
        <span className="text-warning-foreground">{dispatch.staleMessage}</span>
      ) : null}

      {dispatch.errorMessage ? (
        <span role="alert" className="text-warning-foreground">{dispatch.errorMessage}</span>
      ) : null}

      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        <Link
          to={`/t/${ticketId}?tab=chat`}
          className="rounded border border-border px-2 py-0.5 text-muted-foreground hover:text-foreground"
        >
          View chat
        </Link>

        {isActive ? (
          <button
            type="button"
            className="rounded border border-border px-2 py-0.5 text-muted-foreground hover:text-foreground disabled:opacity-50"
            disabled={dispatch.busy}
            onClick={() => void dispatch.cancel()}
          >
            Cancel
          </button>
        ) : null}

        {canHandOff ? (
          <button
            type="button"
            className={cn(
              'shell-action px-2 py-0.5 text-xs disabled:cursor-not-allowed disabled:opacity-50',
            )}
            disabled={handOffDisabled}
            title={handOffTitle}
            onClick={() => void dispatch.handOff()}
          >
            {dispatch.busy ? 'Sending…' : targetLabel ? `Hand to ${targetLabel}` : 'Hand to…'}
          </button>
        ) : null}

        {canRetryCompleted || canRetryFailedAction || canRetryUnknown ? (
          <button
            type="button"
            className="rounded border border-border px-2 py-0.5 text-muted-foreground hover:text-foreground disabled:opacity-50"
            disabled={dispatch.busy || (canRetryUnknown && !dispatch.activeRequestId)}
            title={canRetryUnknown ? 'Retry with the same request id' : 'Start a new handoff'}
            onClick={() => void dispatch.retry()}
          >
            {canRetryUnknown ? 'Retry lookup' : 'Hand to again'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
