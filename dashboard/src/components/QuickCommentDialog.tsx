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
import type { QuickCommentType } from '../lib/assignments';

interface QuickCommentDialogProps {
  open: boolean;
  assignmentTitle: string;
  loading?: boolean;
  onSubmit: (body: string, type: QuickCommentType) => Promise<void> | void;
  onOpenChange: (open: boolean) => void;
}

export function QuickCommentDialog({
  open,
  assignmentTitle,
  loading = false,
  onSubmit,
  onOpenChange,
}: QuickCommentDialogProps) {
  const [body, setBody] = useState('');
  const [type, setType] = useState<QuickCommentType>('note');

  useEffect(() => {
    if (!open) {
      setBody('');
      setType('note');
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => (!loading ? onOpenChange(next) : undefined)}>
      <DialogContent className="max-w-xl">
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            const trimmed = body.trim();
            if (!trimmed) return;
            await onSubmit(trimmed, type);
          }}
        >
          <DialogHeader>
            <DialogTitle>{DIALOG_COPY.quickCommentTitle}</DialogTitle>
            <DialogDescription>On “{assignmentTitle}”</DialogDescription>
          </DialogHeader>

          <textarea
            value={body}
            autoFocus
            rows={5}
            disabled={loading}
            onChange={(e) => setBody(e.target.value)}
            placeholder={DIALOG_COPY.quickCommentPlaceholder}
            className="w-full rounded-md border border-border/70 bg-background px-3 py-2 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="comment-type"
                value="note"
                checked={type === 'note'}
                onChange={() => setType('note')}
              />
              note
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="comment-type"
                value="question"
                checked={type === 'question'}
                onChange={() => setType('question')}
              />
              question
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="comment-type"
                value="feedback"
                checked={type === 'feedback'}
                onChange={() => setType('feedback')}
              />
              feedback
            </label>
          </div>

          <DialogFooter>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="shell-action"
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || body.trim().length === 0}
              className="shell-action bg-foreground text-background hover:opacity-90 disabled:opacity-50"
            >
              {loading ? 'Posting…' : DIALOG_COPY.quickCommentSubmit}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
