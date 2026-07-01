import { useEffect, useState } from 'react';
import { StatusPillPicker } from './StatusPillPicker';
import { AssignmentTransitionDialog } from './AssignmentTransitionDialog';
import { Toaster, useToast } from './Toast';
import { useStatusConfig, getStatusLabel } from '../hooks/useStatusConfig';
import { overrideTargetsForStatus, isTerminalStatus } from '../lib/statusMeta';
import {
  runAssignmentTransition,
  runAssignmentTransitionById,
  overrideAssignmentStatus,
  overrideAssignmentStatusById,
  transitionNeedsReason,
} from '../lib/assignments';
import type { AssignmentTransitionAction, AssignmentDetail } from '../hooks/useProjects';

interface AssignmentStatusPillProps {
  id?: string;
  slug?: string;
  projectSlug?: string | null;
  status: string;
  title?: string;
  availableTransitions?: AssignmentTransitionAction[];
  progress?: { checked: number; total: number };
  onChange?: (updated: AssignmentDetail) => void;
  disabled?: boolean;
  className?: string;
  // Delegated mode (board): when BOTH are provided, the component forwards
  // selections instead of mutating.
  onSelectAction?: (action: AssignmentTransitionAction) => void;
  onSelectOverride?: (statusId: string) => void;
}

/**
 * Self-contained interactive status pill. Drops in anywhere a read-only
 * `StatusBadge` renders a mutable assignment status. It owns its own override
 * targets, routes the correct API call (by-id vs by-slug), does an optimistic
 * update + rollback, surfaces toasts, and pops the reason dialog when a
 * transition requires one.
 *
 * A "delegated" mode (both `onSelectAction` and `onSelectOverride` provided)
 * lets a parent — e.g. the board — keep its own mutation logic; the component
 * then only forwards the picker's selections and does NOT mutate, toast,
 * optimistic-update, or render a dialog.
 *
 * This is a refactor of the board's `applyMove`/`handleMove`/`handleOverride`
 * (`AssignmentsPage.tsx`) into a reusable component.
 */
