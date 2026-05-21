import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Pencil } from 'lucide-react';
import type { SavedView, ViewMode } from '@shared/saved-views-schema';
import {
  useSavedViews,
  updateSavedView,
  deleteSavedView,
} from '../hooks/useSavedViews';
import { inferLandingRoute, summarizeFilters } from '../lib/savedViews';
import { LoadingState } from '../components/LoadingState';
import { EmptyState } from '../components/EmptyState';
import { ConfirmDialog } from '../components/ConfirmDialog';
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
  const { views, loading } = useSavedViews();
  const { toast, showToast, dismissToast } = useToast();
  const [deleteTarget, setDeleteTarget] = useState<SavedView | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteSavedView(deleteTarget.id);
      setDeleteTarget(null);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to delete saved view');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Saved Views"
        description="Browse, rename, and apply saved views captured from any assignments board."
      />

      {loading ? (
        <LoadingState label="Loading saved views…" />
      ) : views.length === 0 ? (
        <EmptyState
          title="No saved views yet"
          description="Visit any assignments board, set filters/sort/column visibility, and click 'Save view' to start."
        />
      ) : (
        <SectionCard>
          <ul className="divide-y divide-border/60">
            {views.map((view) => (
              <SavedViewRow
                key={view.id}
                view={view}
                onRenameError={(msg) => showToast(msg)}
                onRequestDelete={() => setDeleteTarget(view)}
              />
            ))}
          </ul>
        </SectionCard>
      )}

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
  onRenameError: (message: string) => void;
  onRequestDelete: () => void;
}

function SavedViewRow({ view, onRenameError, onRequestDelete }: SavedViewRowProps) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(view.name);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  // Sync draft when the underlying view name changes from outside (e.g. successful save).
  useEffect(() => {
    if (!editing) setDraft(view.name);
  }, [view.name, editing]);

  async function commitRename() {
    const next = draft.trim();
    if (!next || next === view.name) {
      setDraft(view.name);
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await updateSavedView(view.id, { name: next });
      setEditing(false);
    } catch (err) {
      onRenameError(err instanceof Error ? err.message : 'Failed to rename saved view');
      // Stay in edit mode on error.
    } finally {
      setSaving(false);
    }
  }

  function cancelRename() {
    setDraft(view.name);
    setEditing(false);
  }

  const summary = summarizeFilters(view.config.filters);
  const workspaceLabel = view.workspace ? toTitleCase(view.workspace) : null;

  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          {editing ? (
            <input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                if (!saving) void commitRename();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void commitRename();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelRename();
                }
              }}
              disabled={saving}
              className="editor-input max-w-xs text-sm font-semibold"
              aria-label="Rename saved view"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="group inline-flex items-center gap-1.5 rounded-md text-left text-sm font-semibold text-foreground hover:text-foreground/80"
              title="Click to rename"
            >
              <span className="truncate">{view.name}</span>
              <Pencil className="h-3 w-3 text-muted-foreground/50 opacity-0 transition group-hover:opacity-100" />
            </button>
          )}
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
        <button
          type="button"
          onClick={() => navigate(inferLandingRoute(view))}
          className="shell-action"
        >
          Apply
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
