import { useSavedView } from '../../../hooks/useSavedViews';
import { LoadingState } from '../../LoadingState';
import { SavedViewResults } from './SavedViewResults';

interface SavedViewWidgetProps {
  viewId: string;
  onPickAnother: () => void;
}

/**
 * Overview dashboard slot for a saved view. Owns the VIEW lifecycle
 * (loading / error / deleted) + the slot-specific "pick another widget"
 * affordance, and delegates the filter/sort/render body to `SavedViewResults`
 * (shared with the full-page `SavedViewPage`).
 */
export function SavedViewWidget({ viewId, onPickAnother }: SavedViewWidgetProps) {
  const { view, loading, error, refetch } = useSavedView(viewId);

  if (loading) {
    return <LoadingState label="Loading view…" />;
  }

  if (error) {
    return (
      <div className="rounded-lg border border-border/60 bg-card/85 px-4 py-3 text-sm">
        <p className="font-medium text-foreground">Couldn't load view</p>
        <p className="mt-1 text-xs text-muted-foreground">{error.message}</p>
        <button type="button" onClick={() => refetch()} className="shell-action mt-3">
          Retry
        </button>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="rounded-lg border border-border/60 bg-card/85 px-4 py-3 text-sm">
        <p className="font-medium text-foreground">View no longer exists</p>
        <p className="mt-1 text-xs text-muted-foreground">
          The saved view this slot was bound to has been deleted.
        </p>
        <button type="button" onClick={onPickAnother} className="shell-action mt-3">
          Pick another widget
        </button>
      </div>
    );
  }

  return (
    <SavedViewResults
      view={view}
      compact
      emptyDescription="Adjust the view's filters to surface different work, or pick another widget for this slot."
    />
  );
}
