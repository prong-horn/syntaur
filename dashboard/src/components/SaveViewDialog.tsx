import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

interface SaveViewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialName?: string;
  onSubmit: (name: string) => Promise<void>;
  title?: string;
}

const MAX_NAME_LENGTH = 80;

export function SaveViewDialog({
  open,
  onOpenChange,
  initialName = '',
  onSubmit,
  title = 'Save view',
}: SaveViewDialogProps) {
  const [value, setValue] = useState(initialName);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset local state whenever the dialog is (re)opened.
  useEffect(() => {
    if (open) {
      setValue(initialName);
      setError(null);
      setSubmitting(false);
    }
  }, [open, initialName]);

  const trimmed = value.trim();
  const valid = trimmed.length > 0 && trimmed.length <= MAX_NAME_LENGTH;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!valid || submitting) return;
            setSubmitting(true);
            setError(null);
            try {
              await onSubmit(trimmed);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
              setSubmitting(false);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>

          <div className="space-y-2">
            <input
              type="text"
              value={value}
              autoFocus
              required
              maxLength={MAX_NAME_LENGTH}
              onChange={(e) => setValue(e.target.value)}
              placeholder="View name"
              className="w-full rounded-md border border-border/70 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {error ? (
              <p className="text-xs text-error-foreground" role="alert">
                {error}
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
              disabled={!valid || submitting}
              className="shell-action bg-foreground text-background hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? 'Saving…' : 'Save'}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
