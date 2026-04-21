import { useParams } from 'react-router-dom';
import { DocumentEditorPage } from '../components/DocumentEditorPage';
import { useWorkspacePrefix } from '../hooks/useProjects';

export function EditProject() {
  const { slug } = useParams<{ slug: string }>();
  const wsPrefix = useWorkspacePrefix();
  const projectSlug = slug ?? '';

  return (
    <DocumentEditorPage
      loadUrl={`/api/projects/${projectSlug}/edit`}
      saveUrl={`/api/projects/${projectSlug}`}
      redirectTo={`${wsPrefix}/projects/${projectSlug}`}
      title="Edit Project"
      description="Project edits change the human-authored source document. The structured form stays focused on title, slug, tags, and overview content."
      documentType="project"
      helpTitle="Editable vs derived project fields"
      helpBody="Project status remains derived from assignment state. If you need less common frontmatter fields, switch to raw markdown mode instead of expanding the structured form."
    />
  );
}
