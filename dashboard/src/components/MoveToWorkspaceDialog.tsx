import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { useWorkspaces } from '../hooks/useProjects';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

interface MoveToWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Current value. Used to disable the matching row. */
  currentWorkspace: string | null;
  /** Receives `null` for the Ungrouped target. */
  onSubmit: (target: string | null) => Promise<void> | void;
  title?: string;
  description?: string;
}

const UNGROUPED_KEY = '__ungrouped__';

export function MoveToWorkspaceDialog({
  open,
  onOpenChange,
  currentWorkspace,
  onSubmit,
  title = 'Move to workspace',
  description = 'Pick the workspace this item should belong to.',
}: MoveToWorkspaceDialogProps) {
  const { data, loading: loadingWorkspaces } = useWorkspaces();
  const [selected, setSelected] = useState<string | null>(currentWorkspace);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSelected(currentWorkspace);
      setError(null);
    }
  }, [open, currentWorkspace]);

  const options = useMemo<Array<{ key: string; label: string; value: string | null }>>(() => {
    const named = (data?.workspaces ?? []).map((name) => ({ key: name, label: name, value: name as string | null }));
    return [...named, { key: UNGROUPED_KEY, label: 'Ungrouped', value: null }];
  }, [data]);

  const canSubmit = !submitting && selected !== currentWorkspace;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(selected);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to move item');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (!submitting ? onOpenChange(next) : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="my-2 max-h-[320px] overflow-y-auto rounded-md border border-border/60">
          {loadingWorkspaces && options.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading workspaces…
            </div>
          ) : (
            options.map((option) => {
              const isCurrent = option.value === currentWorkspace;
              const isSelected = option.value === selected;
              return (
                <button
                  key={option.key}
                  type="button"
                  disabled={isCurrent || submitting}
                  onClick={() => setSelected(option.value)}
                  className={cn(
                    'flex w-full items-center justify-between px-3 py-2 text-left text-sm transition',
                    isCurrent
                      ? 'cursor-not-allowed bg-foreground/5 text-muted-foreground'
                      : isSelected
                        ? 'bg-accent/40 text-foreground'
                        : 'hover:bg-foreground/5',
                  )}
                >
                  <span className={cn('truncate', option.value === null ? 'italic text-muted-foreground' : '')}>
                    {option.label}
                    {isCurrent ? <span className="ml-2 text-xs">(current)</span> : null}
                  </span>
                  {isSelected ? <Check className="h-4 w-4 text-foreground" /> : null}
                </button>
              );
            })
          )}
        </div>

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className="shell-action mt-0 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="shell-action mt-0 bg-foreground text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Moving…' : 'Move'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
