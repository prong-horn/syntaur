import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useProjects } from '../hooks/useProjects';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';

export function CreateResource() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const presetProject = searchParams.get('project');
  const { data: projects, loading: projectsLoading, error: projectsError } = useProjects();

  const [projectSlug, setProjectSlug] = useState(presetProject ?? '');
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectSlug && projects && projects.length > 0) {
      setProjectSlug(presetProject ?? projects[0].slug);
    }
  }, [projects, presetProject, projectSlug]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!projectSlug || !name.trim()) return;
    setSaving(true);
    setError(null);

    try {
      const response = await fetch(`/api/projects/${projectSlug}/resources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), body: body || undefined }),
      });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload.error || `HTTP ${response.status}`);
        setSaving(false);
        return;
      }

      navigate(`/projects/${payload.projectSlug}/resources/${payload.slug}`);
    } catch (saveError) {
      setError((saveError as Error).message);
      setSaving(false);
    }
  }

  if (projectsLoading) return <LoadingState label="Loading projects…" />;
  if (projectsError) return <ErrorState error={projectsError} />;
  if (!projects || projects.length === 0) {
    return (
      <ErrorState error="You need at least one project before you can create a resource. Create a project from the sidebar." />
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">New Resource</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Resources are reference material — specs, requirements, links — shared across every
          assignment in a project.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="project" className="block text-sm font-medium text-foreground">
            Project
          </label>
          <select
            id="project"
            value={projectSlug}
            onChange={(e) => setProjectSlug(e.target.value)}
            className="editor-input"
            required
          >
            {projects.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.title}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="name" className="block text-sm font-medium text-foreground">
            Name
          </label>
          <input
            id="name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Auth Requirements"
            className="editor-input"
            required
            autoFocus
          />
          <p className="text-xs text-muted-foreground/80">
            The slug is auto-derived from the name. Letters, digits, and hyphens.
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="body" className="block text-sm font-medium text-foreground">
          Body
        </label>
        <textarea
          id="body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={14}
          placeholder="Write the resource body in markdown. Leave blank to start from a template."
          className="editor-input font-mono text-sm"
        />
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={saving || !name.trim() || !projectSlug}
          className="inline-flex h-9 items-center rounded-md bg-foreground px-3 text-sm font-medium text-background transition hover:bg-foreground/90 disabled:opacity-50"
        >
          {saving ? 'Creating…' : 'Create Resource'}
        </button>
        <button
          type="button"
          onClick={() => navigate('/resources')}
          className="inline-flex h-9 items-center rounded-md border border-border/70 bg-background px-3 text-sm font-medium text-foreground transition hover:bg-muted"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
