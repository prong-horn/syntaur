import { useParams } from 'react-router-dom';
import { DocumentEditorPage } from '../components/DocumentEditorPage';

export function EditMission() {
  const { slug } = useParams<{ slug: string }>();
  const missionSlug = slug ?? '';

  return (
    <DocumentEditorPage
      loadUrl={`/api/missions/${missionSlug}/edit`}
      saveUrl={`/api/missions/${missionSlug}`}
      redirectTo={`/missions/${missionSlug}`}
      title="Edit Mission"
      description="Mission edits change the human-authored source document. The structured form stays focused on title, slug, tags, and overview content."
      documentType="mission"
      helpTitle="Editable vs derived mission fields"
      helpBody="Mission status remains derived from assignment state. If you need less common frontmatter fields, switch to raw markdown mode instead of expanding the structured form."
    />
  );
}
