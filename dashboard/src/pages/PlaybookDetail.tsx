import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Pencil, Trash2, Tag } from 'lucide-react';
import { usePlaybook } from '../hooks/useProjects';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { MarkdownRenderer } from '../components/MarkdownRenderer';
import { formatDateTime } from '../lib/format';

export function PlaybookDetail() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { data, loading, error } = usePlaybook(slug);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const isManifest = slug === 'manifest';

  async function handleDelete() {
    if (!slug) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/playbooks/${slug}`, { method: 'DELETE' });
      if (res.ok) {
        navigate('/playbooks');
      }
    } finally {
      setDeleting(false);
    }
  }

  if (loading) return <LoadingState label="Loading playbook..." />;
  if (error) return <ErrorState error={error} />;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-foreground">
              {isManifest ? 'Playbook Manifest' : data.name}
            </h2>
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
              This file is rebuilt automatically when playbooks are added or removed. Include{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">~/.syntaur/playbooks/manifest.md</code>{' '}
              in your CLAUDE.md for agent context.
            </p>
          ) : null}

          {!isManifest && data.whenToUse ? (
            <p className="mt-2 text-sm text-muted-foreground italic">
              When to use: {data.whenToUse}
            </p>
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
          <div className="flex shrink-0 gap-2">
            <Link
              to={`/playbooks/${slug}/edit`}
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
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-red-600 px-3 text-xs font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
                >
                  {deleting ? 'Deleting...' : 'Confirm'}
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
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border/70 bg-background px-3 text-xs font-medium text-red-600 transition hover:bg-red-50 dark:hover:bg-red-950/30"
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
    </div>
  );
}
