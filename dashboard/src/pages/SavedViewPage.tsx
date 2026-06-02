import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import type { SavedView, ViewMode } from '@shared/saved-views-schema';
import { useSavedView } from '../hooks/useSavedViews';
import { useSavedViewActions } from '../hooks/useSavedViewActions';
import {
  inferLandingRoute,
  savedViewPath,
  savedViewsIndexPath,
  summarizeFilters,
  type CreateViewBuilderState,
} from '../lib/savedViews';
import { SavedViewResults } from '../components/dashboard/widgets/SavedViewResults';
import { CreateViewDialog } from '../components/CreateViewDialog';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { PageHeader } from '../components/PageHeader';
import { LoadingState } from '../components/LoadingState';
import { useToast, Toaster } from '../components/Toast';
import { toTitleCase } from '../lib/format';

const VIEW_MODE_LABEL: Record<ViewMode, string> = {
  kanban: 'Kanban',
  list: 'List',
  table: 'Table',
};

export function SavedViewPage() {
  const { id, workspace: routeWorkspace } = useParams<{ id: string; workspace?: string }>();
  const navigate = useNavigate();
  const { view, ready, error, refetch } = useSavedView(id);
  const { submitEdit, duplicate, remove } = useSavedViewActions();
  const { toast, showToast, dismissToast } = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Canonicalize the URL to the VIEW's own workspace scope (the /w/:ws/views list
  // is just another shell over the same file, not a filtered dataset — so a
  // /w/foo/views/:id link to a global or bar view must be corrected). Gate on
  // `ready` so a stale-cache miss mid-revalidation doesn't trigger a wrong redirect.
  useEffect(() => {
    if (!ready || !view) return;
    if ((routeWorkspace ?? null) !== (view.workspace ?? null)) {
      navigate(savedViewPath(view), { replace: true });
    }
  }, [ready, view, routeWorkspace, navigate]);

  if (!ready) {
    return <LoadingState label="Loading view…" />;
  }

  if (error) {
    return (
      <div className="rounded-lg border border-border/60 bg-card/85 px-4 py-6 text-sm">
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
      <div className="space-y-3">
        <PageHeader title="View not found" description="This saved view no longer exists." />
        <Link to={savedViewsIndexPath(routeWorkspace ?? null)} className="shell-action inline-flex items-center gap-1.5">
          <ArrowLeft className="h-4 w-4" /> Back to Saved Views
        </Link>
      </div>
    );
  }

  const workspaceLabel = view.workspace ? toTitleCase(view.workspace) : null;

  async function handleEditSubmit(name: string, state: CreateViewBuilderState) {
    const target = view as SavedView;
    try {
      await submitEdit(target, name, state);
      setEditOpen(false);
      showToast(`Updated view "${name}"`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update saved view');
      throw err; // keep the dialog open + surface inline
    }
  }

  async function handleDuplicate() {
    const v = view as SavedView;
    try {
      await duplicate(v);
      showToast(`Duplicated "${v.name}"`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to duplicate saved view');
    }
  }

  async function handleConfirmDelete() {
    const v = view as SavedView;
    setDeleting(true);
    try {
      await remove(v);
      setDeleteOpen(false);
      navigate(savedViewsIndexPath(v.workspace));
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to delete saved view');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-4">
      <Link
        to={savedViewsIndexPath(view.workspace)}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Saved Views
      </Link>

      <PageHeader
        title={view.name}
        description={summarizeFilters(view.config.filters)}
        actions={
          <>
            <span className="inline-flex shrink-0 items-center rounded-full border border-border/70 bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {VIEW_MODE_LABEL[view.config.viewMode]}
            </span>
            {workspaceLabel ? (
              <span className="inline-flex shrink-0 items-center rounded-full border border-border/70 bg-muted/60 px-2 py-0.5 text-xs text-muted-foreground">
                {workspaceLabel}
              </span>
            ) : null}
            <button type="button" onClick={() => setEditOpen(true)} className="shell-action">
              Edit
            </button>
            <button type="button" onClick={() => void handleDuplicate()} className="shell-action">
              Duplicate
            </button>
            <button type="button" onClick={() => navigate(inferLandingRoute(view))} className="shell-action">
              Open on board
            </button>
            <button
              type="button"
              onClick={() => setDeleteOpen(true)}
              className="shell-action border-destructive/40 text-destructive hover:bg-destructive/10"
            >
              Delete
            </button>
          </>
        }
      />

      <SavedViewResults view={view} />

      <CreateViewDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        workspace={view.workspace}
        initialView={view}
        onSubmit={handleEditSubmit}
      />

      <ConfirmDialog
        open={deleteOpen}
        title="Delete saved view?"
        description={`Delete '${view.name}'? Any Overview widgets referencing this view will become empty.`}
        confirmLabel="Delete"
        loading={deleting}
        destructive
        onConfirm={handleConfirmDelete}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteOpen(false);
        }}
      />

      <Toaster toast={toast} onDismiss={dismissToast} />
    </div>
  );
}
