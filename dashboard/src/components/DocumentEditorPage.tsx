import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useEditableDocument, type EditableDocumentType } from '../hooks/useMissions';
import { LoadingState } from './LoadingState';
import { ErrorState } from './ErrorState';
import { MarkdownEditor } from './MarkdownEditor';

interface DocumentEditorPageProps {
  loadUrl: string;
  saveUrl: string;
  redirectTo: string;
  title: string;
  description?: string;
  documentType: Exclude<EditableDocumentType, 'handoff' | 'decision-record'>;
  helpTitle: string;
  helpBody: string;
}

export function DocumentEditorPage({
  loadUrl,
  saveUrl,
  redirectTo,
  title,
  description,
  documentType,
  helpTitle,
  helpBody,
}: DocumentEditorPageProps) {
  const navigate = useNavigate();
  const { data, loading, error } = useEditableDocument(loadUrl);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function handleSave(content: string) {
    setSaving(true);
    setSaveError(null);

    try {
      const response = await fetch(saveUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });

      const payload = await response.json();
      if (!response.ok) {
        setSaveError(payload.error || `HTTP ${response.status}`);
        setSaving(false);
        return;
      }

      navigate(redirectTo);
    } catch (mutationError) {
      setSaveError((mutationError as Error).message);
      setSaving(false);
      return;
    }

    setSaving(false);
  }

  if (loading) {
    return <LoadingState label={`Loading ${title.toLowerCase()}…`} />;
  }

  if (error || !data) {
    return <ErrorState error={error || `${title} is unavailable.`} />;
  }

  return (
    <MarkdownEditor
      initialContent={data.content}
      documentType={documentType}
      onSave={handleSave}
      saving={saving}
      error={saveError}
      title={title}
      description={description}
      onCancel={() => navigate(redirectTo)}
      helpTitle={helpTitle}
      helpBody={helpBody}
    />
  );
}
