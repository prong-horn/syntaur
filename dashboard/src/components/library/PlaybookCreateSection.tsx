import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MarkdownEditor } from '../MarkdownEditor';
import { LoadingState } from '../LoadingState';
import { ErrorState } from '../ErrorState';
import { createPlaybook, fetchNewPlaybookTemplate } from '../../data/libraryResources';
import { errorMessage, isApiError } from '../../data/client';

export interface PlaybookCreateSectionProps {
  linkPrefix?: string;
}

export function PlaybookCreateSection({ linkPrefix = '/library/playbooks' }: PlaybookCreateSectionProps) {
  const base = linkPrefix.replace(/\/$/, '');
  const navigate = useNavigate();
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchNewPlaybookTemplate()
      .then((text) => {
        setContent(text);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, []);

  async function handleSave(markdownContent: string) {
    setSaving(true);
    setError(null);
    try {
      const payload = await createPlaybook(markdownContent);
      navigate(`${base}/${payload.slug}`);
    } catch (err) {
      setError(isApiError(err) ? errorMessage(err) : (err as Error).message);
      setSaving(false);
    }
  }

  if (loading) return <LoadingState label="Loading playbook template..." />;
  if (error && !content) return <ErrorState error={error} />;

  return (
    <MarkdownEditor
      initialContent={content || ''}
      documentType="playbook"
      mode="create"
      onSave={handleSave}
      saving={saving}
      error={error}
      title="Create Playbook"
      description="Playbooks define rules and workflows for how agents should operate."
      onCancel={() => navigate(base)}
      allowSlugEdit
    />
  );
}
