import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import type { AffectedResponse, StatusResolution } from '../hooks/useStatusConfig';
import type { StatusRuleReference } from './settings-page-helpers';

interface StatusDeleteModalProps {
  open: boolean;
  affected: AffectedResponse & { label: string };
  /**
   * Remap target candidates — caller MUST pre-filter to oldIds ∩ newIds
   * minus the row being dropped. Server enforces the same; the modal
   * pre-filters so the user never sees an option that would 400.
   */
  remaining: Array<{ id: string; label: string }>;
  /** Derive/transition rules referencing this status (cross-section integrity). */
  ruleReferences: StatusRuleReference[];
  /** Whether headline.parked/blocked references this id (needs a remap pick even on delete). */
  headlineReferences: boolean;
  /**
   * Resolve. `deriveRemapTarget` is the status to rewrite derive/transition
   * references to: the remap target in remap mode, or the chosen headline
   * target in delete mode (empty string when headline isn't referenced).
   */
  onResolve: (resolution: StatusResolution, deriveRemapTarget: string) => void;
  onCancel: () => void;
}

type Mode = 'remap' | 'delete';

export function StatusDeleteModal({
  open,
  affected,
  remaining,
  ruleReferences,
  headlineReferences,
  onResolve,
  onCancel,
}: StatusDeleteModalProps) {
  const [mode, setMode] = useState<Mode>(remaining.length > 0 ? 'remap' : 'delete');
  const [target, setTarget] = useState<string>(remaining[0]?.id ?? '');
  const [headlineTarget, setHeadlineTarget] = useState<string>(remaining[0]?.id ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const hasAssignments = affected.count > 0;

  useEffect(() => {
    if (open) {
      setMode(remaining.length > 0 ? 'remap' : 'delete');
      setTarget(remaining[0]?.id ?? '');
      setHeadlineTarget(remaining[0]?.id ?? '');
      setConfirmDelete(false);
    }
  }, [open, remaining]);

  const headlineRemapOk = !headlineReferences || (headlineTarget !== '' && headlineTarget !== affected.id);

  const canConfirm =
    (mode === 'remap' && remaining.length > 0 && target !== '' && target !== affected.id) ||
    (mode === 'delete' && (!hasAssignments || confirmDelete) && headlineRemapOk);

  function handleConfirm() {
    if (!canConfirm) return;
    if (mode === 'remap') {
      onResolve({ id: affected.id, mode: 'remap', target }, target);
    } else {
      onResolve({ id: affected.id, mode: 'delete' }, headlineReferences ? headlineTarget : '');
    }
  }

  const visibleSample = affected.assignments.slice(0, 10);
  const remaining_extra = affected.count - visibleSample.length;

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => (!nextOpen ? onCancel() : undefined)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            Delete status "{affected.label}"
            {hasAssignments
              ? ` — ${affected.count} assignment${affected.count === 1 ? '' : 's'} reference it`
              : ''}
          </DialogTitle>
          <DialogDescription>
            {hasAssignments
              ? 'Choose how to resolve the affected assignments before this status is removed from the workflow.'
              : 'No assignments use this status, but workflow rules reference it. Choose how to resolve them.'}
          </DialogDescription>
        </DialogHeader>

        {hasAssignments && (
          <div className="rounded-md border border-border/60 bg-background/80 p-3">
            <ul className="space-y-1 text-sm">
              {visibleSample.map((a) => (
                <li key={`${a.projectSlug ?? 'standalone'}/${a.assignmentSlug}`}>
                  <span className="font-mono text-xs text-muted-foreground">{a.display}</span>
                </li>
              ))}
              {remaining_extra > 0 && (
                <li className="text-xs italic text-muted-foreground">+{remaining_extra} more not shown</li>
              )}
            </ul>
          </div>
        )}

        {ruleReferences.length > 0 && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
            <p className="mb-1 text-xs font-medium text-foreground">Workflow rules referencing this status:</p>
            <ul className="space-y-0.5 font-mono text-xs text-muted-foreground">
              {ruleReferences.map((r, i) => (
                <li key={i}>
                  <span className="text-foreground">{r.section}</span>
                  <span className="mx-1">·</span>
                  {r.detail}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">
              {mode === 'remap'
                ? 'These will be remapped to the target status.'
                : 'Ladder rungs and transitions referencing this status will be removed' +
                  (headlineReferences ? '; headline rules must be remapped below.' : '.')}
            </p>
          </div>
        )}

        <div className="space-y-3">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name="status-delete-mode"
              checked={mode === 'remap'}
              onChange={() => setMode('remap')}
              disabled={remaining.length === 0}
              className="mt-1"
            />
            <span className="flex-1">
              <span className="block text-sm font-medium">
                {hasAssignments ? 'Remap to another status' : 'Remap rules to another status'}
              </span>
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                onClick={() => setMode('remap')}
                disabled={mode !== 'remap' || remaining.length === 0}
                className="mt-2 block w-full rounded-md border border-border/60 bg-background px-2 py-1 text-sm"
              >
                {remaining.length === 0 && <option value="">(no other statuses)</option>}
                {remaining.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label} ({s.id})
                  </option>
                ))}
              </select>
              {remaining.length === 0 && (
                <span className="block text-xs text-muted-foreground mt-1">
                  No other saved statuses to remap to. Add another status first, or use Delete.
                </span>
              )}
            </span>
          </label>

          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name="status-delete-mode"
              checked={mode === 'delete'}
              onChange={() => setMode('delete')}
              className="mt-1"
            />
            <span className="flex-1">
              <span className="block text-sm font-medium text-error-foreground">
                {hasAssignments ? 'Delete these assignments' : 'Drop the referencing rules'}
              </span>
              <span className="block text-xs text-muted-foreground mt-1">
                {hasAssignments
                  ? `Permanently removes ${affected.count} assignment${affected.count === 1 ? '' : 's'} from disk. This cannot be undone.`
                  : 'Ladder rungs and transitions referencing this status are removed.'}
              </span>
              {mode === 'delete' && headlineReferences && (
                <span className="mt-2 block">
                  <span className="block text-xs font-medium">Remap headline rules to</span>
                  <select
                    value={headlineTarget}
                    onChange={(e) => setHeadlineTarget(e.target.value)}
                    disabled={remaining.length === 0}
                    className="mt-1 block w-full rounded-md border border-border/60 bg-background px-2 py-1 text-sm"
                  >
                    {remaining.length === 0 && <option value="">(no other statuses)</option>}
                    {remaining.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label} ({s.id})
                      </option>
                    ))}
                  </select>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    The headline projection cannot reference a deleted status, so it must point somewhere.
                  </span>
                </span>
              )}
              {mode === 'delete' && hasAssignments && (
                <label className="mt-2 flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={confirmDelete}
                    onChange={(e) => setConfirmDelete(e.target.checked)}
                  />
                  <span className="text-xs">
                    I understand this will permanently delete {affected.count} assignment{affected.count === 1 ? '' : 's'}.
                  </span>
                </label>
              )}
            </span>
          </label>
        </div>

        <DialogFooter>
          <button type="button" onClick={onCancel} className="shell-action">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm}
            className={`shell-action ${
              mode === 'delete' ? 'bg-error text-error-foreground hover:opacity-90' : 'shell-action--cta'
            } disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {mode === 'remap'
              ? hasAssignments
                ? `Remap ${affected.count} → ${target || '...'}`
                : `Remap rules → ${target || '...'}`
              : hasAssignments
                ? `Delete ${affected.count}`
                : 'Drop rules'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
