import { useEffect, useMemo, useState } from 'react';
import type { AssignmentTransitionAction } from '../hooks/useProjects';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

interface AssignmentTransitionDialogProps {
  open: boolean;
  action: AssignmentTransitionAction | null;
  assignmentTitle: string;
  loading?: boolean;
  onConfirm: (reason?: string) => Promise<void> | void;
  onOpenChange: (open: boolean) => void;
}

export function AssignmentTransitionDialog({
  open,
  action,
  assignmentTitle,
  loading = false,
  onConfirm,
  onOpenChange,
}: AssignmentTransitionDialogProps) {
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!open) {
      setReason('');
    }
  }, [open, action?.command]);

  const promptLabel = useMemo(() => {
    if (!action) {
      return 'Reason';
    }

    return action.command === 'block' ? 'Blocked Reason' : 'Reason';
  }, [action]);

  if (!action) {
    return null;
  }

  const title = `${action.label} "${assignmentTitle}"`;
  const submitLabel = loading ? 'Applying...' : action.label;
  const nextReason = reason.trim() || undefined;

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => (!loading ? onOpenChange(nextOpen) : undefined)}>
      <DialogContent className="max-w-xl">
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            void onConfirm(nextReason);
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {action.description}
            </DialogDescription>
          </DialogHeader>

          {action.warning ? (
            <div className="rounded-lg border border-amber-300/80 bg-amber-50/80 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
              {action.warning}
            </div>
          ) : null}

          <div className="space-y-2">
            <label className="block text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
              {promptLabel}
            </label>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              autoFocus
              rows={4}
              disabled={loading}
              placeholder="Optional context for why this assignment is blocked."
              className="editor-textarea min-h-[120px] bg-background/95 font-sans"
            />
            <p className="text-xs text-muted-foreground">
              Leave this blank to continue without a written reason.
            </p>
          </div>

          <DialogFooter>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={loading}
              className="shell-action disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="shell-action bg-foreground text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitLabel}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
