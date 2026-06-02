import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import type { SavedView, ViewMode } from '@shared/saved-views-schema';
import { useSavedViews, createSavedView } from '../hooks/useSavedViews';
import { useSavedViewActions } from '../hooks/useSavedViewActions';
import {
  savedViewPath,
  summarizeFilters,
  buildCreateViewPayload,
  type CreateViewBuilderState,
} from '../lib/savedViews';
import { LoadingState } from '../components/LoadingState';
import { EmptyState } from '../components/EmptyState';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CreateViewDialog } from '../components/CreateViewDialog';
import { PageHeader } from '../components/PageHeader';
import { SectionCard } from '../components/SectionCard';
import { useToast, Toaster } from '../components/Toast';
import { toTitleCase } from '../lib/format';

const VIEW_MODE_LABEL: Record<ViewMode, string> = {
  kanban: 'Kanban',
  list: 'List',
  table: 'Table',
};

export function SavedViewsPage() {
  const { workspace } = useParams<{ workspace?: string }>();
  const { views, loading } = useSavedViews();
  const { submitEdit, duplicate, remove } = useSavedViewActions();
  const { toast, showToast, dismissToast } = useToast();
  const [deleteTarget, setDeleteTarget] = useState<SavedView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SavedView | null>(null);

  // Create-new uses the ROUTE workspace; the name is passed explicitly so the
  // payload spread can't clobber it.
  async function handleCreate(name: string, state: CreateViewBuilderState) {
    const { workspace: ws, config } = buildCreateViewPayload(state, workspace ?? null);
    try {
      await createSavedView({ name, workspace: ws, config });
      setCreateOpen(false);
      showToast(`Created view "${name}"`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to create saved view');
      throw err; // keep the dialog open and surface the inline error
    }
  }

  async function handleEdit(target: SavedView, name: string, state: CreateViewBuilderState) {
    try {
      await submitEdit(target, name, state);
      setEditTarget(null);
      showToast(`Updated view "${name}"`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update saved view');
      throw err;
    }
  }

  async function handleDuplicate(view: SavedView) {
    try {
      await duplicate(view);
      showToast(`Duplicated "${view.name}"`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to duplicate saved view');
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await remove(deleteTarget);
      setDeleteTarget(null);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to delete saved view');
    } finally {
      setDeleting(false);
    }
  }

  const createButton = (
    <button
      type="button"
      onClick={() => setCreateOpen(true)}
      className="shell-action inline-flex items-center gap-1.5 bg-foreground text-background hover:opacity-90"
    >
      <Plus className="h-4 w-4" />
      Create view
    </button>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Saved Views"
        description="Create a view here, or open, edit, and reuse views captured from any board."
        actions={createButton}
      />

      {loading ? (
        <LoadingState label="Loading saved views…" />
      ) : views.length === 0 ? (
        <EmptyState
          title="No saved views yet"
          description="Create your first view here, or capture one from any assignments board."
          actions={createButton}
        />
      ) : (
        <SectionCard>
          <ul className="divide-y divide-border/60">
            {views.map((view) => (
              <SavedViewRow
                key={view.id}
                view={view}
                onRequestDelete={() => setDeleteTarget(view)}
                onRequestEdit={() => setEditTarget(view)}
                onRequestDuplicate={() => void handleDuplicate(view)}
              />
            ))}
          </ul>
        </SectionCard>
      )}

      <CreateViewDialog
        open={createOpen || editTarget !== null}
        onOpenChange={(o) => {
          if (!o) {
            setCreateOpen(false);
            setEditTarget(null);
          }
        }}
        // Edit scopes options to the VIEW's own workspace (NOT the route — a global
        // view edited from /w/:ws/views must stay global). Create uses the route.
        workspace={editTarget ? editTarget.workspace : workspace ?? null}
        initialView={editTarget}
        onSubmit={editTarget ? (name, state) => handleEdit(editTarget, name, state) : handleCreate}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete saved view?"
        description={
          deleteTarget
            ? `Delete '${deleteTarget.name}'? Any Overview widgets referencing this view will become empty.`
            : ''
        }
        confirmLabel="Delete"
        loading={deleting}
        destructive
        onConfirm={handleConfirmDelete}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
      />

      <Toaster toast={toast} onDismiss={dismissToast} />
    </div>
  );
}

interface SavedViewRowProps {
  view: SavedView;
  onRequestDelete: () => void;
  onRequestEdit: () => void;
  onRequestDuplicate: () => void;
}

function SavedViewRow({ view, onRequestDelete, onRequestEdit, onRequestDuplicate }: SavedViewRowProps) {
  const navigate = useNavigate();
  const open = () => navigate(savedViewPath(view));
  const summary = summarizeFilters(view.config.filters);
  const workspaceLabel = view.workspace ? toTitleCase(view.workspace) : null;

  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={open}
            className="truncate text-left text-sm font-semibold text-foreground hover:text-primary"
            title="Open view"
          >
            {view.name}
          </button>
          <span className="inline-flex shrink-0 items-center rounded-full border border-border/70 bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            {VIEW_MODE_LABEL[view.config.viewMode]}
          </span>
          {workspaceLabel ? (
            <span className="inline-flex shrink-0 items-center rounded-full border border-border/70 bg-muted/60 px-2 py-0.5 text-xs text-muted-foreground">
              {workspaceLabel}
            </span>
          ) : null}
        </div>
        <p className="truncate text-xs text-muted-foreground">{summary}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button type="button" onClick={open} className="shell-action">
          Open
        </button>
        <button type="button" onClick={onRequestEdit} className="shell-action">
          Edit
        </button>
        <button type="button" onClick={onRequestDuplicate} className="shell-action">
          Duplicate
        </button>
        <button
          type="button"
          onClick={onRequestDelete}
          className="shell-action border-destructive/40 text-destructive hover:bg-destructive/10"
        >
          Delete
        </button>
      </div>
    </li>
  );
}
