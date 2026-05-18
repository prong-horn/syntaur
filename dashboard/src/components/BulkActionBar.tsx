import { DIALOG_COPY } from '../lib/overviewCopy';

interface BulkActionBarProps {
  count: number;
  loading?: boolean;
  partialFailureBanner?: string | null;
  onArchive: () => void;
  onClear: () => void;
}

export function BulkActionBar({
  count,
  loading = false,
  partialFailureBanner,
  onArchive,
  onClear,
}: BulkActionBarProps) {
  if (count === 0) return null;

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="fixed inset-x-0 bottom-0 z-30 flex justify-center pb-3 pointer-events-none"
    >
      <div className="pointer-events-auto flex max-w-3xl flex-col items-stretch gap-1 rounded-lg border border-border/70 bg-background shadow-lg">
        {partialFailureBanner ? (
          <p
            aria-live="polite"
            className="rounded-t-lg bg-destructive/10 px-4 py-2 text-xs text-destructive"
          >
            {partialFailureBanner}
          </p>
        ) : null}
        <div className="flex items-center gap-3 px-4 py-2">
          <span className="text-sm font-medium text-foreground">
            {count} selected
          </span>
          <button
            type="button"
            disabled={loading}
            onClick={onArchive}
            className="shell-action bg-foreground text-background hover:opacity-90 disabled:opacity-50"
          >
            {loading ? 'Archiving…' : `${DIALOG_COPY.bulkArchiveLabel} (${count})`}
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={onClear}
            className="shell-action"
          >
            {DIALOG_COPY.bulkClearLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
