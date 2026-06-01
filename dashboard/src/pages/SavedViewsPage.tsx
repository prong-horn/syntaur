import { useState, useRef, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Pencil, Plus } from 'lucide-react';
import type { SavedView, ViewMode } from '@shared/saved-views-schema';
import {
  useSavedViews,
  createSavedView,
  updateSavedView,
  deleteSavedView,
} from '../hooks/useSavedViews';
import {
  inferLandingRoute,
  summarizeFilters,
  buildCreateViewPayload,
  mergeUpdatedConfig,
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
  const { toast, showToast, dismissToast } = useToast();
  const [deleteTarget, setDeleteTarget] = useState<SavedView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SavedView | null>(null);

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

  // Build + persist a view from the dialog's builder state. The stored workspace
  // is a raw passthrough of the route param (matching the capture flow), so the
  // name is passed explicitly and never clobbered by the payload spread.
  async function handleCreate(name: string, state: CreateViewBuilderState) {
    const { workspace: ws, config } = buildCreateViewPayload(state, workspace ?? null);
    try {
      await createSavedView({ name, workspace: ws, config });
      setCreateOpen(false);
      showToast(`Created view "${name}"`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to create saved view');
      throw err; // keep the dialog open and let it surface the inline error
    }
  }

  // Edit preserves the VIEW's own workspace (never the route) and merges the
  // built fields onto the existing config so column/section visibility + unknown
  // forward-compat keys survive (visibility from the existing view — the dialog
  // doesn't edit it).
  async function handleEdit(target: SavedView, name: string, state: CreateViewBuilderState) {
    const built = buildCreateViewPayload(state, target.workspace).config;
    const config = mergeUpdatedConfig(target.config, built, target.config);
    try {
      await updateSavedView(target.id, { name, config });
      setEditTarget(null);
      showToast(`Updated view "${name}"`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update saved view');
      throw err;
    }
  }

  async function handleDuplicate(view: SavedView) {
    try {
      await createSavedView({
        name: `${view.name} (copy)`,
        workspace: view.workspace,
        config: view.config,
      });
      showToast(`Duplicated "${view.name}"`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to duplicate saved view');
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
        description="Create a view here, or browse, rename, and apply views captured from any board."
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
                onRenameError={(msg) => showToast(msg)}
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
        onSubmit={
          editTarget ? (name, state) => handleEdit(editTarget, name, state) : handleCreate
        }
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
  onRenameError: (message: string) => void;
  onRequestDelete: () => void;
  onRequestEdit: () => void;
  onRequestDuplicate: () => void;
}

function SavedViewRow({
  view,
  onRenameError,
  onRequestDelete,
  onRequestEdit,
  onRequestDuplicate,
}: SavedViewRowProps) {
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
