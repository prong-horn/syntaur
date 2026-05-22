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

interface StatusDeleteModalProps {
  open: boolean;
  affected: AffectedResponse & { label: string };
  /**
   * Remap target candidates — caller MUST pre-filter to oldIds ∩ newIds
   * minus the row being dropped. Server enforces the same; the modal
   * pre-filters so the user never sees an option that would 400.
   */
  remaining: Array<{ id: string; label: string }>;
  onResolve: (resolution: StatusResolution) => void;
  onCancel: () => void;
}

type Mode = 'remap' | 'delete';

export function StatusDeleteModal({
  open,
  affected,
  remaining,
  onResolve,
  onCancel,
}: StatusDeleteModalProps) {
  const [mode, setMode] = useState<Mode>(remaining.length > 0 ? 'remap' : 'delete');
  const [target, setTarget] = useState<string>(remaining[0]?.id ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (open) {
      setMode(remaining.length > 0 ? 'remap' : 'delete');
      setTarget(remaining[0]?.id ?? '');
      setConfirmDelete(false);
    }
  }, [open, remaining]);

  const canConfirm =
    (mode === 'remap' && remaining.length > 0 && target !== '' && target !== affected.id) ||
    (mode === 'delete' && confirmDelete);

  function handleConfirm() {
    if (!canConfirm) return;
    if (mode === 'remap') {
      onResolve({ id: affected.id, mode: 'remap', target });
    } else {
      onResolve({ id: affected.id, mode: 'delete' });
    }
  }

  const visibleSample = affected.assignments.slice(0, 10);
  const remaining_extra = affected.count - visibleSample.length;

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => (!nextOpen ? onCancel() : undefined)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            Delete status "{affected.label}" — {affected.count} assignment{affected.count === 1 ? '' : 's'} reference it
          </DialogTitle>
          <DialogDescription>
            Choose how to resolve the affected assignments before this status is removed from the workflow.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-border/60 bg-background/80 p-3">
          <ul className="space-y-1 text-sm">
            {visibleSample.map((a) => (
              <li key={`${a.projectSlug ?? 'standalone'}/${a.assignmentSlug}`}>
                <span className="font-mono text-xs text-muted-foreground">{a.display}</span>
              </li>
            ))}
            {remaining_extra > 0 && (
              <li className="text-xs italic text-muted-foreground">
                +{remaining_extra} more not shown
              </li>
            )}
          </ul>
        </div>

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
              <span className="block text-sm font-medium">Remap to another status</span>
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
                Delete these assignments
              </span>
              <span className="block text-xs text-muted-foreground mt-1">
                Permanently removes {affected.count} assignment{affected.count === 1 ? '' : 's'} from disk. This cannot be undone.
              </span>
              {mode === 'delete' && (
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
              mode === 'delete'
                ? 'bg-error text-error-foreground hover:opacity-90'
                : 'bg-foreground text-background hover:opacity-90'
            } disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {mode === 'remap' ? `Remap ${affected.count} → ${target || '...'}` : `Delete ${affected.count}`}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
