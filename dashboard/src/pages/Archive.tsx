import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Archive as ArchiveIcon, ArchiveRestore, ChevronDown, ChevronRight, FolderKanban } from 'lucide-react';
import { useArchived, type ArchivedAssignmentItem, type ArchivedProjectItem } from '../hooks/useProjects';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { SectionCard } from '../components/SectionCard';
import { StatusBadge } from '../components/StatusBadge';
import { formatDateTime } from '../lib/format';
import { useToast, Toaster } from '../components/Toast';

function ArchivedPill() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-status-archived-foreground/30 bg-status-archived px-2 py-0.5 text-xs font-medium text-status-archived-foreground">
      <ArchiveIcon className="h-3 w-3" />
      Archived
    </span>
  );
}

function assignmentHref(item: ArchivedAssignmentItem): string {
  return item.projectSlug
    ? `/projects/${item.projectSlug}/assignments/${item.slug}`
    : `/assignments/${item.id}`;
}

export function Archive() {
  const { data, loading, error, refetch } = useArchived();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const { toast, showToast, dismissToast } = useToast();

  async function post(url: string, key: string, successMessage: string) {
    setBusy(key);
    setActionError(null);
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.error || `HTTP ${res.status}`);
      }
      refetch();
      showToast(successMessage, 'success');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Restore failed');
    } finally {
      setBusy(null);
    }
  }

  function restoreProject(project: ArchivedProjectItem) {
    return post(`/api/projects/${project.slug}/unarchive`, `project:${project.slug}`, 'Project restored');
  }

  function restoreAssignment(item: ArchivedAssignmentItem) {
    const url = item.projectSlug
      ? `/api/projects/${item.projectSlug}/assignments/${item.slug}/unarchive`
      : `/api/assignments/${item.id}/unarchive`;
    return post(url, `assignment:${item.id}`, 'Assignment restored');
  }

  if (loading) return <LoadingState label="Loading archived content…" />;
  if (error) return <ErrorState error={error} />;

  const projects = data?.projects ?? [];
  const assignments = data?.assignments ?? [];
  const isEmpty = projects.length === 0 && assignments.length === 0;

  return (
    <div className="space-y-6">
      <Toaster toast={toast} onDismiss={dismissToast} />
      <PageHeader
        title="Archive"
        description="Archived projects and individually-archived assignments. Restoring a project also brings back its cascade-hidden assignments; assignments archived on their own stay archived until restored here."
      />

      {actionError ? (
        <div className="rounded border border-status-failed-foreground/30 bg-status-failed px-3 py-2 text-sm text-status-failed-foreground">
          {actionError}
        </div>
      ) : null}

      {isEmpty ? (
        <EmptyState
          title="Nothing archived"
          description="Archived projects and assignments will appear here, ready to restore."
        />
      ) : (
        <>
          {projects.length > 0 && (
            <SectionCard title="Archived Projects" description="Restoring a project unhides every cascade-hidden assignment; individually-archived children stay archived.">
              <ul className="divide-y divide-border">
                {projects.map((project) => {
                  const open = expanded[project.slug] ?? false;
                  return (
                    <li key={project.slug} className="py-3">
                      <div className="flex flex-wrap items-center gap-3">
                        <button
                          type="button"
                          onClick={() => setExpanded((prev) => ({ ...prev, [project.slug]: !open }))}
                          className="inline-flex items-center gap-1.5 text-left text-sm font-medium text-foreground hover:text-foreground/80"
                          aria-expanded={open}
                        >
                          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          <FolderKanban className="h-4 w-4 text-muted-foreground" />
                          {project.title}
                          <span className="text-xs text-muted-foreground">
                            ({project.assignments.length} assignment{project.assignments.length === 1 ? '' : 's'})
                          </span>
                        </button>
                        <span className="text-xs text-muted-foreground">
                          Archived {project.archivedAt ? formatDateTime(project.archivedAt) : 'with no timestamp'}
                          {project.archivedReason ? ` · ${project.archivedReason}` : ''}
                        </span>
                        <div className="ml-auto flex items-center gap-2">
                          <Link
                            to={`/projects/${project.slug}`}
                            className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground"
                          >
                            Open
                          </Link>
                          <button
                            type="button"
                            onClick={() => restoreProject(project)}
                            disabled={busy === `project:${project.slug}`}
                            className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground disabled:opacity-50"
                          >
                            <ArchiveRestore className="h-3 w-3" />
                            Restore
                          </button>
                        </div>
                      </div>
                      {open && project.assignments.length > 0 && (
                        <ul className="mt-2 space-y-1 pl-9">
                          {project.assignments.map((child) => (
                            <li key={child.id} className="flex flex-wrap items-center gap-2 text-sm">
                              <Link to={assignmentHref(child)} className="text-foreground hover:text-foreground/80">
                                {child.title}
                              </Link>
                              <StatusBadge status={child.status} showIcon={false} />
                              <span className="text-xs text-muted-foreground">
                                {child.archived
                                  ? 'Archived individually — stays archived after restore'
                                  : 'Hidden via project — returns on restore'}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </SectionCard>
          )}

          {assignments.length > 0 && (
            <SectionCard title="Archived Assignments" description="Individually-archived assignments whose project is still active.">
              <ul className="divide-y divide-border">
                {assignments.map((item) => (
                  <li key={item.id} className="flex flex-wrap items-center gap-3 py-3">
                    <Link to={assignmentHref(item)} className="text-sm font-medium text-foreground hover:text-foreground/80">
                      {item.title}
                    </Link>
                    <StatusBadge status={item.status} showIcon={false} />
                    <ArchivedPill />
                    <span className="text-xs text-muted-foreground">
                      {item.projectTitle ?? 'Standalone'} · Archived{' '}
                      {item.archivedAt ? formatDateTime(item.archivedAt) : 'with no timestamp'}
                      {item.archivedReason ? ` · ${item.archivedReason}` : ''}
                    </span>
                    <button
                      type="button"
                      onClick={() => restoreAssignment(item)}
                      disabled={busy === `assignment:${item.id}`}
                      className="ml-auto inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground disabled:opacity-50"
                    >
                      <ArchiveRestore className="h-3 w-3" />
                      Restore
                    </button>
                  </li>
                ))}
              </ul>
            </SectionCard>
          )}
        </>
      )}
    </div>
  );
}
