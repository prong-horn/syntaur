import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useWorkspacePrefix } from '../hooks/useMissions';
import { MarkdownEditor } from '../components/MarkdownEditor';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';

export function CreateMission() {
  const navigate = useNavigate();
  const { workspace } = useParams<{ workspace?: string }>();
  const wsPrefix = useWorkspacePrefix();
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/templates/mission')
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
      const response = await fetch('/api/missions', {
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

      navigate(`${wsPrefix}/missions/${payload.slug}`);
    } catch (saveError) {
      setError((saveError as Error).message);
      setSaving(false);
      return;
    }

    setSaving(false);
  }

  if (loading) {
    return <LoadingState label="Loading mission template…" />;
  }

  if (error && !content) {
    return <ErrorState error={error} />;
  }

  return (
    <MarkdownEditor
      initialContent={content || ''}
      documentType="mission"
      mode="create"
      onSave={handleSave}
      saving={saving}
      error={error}
      title="Create Mission"
      description="Missions hold the high-level objective, shared context, and human-authored overview. Put execution details in assignments instead of overloading mission.md."
      onCancel={() => navigate(`${wsPrefix}/missions`)}
      helpTitle="Mission editing rules"
      helpBody="Use this form for mission intent, slug, tags, and overview content. If you ever need less common metadata, raw markdown mode still exposes the full file."
      allowSlugEdit
    />
  );
}
