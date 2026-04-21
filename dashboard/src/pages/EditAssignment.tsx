import { useParams } from 'react-router-dom';
import { DocumentEditorPage } from '../components/DocumentEditorPage';
import { useWorkspacePrefix } from '../hooks/useProjects';

export function EditAssignment() {
  const { slug, aslug, id } = useParams<{ slug?: string; aslug?: string; id?: string }>();
  const wsPrefix = useWorkspacePrefix();

  const isStandalone = Boolean(id);
  const loadUrl = isStandalone
    ? `/api/assignments/${id}/edit`
    : `/api/projects/${slug}/assignments/${aslug}/edit`;
  const saveUrl = isStandalone
    ? `/api/assignments/${id}`
    : `/api/projects/${slug}/assignments/${aslug}`;
  const redirectTo = isStandalone
    ? `/assignments/${id}`
    : `${wsPrefix}/projects/${slug}/assignments/${aslug}`;

  return (
    <DocumentEditorPage
      loadUrl={loadUrl}
      saveUrl={saveUrl}
      redirectTo={redirectTo}
      title="Edit Assignment"
      description="Edit assignment fields including status, priority, assignee, dependencies, and body."
      documentType="assignment"
      helpTitle="Assignment editing"
      helpBody="All fields are editable. Status can also be changed through lifecycle actions or kanban drag."
    />
  );
}
