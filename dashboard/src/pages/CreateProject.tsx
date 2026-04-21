import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useWorkspacePrefix } from '../hooks/useProjects';
import { MarkdownEditor } from '../components/MarkdownEditor';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';

export function CreateProject() {
  const navigate = useNavigate();
  const { workspace } = useParams<{ workspace?: string }>();
  const wsPrefix = useWorkspacePrefix();
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/templates/project')
      .then((response) => response.json())
      .then((payload) => {
        let templateContent = payload.content as string;
        if (workspace && workspace !== '_ungrouped') {
          templateContent = templateContent.replace(
            /^(tags: \[\])$/m,
            `$1\nworkspace: ${workspace}`,
          );
        }
        setContent(templateContent);
        setLoading(false);
      })
      .catch((loadError: Error) => {
        setError(loadError.message);
        setLoading(false);
      });
  }, [workspace]);

  async function handleSave(markdownContent: string) {
    setSaving(true);
    setError(null);

    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: markdownContent }),
      });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload.error || `HTTP ${response.status}`);
        setSaving(false);
        return;
      }

      navigate(`${wsPrefix}/projects/${payload.slug}`);
    } catch (saveError) {
      setError((saveError as Error).message);
      setSaving(false);
      return;
    }

    setSaving(false);
  }

  if (loading) {
    return <LoadingState label="Loading project template…" />;
  }

  if (error && !content) {
    return <ErrorState error={error} />;
  }

  return (
    <MarkdownEditor
      initialContent={content || ''}
      documentType="project"
      mode="create"
      onSave={handleSave}
      saving={saving}
      error={error}
      title="Create Project"
      description="Projects hold the high-level objective, shared context, and human-authored overview. Put execution details in assignments instead of overloading project.md."
      onCancel={() => navigate(`${wsPrefix}/projects`)}
      helpTitle="Project editing rules"
      helpBody="Use this form for project intent, slug, tags, and overview content. If you ever need less common metadata, raw markdown mode still exposes the full file."
      allowSlugEdit
    />
  );
}
