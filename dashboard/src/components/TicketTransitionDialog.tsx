import { useEffect, useMemo, useState } from 'react';
import type { TicketTransitionAction } from '../hooks/useProjects';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

interface TicketTransitionDialogProps {
  open: boolean;
  action: TicketTransitionAction | null;
  ticketTitle: string;
  loading?: boolean;
  onConfirm: (reason?: string) => Promise<void> | void;
  onOpenChange: (open: boolean) => void;
}

export function TicketTransitionDialog({
  open,
  action,
  ticketTitle,
  loading = false,
  onConfirm,
  onOpenChange,
}: TicketTransitionDialogProps) {
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

    if (action.command === 'block' || action.command === 'park') return 'Reason';
    if (action.command === 'drop') return 'Drop reason';
    return 'Reason';
  }, [action]);

  if (!action) {
    return null;
  }

  const title = `${action.label} "${ticketTitle}"`;
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
            <div className="rounded-lg border border-warning-foreground/30 bg-warning px-4 py-3 text-sm text-warning-foreground">
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
              placeholder="Optional context for this verb."
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
              className="shell-action shell-action--cta disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitLabel}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
