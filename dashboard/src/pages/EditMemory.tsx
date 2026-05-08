import { useParams } from 'react-router-dom';
import { DocumentEditorPage } from '../components/DocumentEditorPage';

export function EditMemory() {
  const { slug, itemSlug } = useParams<{ slug: string; itemSlug: string }>();

  return (
    <DocumentEditorPage
      loadUrl={`/api/projects/${slug}/memories/${itemSlug}/edit`}
      saveUrl={`/api/projects/${slug}/memories/${itemSlug}`}
      redirectTo={`/projects/${slug}/memories/${itemSlug}`}
      title="Edit Memory"
      description="Edit the body. The frontmatter (name, scope, source, related assignments) is preserved unchanged on save."
      documentType="memory"
      helpTitle="Memory editing"
      helpBody="Memory edits are body-only. Frontmatter changes from the editor are ignored server-side; the file's existing frontmatter is preserved and `updated` is bumped automatically."
    />
  );
}
