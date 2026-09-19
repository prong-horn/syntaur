import { Link } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { useResource } from '../../data/useResource';
import { templatesList } from '../../data/libraryResources';
import { LoadingState } from '../LoadingState';
import { ErrorState } from '../ErrorState';
import { EmptyState } from '../EmptyState';

export interface TemplateDetailSectionProps {
  templateId: string;
  linkPrefix?: string;
}

export function TemplateDetailSection({ templateId, linkPrefix = '/library/templates' }: TemplateDetailSectionProps) {
  const base = linkPrefix.replace(/\/$/, '');
  const { data, loading, error, refetch } = useResource(templatesList());

  if (loading) return <LoadingState label="Loading template…" />;
  if (error) {
    return (
      <ErrorState
        error={error.message}
        action={<button type="button" className="shell-action" onClick={() => void refetch()}>Retry</button>}
      />
    );
  }

  const template = data?.templates.find((t) => t.id === templateId);

  if (!template) {
    return (
      <EmptyState
        title="Template not found"
        description={`No template with id "${templateId}" exists.`}
        actions={
          <Link to={base} className="shell-action shell-action--cta">
            Back to templates
          </Link>
        }
      />
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link to={base} className="text-sm text-primary hover:underline">← Templates</Link>
        <h2 className="mt-2 flex items-center gap-2 text-xl font-semibold">
          <FileText className="h-5 w-5" />
          {template.id}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">Read-only template summary (no manifest detail API).</p>
      </div>

      <dl className="surface-panel grid gap-4 p-4 text-sm sm:grid-cols-2">
        <Field label="Description" value={template.description || '—'} className="sm:col-span-2" />
        {template.whenToUse ? <Field label="When to use" value={template.whenToUse} className="sm:col-span-2" /> : null}
        {template.builtin ? <Field label="Built-in" value={template.builtin} /> : null}
        {template.driftStatus ? <Field label="Drift status" value={template.driftStatus} /> : null}
        {template.stageIds && template.stageIds.length > 0 ? (
          <div className="sm:col-span-2">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Stage IDs</dt>
            <dd className="mt-1 flex flex-wrap gap-1">
              {template.stageIds.map((id) => (
                <code key={id} className="rounded bg-muted px-1.5 py-0.5 text-xs">{id}</code>
              ))}
            </dd>
          </div>
        ) : null}
        {template.filePaths && template.filePaths.length > 0 ? (
          <div className="sm:col-span-2">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">File paths</dt>
            <dd className="mt-1 space-y-1 font-mono text-xs text-muted-foreground">
              {template.filePaths.map((path) => (
                <div key={path}>{path}</div>
              ))}
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

function Field({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className={className}>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-foreground">{value}</dd>
    </div>
  );
}
