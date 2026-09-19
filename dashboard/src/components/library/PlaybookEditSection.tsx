import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MarkdownEditor } from '../MarkdownEditor';
import { LoadingState } from '../LoadingState';
import { ErrorState } from '../ErrorState';
import { fetchPlaybookEditContent, savePlaybookContent } from '../../data/libraryResources';
import { errorMessage, isApiError } from '../../data/client';

export interface PlaybookEditSectionProps {
  slug: string;
  linkPrefix?: string;
}

export function PlaybookEditSection({ slug, linkPrefix = '/library/playbooks' }: PlaybookEditSectionProps) {
  const base = linkPrefix.replace(/\/$/, '');
  const navigate = useNavigate();
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchPlaybookEditContent(slug)
      .then((text) => {
        setContent(text);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [slug]);

  async function handleSave(markdownContent: string) {
    setSaving(true);
    setError(null);
    try {
      await savePlaybookContent(slug, markdownContent);
      navigate(`${base}/${slug}`);
    } catch (err) {
      setError(isApiError(err) ? errorMessage(err) : (err as Error).message);
      setSaving(false);
    }
  }

  if (loading) return <LoadingState label="Loading playbook..." />;
  if (error && !content) return <ErrorState error={error} />;

  return (
    <MarkdownEditor
      initialContent={content || ''}
      documentType="playbook"
      mode="edit"
      onSave={handleSave}
      saving={saving}
      error={error}
      title="Edit Playbook"
      onCancel={() => navigate(`${base}/${slug}`)}
    />
  );
}
