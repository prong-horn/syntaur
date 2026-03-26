import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { MarkdownEditor } from '../components/MarkdownEditor';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';

export function CreateAssignment() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/templates/assignment')
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
    if (!slug) {
      setError('Mission slug is required.');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const response = await fetch(`/api/missions/${slug}/assignments`, {
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

      navigate(`/missions/${slug}/assignments/${payload.slug}`);
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
      onSave={handleSave}
      saving={saving}
      error={error}
      title="Create Assignment"
      description="Assignments are the execution unit. Declare dependencies here, keep status pending until work starts, and use blocked later only for runtime obstacles."
      onCancel={() => navigate(slug ? `/missions/${slug}` : '/missions')}
      helpTitle="Assignment editing rules"
      helpBody="Use structured fields for priority, assignee, dependencies, and tags. Status can be changed through lifecycle actions, kanban drag, or the status override."
      allowSlugEdit
    />
  );
}
