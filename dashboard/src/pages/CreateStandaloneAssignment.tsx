import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MarkdownEditor } from '../components/MarkdownEditor';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';

export function CreateStandaloneAssignment() {
  const navigate = useNavigate();
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/templates/assignment?standalone=1')
      .then((response) => response.json())
      .then((payload) => {
        setContent(payload.content);
        setLoading(false);
      })
      .catch((loadError: Error) => {
        setError(loadError.message);
        setLoading(false);
      });
  }, []);

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
      description="Standalone assignments live outside any project."
      onCancel={() => navigate('/assignments')}
      helpTitle="Standalone assignment editing rules"
      helpBody="No project field is needed (it must remain null). Status, priority, and tags work the same as project-nested assignments."
      allowSlugEdit
    />
  );
}