export function AssignmentStatusPill({
  id,
  slug,
  projectSlug,
  status,
  title,
  availableTransitions,
  progress,
  onChange,
  disabled,
  className,
  onSelectAction,
  onSelectOverride,
}: AssignmentStatusPillProps) {
  const config = useStatusConfig();
  const { toast, showToast, dismissToast } = useToast();

  // Prop-derived state: seed from props and re-sync when the prop changes, so an
  // external truth update (parent re-render) re-seeds the optimistic view. Same
  // synchronizing-effect pattern used elsewhere (e.g. AssignmentTransitionDialog).
  const [displayStatus, setDisplayStatus] = useState(status);
  useEffect(() => {
    setDisplayStatus(status);
  }, [status]);

  const [availableTransitionsState, setAvailableTransitionsState] = useState<
    AssignmentTransitionAction[]
  >(availableTransitions ?? []);
  useEffect(() => {
    setAvailableTransitionsState(availableTransitions ?? []);
  }, [availableTransitions]);

  const [transitioning, setTransitioning] = useState(false);
  // The action awaiting a reason. Non-null ⇒ the reason dialog is open.
  const [pending, setPending] = useState<AssignmentTransitionAction | null>(null);

  // Delegated only when BOTH delegates are provided (mixed mode is not supported).
  const delegated = Boolean(onSelectAction && onSelectOverride);

  // Override targets are ALWAYS derived internally from the live config + the
  // current (optimistic) status + transitions — in both modes.
  const overrideTargets = overrideTargetsForStatus(config, displayStatus, availableTransitionsState);

  /**
   * Guard the identifiers a POST needs before any mutation. Routing is by-id when
   * `projectSlug == null` (needs `id`), else by-slug (needs `slug`).
   */
  function ensureIdentifiers(): boolean {
    if (projectSlug == null && !id) {
      showToast('Cannot update status: assignment id is missing.', 'error');
      return false;
    }
    if (projectSlug != null && !slug) {
      showToast('Cannot update status: assignment slug is missing.', 'error');
      return false;
    }
    return true;
  }

  /**
   * Shared optimistic-update + rollback. Sets the target status (and clears the
   * busy flag) around `perform()`. On success, adopts the server's status +
   * transitions, notifies `onChange`, and toasts. On error, restores the captured
   * previous status + transitions and toasts the message. Returns success so the
   * reason dialog can decide whether to close. Mirrors the board's `applyMove`.
   */
  async function runMutation(
    targetStatus: string,
    perform: () => Promise<AssignmentDetail>,
  ): Promise<boolean> {
    const previous = { status: displayStatus, transitions: availableTransitionsState };

    setDisplayStatus(targetStatus);
    setTransitioning(true);

    try {
      const updated = await perform();
      setDisplayStatus(updated.status);
      setAvailableTransitionsState(updated.availableTransitions);
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

  function runTransition(action: AssignmentTransitionAction, reason?: string): Promise<boolean> {
    return runMutation(action.targetStatus, () =>
      projectSlug == null
        ? // by-id route — `ensureIdentifiers` guarantees `id` here.
          runAssignmentTransitionById(id as string, action, reason)
        : // by-slug route — `ensureIdentifiers` guarantees `slug` here.
          runAssignmentTransition(projectSlug, slug as string, action, reason),
    );
  }

  function runOverride(statusId: string): Promise<boolean> {
    return runMutation(statusId, () =>
      projectSlug == null
        ? overrideAssignmentStatusById(id as string, statusId)
        : overrideAssignmentStatus(projectSlug, slug as string, statusId),
    );
  }

  function handleSelect(action: AssignmentTransitionAction) {
    // 1. Disabled actions never POST — the picker calls onSelect directly without
    //    disabling transition buttons, so this guard is the only thing keeping a
    //    disabled action safe (mirrors handleMove's guard).
    if (action.disabled) {
      showToast(
        action.disabledReason || `Cannot move to ${getStatusLabel(config, action.targetStatus)}.`,
        'error',
      );
      return;
    }
    if (!ensureIdentifiers()) return;

    // 2. Reason-required transitions defer to the dialog; the mutation begins on
    //    confirm. Otherwise the optimistic transition begins immediately.
    if (transitionNeedsReason(action)) {
      setPending(action);
      return;
    }
    void runTransition(action);
  }

  function handleOverride(statusId: string) {
    // Prefer a live transition to this status when one exists (e.g. terminal
    // targets must go through their complete/fail transition); route it through
    // the same reason check + transition path.
    const action = availableTransitionsState.find(
      (a) => a.targetStatus === statusId && !a.disabled,
    );
    if (action) {
      handleSelect(action);
      return;
    }

    // No transition. Terminal statuses cannot be reached via the override endpoint
    // (it 400s) — tell the user to use the transition instead. No POST.
    const targetDef = config.statuses.find((s) => s.id === statusId);
    if (isTerminalStatus(targetDef ?? { id: statusId })) {
      showToast(
        `Reach “${getStatusLabel(config, statusId)}” through its complete/fail transition.`,
        'error',
      );
      return;
    }

    if (!ensureIdentifiers()) return;
    void runOverride(statusId);
  }

  // In delegated mode the parent owns mutation; forward selections verbatim.
  const pickerOnSelect = onSelectAction && onSelectOverride ? onSelectAction : handleSelect;
  const pickerOnOverride = onSelectAction && onSelectOverride ? onSelectOverride : handleOverride;

  return (
    <>
      <StatusPillPicker
        currentStatus={displayStatus}
        availableTransitions={availableTransitionsState}
        onSelect={pickerOnSelect}
        overrideTargets={overrideTargets}
        onOverride={pickerOnOverride}
        progress={progress}
        disabled={disabled || transitioning}
        className={className}
      />

      {/* Self-contained mode owns its reason dialog + toaster (useToast is local
          state, so a Toaster must be rendered here for toasts to appear). In
          delegated mode the parent owns all of that. */}
      {!delegated ? (
        <>
          <AssignmentTransitionDialog
            open={pending !== null}
            action={pending}
            assignmentTitle={title ?? slug ?? displayStatus}
            loading={transitioning}
            onConfirm={async (reason) => {
              if (!pending) return;
              const action = pending;
              const succeeded = await runTransition(action, reason);
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
