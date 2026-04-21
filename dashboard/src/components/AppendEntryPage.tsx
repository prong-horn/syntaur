import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MarkdownRenderer } from './MarkdownRenderer';
import { useEditableDocument } from '../hooks/useProjects';
import { LoadingState } from './LoadingState';
import { ErrorState } from './ErrorState';
import { SectionCard } from './SectionCard';

interface AppendEntryPageProps {
  loadUrl: string;
  saveUrl: string;
  redirectTo: string;
  title: string;
  description: string;
  helpTitle: string;
  helpBody: string;
}

export function AppendEntryPage({
  loadUrl,
  saveUrl,
  redirectTo,
  title,
  description,
  helpTitle: _helpTitle,
  helpBody: _helpBody,
}: AppendEntryPageProps) {
  const navigate = useNavigate();
  const { data, loading, error } = useEditableDocument(loadUrl);
  const [entryTitle, setEntryTitle] = useState('');
  const [entryBody, setEntryBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setSaveError(null);

    try {
      const response = await fetch(saveUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: entryTitle,
          body: entryBody,
        }),
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
    <div className="space-y-4">
      <SectionCard title={title} description={description}>
        <div className="space-y-4">
          <label className="block space-y-2">
            <span className="text-sm font-medium text-foreground">Entry title</span>
            <input
              value={entryTitle}
              onChange={(event) => setEntryTitle(event.target.value)}
              placeholder="Optional title"
              className="editor-input"
            />
          </label>
          <label className="block space-y-2">
            <span className="text-sm font-medium text-foreground">Entry body</span>
            <textarea
              value={entryBody}
              onChange={(event) => setEntryBody(event.target.value)}
              className="editor-textarea"
              spellCheck={false}
            />
          </label>
          {saveError ? (
            <p className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300">
              {saveError}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => navigate(redirectTo)} className="shell-action">
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !entryBody.trim()}
              className="shell-action bg-foreground text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? 'Appending…' : 'Append Entry'}
            </button>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Current Document">
        <MarkdownRenderer
          content={data.content.replace(/^---[\s\S]*?---\n?/, '')}
          emptyState="No existing content."
        />
      </SectionCard>
    </div>
  );
}
