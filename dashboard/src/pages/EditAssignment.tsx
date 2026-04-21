import { useParams } from 'react-router-dom';
import { DocumentEditorPage } from '../components/DocumentEditorPage';
import { useWorkspacePrefix } from '../hooks/useProjects';

export function EditAssignment() {
  const { slug, aslug } = useParams<{ slug: string; aslug: string }>();
  const wsPrefix = useWorkspacePrefix();
  const projectSlug = slug ?? '';
  const assignmentSlug = aslug ?? '';

  return (
    <DocumentEditorPage
      loadUrl={`/api/projects/${projectSlug}/assignments/${assignmentSlug}/edit`}
      saveUrl={`/api/projects/${projectSlug}/assignments/${assignmentSlug}`}
      redirectTo={`${wsPrefix}/projects/${projectSlug}/assignments/${assignmentSlug}`}
      title="Edit Assignment"
      description="Edit assignment fields including status, priority, assignee, dependencies, and body."
      documentType="assignment"
      helpTitle="Assignment editing"
      helpBody="All fields are editable. Status can also be changed through lifecycle actions or kanban drag."
    />
  );
}
