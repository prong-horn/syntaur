import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { validateNewWorkflowId } from './workflow-switcher-helpers';

interface WorkflowIdDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  confirmLabel: string;
  /** Existing workflow ids — the new id must not collide with any of them. */
  existingIds: string[];
  /** Show the optional display-label field (create only; duplicate copies the source label). */
  withLabelField: boolean;
  /** Throw to keep the dialog open with the message shown inline (e.g. a server 4xx). */
  onSubmit: (id: string, label?: string) => Promise<void>;
}

/**
 * Modal replacement for the `window.prompt` id entry used by workflow create /
 * duplicate. Validates the id inline via {@link validateNewWorkflowId} (so the
 * confirm button is disabled until it is valid) and surfaces a thrown submit
 * error in place rather than dropping the user's typed id on the floor.
 */
export function WorkflowIdDialog({
  open,
  onOpenChange,
  title,
  confirmLabel,
  existingIds,
  withLabelField,
  onSubmit,
}: WorkflowIdDialogProps) {
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset local state whenever the dialog is (re)opened.
  useEffect(() => {
    if (open) {
      setId('');
      setLabel('');
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  const validationError = validateNewWorkflowId(id, existingIds);
  const canSubmit = validationError === null && !submitting;
  // Show the validation hint only once the user has typed; the server error wins.
  const shownError = error ?? (id.length > 0 ? validationError : null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!canSubmit) return;
            setSubmitting(true);
            setError(null);
            try {
              const trimmedLabel = label.trim();
              await onSubmit(id.trim(), withLabelField && trimmedLabel ? trimmedLabel : undefined);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
              setSubmitting(false);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              Enter a workflow id (lowercase letters, digits, dashes){withLabelField ? ' and an optional display label' : ''}.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1">
              <label className="block text-xs font-medium text-muted-foreground">Workflow id</label>
              <input
                type="text"
                value={id}
                autoFocus
                onChange={(e) => setId(e.target.value)}
                placeholder='letters, digits, "_" or "-"'
                className="w-full rounded-md border border-border/70 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>

            {withLabelField ? (
              <div className="space-y-1">
                <label className="block text-xs font-medium text-muted-foreground">
                  Display label (optional)
                </label>
                <input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Human-readable name"
                  className="w-full rounded-md border border-border/70 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
            ) : null}

            {shownError ? (
              <p className="text-xs text-error-foreground" role="alert">
                {shownError}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="shell-action"
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="shell-action shell-action--cta disabled:opacity-50"
            >
              {submitting ? 'Working…' : confirmLabel}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
