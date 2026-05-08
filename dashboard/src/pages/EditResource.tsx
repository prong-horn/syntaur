import { useParams } from 'react-router-dom';
import { DocumentEditorPage } from '../components/DocumentEditorPage';

export function EditResource() {
  const { slug, itemSlug } = useParams<{ slug: string; itemSlug: string }>();

  return (
    <DocumentEditorPage
      loadUrl={`/api/projects/${slug}/resources/${itemSlug}/edit`}
      saveUrl={`/api/projects/${slug}/resources/${itemSlug}`}
      redirectTo={`/projects/${slug}/resources/${itemSlug}`}
      title="Edit Resource"
      description="Edit the body. The frontmatter (name, category, source, related assignments) is preserved unchanged on save."
      documentType="resource"
      helpTitle="Resource editing"
      helpBody="Resource edits are body-only. Frontmatter changes from the editor are ignored server-side; the file's existing frontmatter is preserved and `updated` is bumped automatically."
    />
  );
}
