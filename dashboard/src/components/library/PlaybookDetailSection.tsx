import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Pencil, Tag, Trash2, Type } from 'lucide-react';
import { usePlaybook } from '../../hooks/useProjects';
import { deletePlaybook, renamePlaybook, setPlaybookEnabled } from '../../data/libraryResources';
import { errorMessage, isApiError } from '../../data/client';
import { LoadingState } from '../LoadingState';
import { ErrorState } from '../ErrorState';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { formatDateTime } from '../../lib/format';
import { isValidSlug, slugify } from '../../lib/slug';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

export interface PlaybookDetailSectionProps {
  slug: string;
  linkPrefix?: string;
}

export function PlaybookDetailSection({ slug, linkPrefix = '/library/playbooks' }: PlaybookDetailSectionProps) {
  const base = linkPrefix.replace(/\/$/, '');
  const navigate = useNavigate();
  const { data, loading, error, refetch } = usePlaybook(slug);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameInput, setRenameInput] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const isManifest = slug === 'manifest';

  useEffect(() => {
    if (renameOpen) {
      setRenameInput(slug);
      setRenameError(null);
    }
  }, [renameOpen, slug]);

  const renamePreview = slugify(renameInput);
  const renameValid = renamePreview.length > 0 && isValidSlug(renamePreview) && renamePreview !== 'manifest';
  const renameChanged = renamePreview !== slug;

  async function handleRename() {
    if (!renameValid || !renameChanged) return;
    setRenaming(true);
    setRenameError(null);
    try {
      await renamePlaybook(slug, renamePreview);
      setRenameOpen(false);
      navigate(`${base}/${renamePreview}`);
    } catch (err) {
      setRenameError(isApiError(err) ? errorMessage(err) : (err as Error).message);
    } finally {
      setRenaming(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setActionError(null);
    try {
      await deletePlaybook(slug);
      navigate(base);
    } catch (err) {
      setActionError(isApiError(err) ? errorMessage(err) : (err as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  async function handleToggle() {
    if (!data) return;
    setToggling(true);
    setActionError(null);
    try {
      await setPlaybookEnabled(slug, !data.enabled);
      refetch();
    } catch (err) {
      setActionError(isApiError(err) ? errorMessage(err) : (err as Error).message);
    } finally {
      setToggling(false);
    }
  }

  if (loading) return <LoadingState label="Loading playbook..." />;
  if (error) return <ErrorState error={error} />;
  if (!data) return null;

  return (
    <div className="space-y-6">
      {actionError ? (
        <div className="rounded-md border border-error-foreground/30 bg-error px-4 py-3 text-sm text-error-foreground">
          {actionError}
        </div>
      ) : null}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-foreground">{isManifest ? 'Playbook Manifest' : data.name}</h2>
            {isManifest ? (
              <span className="rounded-full border border-border/60 bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground">
                auto-generated
              </span>
            ) : null}
          </div>
          {!isManifest && data.description ? (
            <p className="mt-1 text-sm text-muted-foreground">{data.description}</p>
          ) : null}
          {isManifest ? (
            <p className="mt-1 text-sm text-muted-foreground">
              Rebuilt automatically when playbooks change. Include{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">~/.syntaur/playbooks/manifest.md</code> in agent context.
            </p>
          ) : null}
          {!isManifest && data.whenToUse ? (
            <p className="mt-2 text-sm italic text-muted-foreground">When to use: {data.whenToUse}</p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span>Created {formatDateTime(data.created)}</span>
            <span>Updated {formatDateTime(data.updated)}</span>
          </div>
          {data.tags.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {data.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground"
                >
                  <Tag className="h-3 w-3" />
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {!isManifest ? (
          <div className="flex shrink-0 flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">{data.enabled ? 'Enabled' : 'Disabled'}</span>
              <button
                type="button"
                role="switch"
                aria-checked={data.enabled}
                aria-label={data.enabled ? 'Disable playbook' : 'Enable playbook'}
                onClick={handleToggle}
                disabled={toggling}
                className={`inline-flex h-5 w-9 items-center rounded-full border transition disabled:opacity-50 ${
                  data.enabled
                    ? 'border-status-completed-foreground/60 bg-status-completed-foreground/80'
                    : 'border-foreground/40 bg-foreground/15'
                }`}
              >
                <span
                  className={`block h-4 w-4 rounded-full shadow-sm transition-transform ${
                    data.enabled ? 'translate-x-[18px] bg-background' : 'translate-x-[2px] bg-foreground/70'
                  }`}
                />
              </button>
            </div>
            <Link
              to={`${base}/${slug}/edit`}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border/70 bg-background px-3 text-xs font-medium"
            >
              <Pencil className="h-3 w-3" />
              Edit
            </Link>
            <button
              type="button"
              onClick={() => setRenameOpen(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border/70 bg-background px-3 text-xs font-medium"
            >
              <Type className="h-3 w-3" />
              Rename
            </button>
            {confirmDelete ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={deleting}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-destructive px-3 text-xs font-medium text-destructive-foreground disabled:opacity-50"
                >
                  {deleting ? 'Deleting...' : 'Confirm'}
                </button>
                <button type="button" onClick={() => setConfirmDelete(false)} className="shell-action mt-0 text-xs">
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border/70 px-3 text-xs font-medium text-destructive"
              >
                <Trash2 className="h-3 w-3" />
                Delete
              </button>
            )}
          </div>
        ) : null}
      </div>

      <div className="surface-panel p-4">
        <MarkdownRenderer content={data.body} />
      </div>

      <Dialog open={renameOpen} onOpenChange={(next) => (!renaming ? setRenameOpen(next) : undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename playbook</DialogTitle>
            <DialogDescription>
              The slug changes the file name and frontmatter. The URL updates on save.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label htmlFor="rename-slug-input" className="block text-xs font-medium text-muted-foreground">
              New slug
            </label>
            <input
              id="rename-slug-input"
              type="text"
              autoFocus
              value={renameInput}
              onChange={(event) => setRenameInput(event.target.value)}
              disabled={renaming}
              className="h-9 w-full rounded-md border border-border/70 bg-background px-3 text-sm"
              placeholder="my-new-slug"
            />
            {renameInput && renamePreview !== renameInput ? (
              <p className="text-xs text-muted-foreground">
                Will normalize to <code className="rounded bg-muted px-1">{renamePreview || '—'}</code>
              </p>
            ) : null}
            {renameInput && !renameValid ? (
              <p className="text-xs text-destructive">
                Slugs must be lowercase, hyphen-separated, and cannot be &quot;manifest&quot;.
              </p>
            ) : null}
          </div>
          {renameError ? <p className="text-sm text-destructive" role="alert">{renameError}</p> : null}
          <DialogFooter>
            <button type="button" onClick={() => setRenameOpen(false)} disabled={renaming} className="shell-action mt-0">
              Cancel
            </button>
            <button
              type="button"
              onClick={handleRename}
              disabled={renaming || !renameValid || !renameChanged}
              className="shell-action mt-0 shell-action--cta disabled:opacity-50"
            >
              {renaming ? 'Renaming…' : 'Rename'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
