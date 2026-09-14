import { useEffect, useState } from 'react';
import { StatusPillPicker } from './StatusPillPicker';
import { TicketTransitionDialog } from './TicketTransitionDialog';
import { Toaster, useToast } from './Toast';
import { useStatusConfig, getStatusLabel } from '../hooks/useStatusConfig';
import { runTicketVerb, verbNeedsReason } from '../lib/tickets';
import type { TicketTransitionAction, TicketDetail } from '../hooks/useProjects';

interface TicketStatusPillProps {
  id?: string;
  slug?: string;
  projectSlug?: string | null;
  status: string;
  title?: string;
  availableVerbs?: TicketTransitionAction[];
  progress?: { checked: number; total: number };
  onChange?: (updated: TicketDetail) => void;
  disabled?: boolean;
  className?: string;
  onSelectAction?: (action: TicketTransitionAction) => void;
}

export function TicketStatusPill({
  id,
  slug,
  projectSlug: _projectSlug,
  status,
  title,
  availableVerbs,
  progress,
  onChange,
  disabled,
  className,
  onSelectAction,
}: TicketStatusPillProps) {
  const config = useStatusConfig();
  const { toast, showToast, dismissToast } = useToast();

  const [displayStatus, setDisplayStatus] = useState(status);
  useEffect(() => {
    setDisplayStatus(status);
  }, [status]);

  const [availableVerbsState, setAvailableTransitionsState] = useState<
    TicketTransitionAction[]
  >(availableVerbs ?? []);
  useEffect(() => {
    setAvailableTransitionsState(availableVerbs ?? []);
  }, [availableVerbs]);

  const [transitioning, setTransitioning] = useState(false);
  const [pending, setPending] = useState<TicketTransitionAction | null>(null);

  const delegated = Boolean(onSelectAction);

  function ensureIdentifiers(): boolean {
    if (!id) {
      showToast('Cannot update status: ticket id is missing.', 'error');
      return false;
    }
    return true;
  }

  async function runMutation(
    targetStatus: string,
    perform: () => Promise<TicketDetail>,
  ): Promise<boolean> {
    const previous = { status: displayStatus, transitions: availableVerbsState };

    setDisplayStatus(targetStatus);
    setTransitioning(true);

    try {
      const updated = await perform();
      setDisplayStatus(updated.status);
      setAvailableTransitionsState(updated.availableVerbs);
      onChange?.(updated);
      showToast(`Moved to ${getStatusLabel(config, updated.status)}`, 'success');
      return true;
    } catch (mutationError) {
      setDisplayStatus(previous.status);
      setAvailableTransitionsState(previous.transitions);
      showToast((mutationError as Error).message, 'error');
      return false;
    } finally {
      setTransitioning(false);
    }
  }

  function runVerb(action: TicketTransitionAction, reason?: string): Promise<boolean> {
    return runMutation(action.targetStatus, () =>
      runTicketVerb(id as string, action.command, reason),
    );
  }

  function handleSelect(action: TicketTransitionAction) {
    if (action.disabled) {
      showToast(
        action.disabledReason || `Cannot run ${action.label}.`,
        'error',
      );
      return;
    }
    if (!ensureIdentifiers()) return;

    if (verbNeedsReason(action.command) || action.requiresReason) {
      setPending(action);
      return;
    }
    void runVerb(action);
  }

  const pickerOnSelect = onSelectAction ?? handleSelect;

  return (
    <>
      <StatusPillPicker
        currentStatus={displayStatus}
        availableVerbs={availableVerbsState}
        onSelect={pickerOnSelect}
        progress={progress}
        disabled={disabled || transitioning}
        className={className}
      />

      {!delegated ? (
        <>
          <TicketTransitionDialog
            open={pending !== null}
            action={pending}
            ticketTitle={title ?? slug ?? displayStatus}
            loading={transitioning}
            onConfirm={async (reason) => {
              if (!pending) return;
              const action = pending;
              const succeeded = await runVerb(action, reason);
              if (succeeded) {
                setPending(null);
              }
            }}
            onOpenChange={(open) => {
              if (!open) {
                setPending(null);
              }
            }}
          />
          <Toaster toast={toast} onDismiss={dismissToast} />
        </>
      ) : null}
    </>
  );
}
