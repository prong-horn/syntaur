import { useParams } from 'react-router-dom';
import { DocumentEditorPage } from '../components/DocumentEditorPage';
import { useWorkspacePrefix } from '../hooks/useMissions';

export function EditAssignment() {
  const { slug, aslug } = useParams<{ slug: string; aslug: string }>();
  const wsPrefix = useWorkspacePrefix();
  const missionSlug = slug ?? '';
  const assignmentSlug = aslug ?? '';

  return (
    <DocumentEditorPage
      loadUrl={`/api/missions/${missionSlug}/assignments/${assignmentSlug}/edit`}
      saveUrl={`/api/missions/${missionSlug}/assignments/${assignmentSlug}`}
      redirectTo={`${wsPrefix}/missions/${missionSlug}/assignments/${assignmentSlug}`}
      title="Edit Assignment"
      description="Edit assignment fields including status, priority, assignee, dependencies, and body."
      documentType="assignment"
      helpTitle="Assignment editing"
      helpBody="All fields are editable. Status can also be changed through lifecycle actions or kanban drag."
    />
  );
}
