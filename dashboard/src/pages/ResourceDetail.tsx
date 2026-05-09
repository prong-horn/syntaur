import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Pencil, Trash2 } from 'lucide-react';
import { useResource } from '../hooks/useProjects';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { MarkdownRenderer } from '../components/MarkdownRenderer';
import { formatDateTime } from '../lib/format';

export function ResourceDetail() {
  const { slug, itemSlug } = useParams<{ slug: string; itemSlug: string }>();
  const navigate = useNavigate();
  const { data, loading, error } = useResource(slug, itemSlug);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!slug || !itemSlug) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/projects/${slug}/resources/${itemSlug}`, { method: 'DELETE' });
      if (res.ok) {
        navigate('/resources');
      }
    } finally {
      setDeleting(false);
    }
  }

  if (loading) return <LoadingState label="Loading resource…" />;
  if (error) return <ErrorState error={error} />;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground">{data.name || data.slug}</h2>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Link
              to={`/projects/${data.projectSlug}`}
              className="rounded-full border border-border/60 bg-muted/50 px-2 py-0.5 hover:text-foreground"
            >
              {data.projectTitle}
            </Link>
            {data.category ? (
              <span className="rounded-full border border-border/60 bg-muted/50 px-2 py-0.5">
                Category: {data.category}
              </span>
            ) : null}
            {data.source ? (
              <span className="rounded-full border border-border/60 bg-muted/50 px-2 py-0.5">
                Source: {data.source}
              </span>
            ) : null}
            <span className="rounded-full border border-border/60 bg-muted/50 px-2 py-0.5">
              {data.relatedAssignments.length} related
            </span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span>Created {formatDateTime(data.created)}</span>
            <span>Updated {formatDateTime(data.updated)}</span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Link
            to={`/projects/${slug}/resources/${itemSlug}/edit`}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border/70 bg-background px-3 text-xs font-medium text-foreground transition hover:bg-muted"
          >
            <Pencil className="h-3 w-3" />
            Edit
          </Link>
          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-destructive px-3 text-xs font-medium text-destructive-foreground transition hover:bg-destructive/90 disabled:opacity-50"
              >
                {deleting ? 'Deleting…' : 'Confirm'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="inline-flex h-8 items-center rounded-md border border-border/70 bg-background px-3 text-xs font-medium text-foreground transition hover:bg-muted"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border/70 bg-background px-3 text-xs font-medium text-destructive transition hover:bg-destructive/10"
            >
              <Trash2 className="h-3 w-3" />
              Delete
            </button>
          )}
        </div>
      </div>

      <div className="surface-panel p-4">
        <MarkdownRenderer content={data.body} />
      </div>
    </div>
  );
}
