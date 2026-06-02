import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { DIALOG_COPY } from '../lib/overviewCopy';
import { readClaimAs, writeClaimAs } from '../lib/assignments';

interface ClaimAsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (assignee: string) => void;
}

export function ClaimAsDialog({ open, onOpenChange, onSubmit }: ClaimAsDialogProps) {
  const [value, setValue] = useState(readClaimAs());

  useEffect(() => {
    if (open) setValue(readClaimAs());
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = value.trim();
            if (!trimmed) return;
            writeClaimAs(trimmed);
            onSubmit(trimmed);
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{DIALOG_COPY.claimAsTitle}</DialogTitle>
            <DialogDescription>{DIALOG_COPY.claimAsHint}</DialogDescription>
          </DialogHeader>

          <input
            type="text"
            value={value}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
            placeholder="human, claude, codex…"
            className="w-full rounded-md border border-border/70 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />

          <DialogFooter>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="shell-action"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={value.trim().length === 0}
              className="shell-action shell-action--cta disabled:opacity-50"
            >
              {DIALOG_COPY.claimAsSubmit}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
