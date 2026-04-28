import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, Plus, Tag, Search, FileText } from 'lucide-react';
import { usePlaybooks } from '../hooks/useProjects';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';

export function PlaybooksPage() {
  const { data, loading, error, refetch } = usePlaybooks();
  const [search, setSearch] = useState('');
  const [pendingSlug, setPendingSlug] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (!data?.playbooks) return [];
    if (!search.trim()) return data.playbooks;

    const q = search.toLowerCase();
    return data.playbooks.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.slug.toLowerCase().includes(q) ||
        p.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [data, search]);

  async function handleToggle(
    event: React.MouseEvent<HTMLButtonElement>,
    slug: string,
    currentlyEnabled: boolean,
  ) {
    event.preventDefault();
    event.stopPropagation();
    if (pendingSlug) return;

    setPendingSlug(slug);
    try {
      const action = currentlyEnabled ? 'disable' : 'enable';
      const response = await fetch(`/api/playbooks/${encodeURIComponent(slug)}/${action}`, {
        method: 'POST',
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Failed to ${action} playbook`);
      }
      refetch();
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : 'Failed to update playbook');
    } finally {
      setPendingSlug(null);
    }
  }

  if (loading) return <LoadingState label="Loading playbooks..." />;
  if (error) return <ErrorState error={error} />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search playbooks..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 w-full rounded-md border border-border/70 bg-background pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-foreground/30 focus:outline-none"
          />
        </div>
        <Link
          to="/playbooks/create"
          className="inline-flex h-9 items-center gap-2 rounded-md bg-foreground px-3 text-sm font-medium text-background transition hover:bg-foreground/90"
        >
          <Plus className="h-4 w-4" />
          Create Playbook
        </Link>
      </div>

      <Link
        to="/playbooks/manifest"
        className="surface-panel group flex items-center gap-3 p-3 transition hover:border-foreground/20"
      >
        <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground group-hover:underline">Playbook Manifest</h3>
            <span className="rounded-full border border-border/60 bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground">auto-generated</span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Index of all playbooks with descriptions. Include <code className="rounded bg-muted px-1 py-0.5 text-[11px]">~/.syntaur/playbooks/manifest.md</code> in your CLAUDE.md for agent context.
          </p>
        </div>
      </Link>

      {filtered.length === 0 ? (
        <EmptyState
          title="No playbooks found"
          description={
            data?.playbooks.length === 0
              ? 'Playbooks define rules and workflows for how agents should operate. Create your first one to get started.'
              : 'No playbooks match your search.'
          }
          actions={
            data?.playbooks.length === 0 ? (
              <Link
                to="/playbooks/create"
                className="inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background transition hover:bg-foreground/90"
              >
                <Plus className="h-4 w-4" />
                Create Playbook
              </Link>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((playbook) => {
            const isPending = pendingSlug === playbook.slug;
            return (
              <div
                key={playbook.slug}
                className={`surface-panel relative flex flex-col gap-2 p-4 transition hover:border-foreground/20 ${playbook.enabled ? '' : 'opacity-75'}`}
              >
                <Link
                  to={`/playbooks/${playbook.slug}`}
                  className="group flex flex-col gap-2"
                >
                  <div className="flex items-start gap-2">
                    <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-semibold text-foreground group-hover:underline">
                        {playbook.name}
                      </h3>
                      {playbook.description ? (
                        <p className="mt-1 text-xs leading-5 text-muted-foreground line-clamp-2">
                          {playbook.description}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pt-1 pr-20">
                    <div className="flex flex-wrap gap-1">
                      {playbook.tags.slice(0, 3).map((tag) => (
                        <span
                          key={tag}
                          className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground"
                        >
                          <Tag className="h-2.5 w-2.5" />
                          {tag}
                        </span>
                      ))}
                      {playbook.tags.length > 3 ? (
                        <span className="text-[10px] text-muted-foreground/60">
                          +{playbook.tags.length - 3}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </Link>
                <button
                  type="button"
                  role="switch"
                  aria-checked={playbook.enabled}
                  aria-label={playbook.enabled ? 'Disable playbook' : 'Enable playbook'}
                  onClick={(e) => handleToggle(e, playbook.slug, playbook.enabled)}
                  disabled={isPending}
                  className={`absolute bottom-3 right-3 z-10 inline-flex h-5 w-9 items-center rounded-full border opacity-100 transition disabled:opacity-50 ${
                    playbook.enabled
                      ? 'border-status-completed-foreground/60 bg-status-completed-foreground/80'
                      : 'border-foreground/40 bg-foreground/15'
                  }`}
                >
                  <span
                    className={`block h-4 w-4 rounded-full shadow-sm transition-transform ${
                      playbook.enabled ? 'translate-x-[18px] bg-background' : 'translate-x-[2px] bg-foreground/70'
                    }`}
                  />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
