import { Link } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { useResource } from '../../data/useResource';
import { templatesList } from '../../data/libraryResources';
import { LoadingState } from '../LoadingState';
import { ErrorState } from '../ErrorState';
import { EmptyState } from '../EmptyState';

export interface TemplatesListSectionProps {
  linkPrefix?: string;
}

export function TemplatesListSection({ linkPrefix = '/library/templates' }: TemplatesListSectionProps) {
  const base = linkPrefix.replace(/\/$/, '');
  const { data, loading, error, refetch } = useResource(templatesList());

  if (loading) return <LoadingState label="Loading templates…" />;
  if (error) return <ErrorState error={error.message} action={<button type="button" className="shell-action" onClick={() => void refetch()}>Retry</button>} />;

  const templates = data?.templates ?? [];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-xl font-semibold">
          <FileText className="h-5 w-5" />
          Ticket templates
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Read-only summary of installed ticket templates. Editing is not available in the dashboard.
        </p>
      </div>

      {templates.length === 0 ? (
        <EmptyState title="No templates" description="No ticket templates are registered." />
      ) : (
        <ul className="divide-y divide-border/40 rounded-lg border border-border/60">
          {templates.map((template) => (
            <li key={template.id}>
              <Link
                to={`${base}/${template.id}`}
                className="flex flex-col gap-1 px-4 py-3 transition hover:bg-muted/30"
              >
                <span className="font-medium text-foreground">{template.id}</span>
                {template.description ? (
                  <span className="text-sm text-muted-foreground line-clamp-2">{template.description}</span>
                ) : null}
                {template.builtin ? (
                  <span className="text-xs text-muted-foreground">Built-in: {template.builtin}</span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
