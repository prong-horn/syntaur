import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useEditableDocument, type EditableDocumentType } from '../hooks/useProjects';
import { mutate } from '../data/mutate';
import { projectWriteTargets, ticketWriteTargets } from '../data/resources';
import { LoadingState } from './LoadingState';
import { ErrorState } from './ErrorState';
import { MarkdownEditor } from './MarkdownEditor';

interface DocumentEditorPageProps {
  loadUrl: string;
  saveUrl: string;
  redirectTo: string;
  title: string;
  description?: string;
  documentType: EditableDocumentType;
  helpTitle: string;
  helpBody: string;
  /** When set, called after a successful save instead of navigating to redirectTo. */
  onSaved?: () => void;
  /** When set, called instead of navigating on cancel. */
  onCancel?: () => void;
}

function invalidationForSaveUrl(saveUrl: string, loadUrl: string): ReturnType<typeof ticketWriteTargets> {
  const projectMatch = saveUrl.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch) return projectWriteTargets(projectMatch[1]);
  const ticketMatch = loadUrl.match(/^\/api\/tickets\/([^/]+)/);
  if (ticketMatch) return ticketWriteTargets(ticketMatch[1]);
  return [];
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
  onSaved,
  onCancel,
}: DocumentEditorPageProps) {
  const navigate = useNavigate();
  const { data, loading, error } = useEditableDocument(loadUrl);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function handleSave(content: string) {
    setSaving(true);
    setSaveError(null);

    try {
      await mutate('PATCH', saveUrl, { content }, {
        invalidates: invalidationForSaveUrl(saveUrl, loadUrl),
      });
      if (onSaved) onSaved();
      else navigate(redirectTo);
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
      onCancel={() => {
        if (onCancel) onCancel();
        else navigate(redirectTo);
      }}
      helpTitle={helpTitle}
      helpBody={helpBody}
    />
  );
}
