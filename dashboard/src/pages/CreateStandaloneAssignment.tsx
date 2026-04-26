import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { MarkdownEditor } from '../components/MarkdownEditor';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { useWorkspacePrefix } from '../hooks/useProjects';

export function CreateStandaloneAssignment() {
  const { workspace } = useParams<{ workspace?: string }>();
  const wsPrefix = useWorkspacePrefix();
  const navigate = useNavigate();
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams({ standalone: '1' });
    if (workspace) {
      params.set('workspace', workspace);
    }
    fetch(`/api/templates/assignment?${params.toString()}`)
      .then((response) => response.json())
      .then((payload) => {
        setContent(payload.content);
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
      const response = await fetch('/api/assignments', {
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

      const newId = payload?.assignment?.id;
      if (!newId) {
        setError('Server did not return the new assignment id.');
        setSaving(false);
        return;
      }
      // Standalone detail route is unscoped (`/assignments/:id`), even when
      // reached from a workspace-scoped page — there is no `/w/<ws>/assignments/:id` route.
      navigate(`/assignments/${newId}`);
    } catch (saveError) {
      setError((saveError as Error).message);
      setSaving(false);
      return;
    }

    setSaving(false);
  }

  if (loading) {
    return <LoadingState label="Loading assignment template…" />;
  }

  if (error && !content) {
    return <ErrorState error={error} />;
  }

  return (
    <MarkdownEditor
      initialContent={content || ''}
      documentType="assignment"
      mode="create"
      onSave={handleSave}
      saving={saving}
      error={error}
      title="Create Standalone Assignment"
      description={
        workspace
          ? `Standalone assignments live outside any project. This one will be tagged with workspaceGroup: ${workspace} so it appears in this workspace's views.`
          : 'Standalone assignments live outside any project. Add a workspaceGroup to make them appear in workspace-filtered views.'
      }
      onCancel={() => navigate(`${wsPrefix}/assignments`)}
      helpTitle="Standalone assignment editing rules"
      helpBody="No project field is needed (it must remain null). Use workspaceGroup to group with other workspace work. Status, priority, and tags work the same as project-nested assignments."
      allowSlugEdit
    />
  );
}
