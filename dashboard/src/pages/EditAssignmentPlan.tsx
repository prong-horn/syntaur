import { useParams } from 'react-router-dom';
import { DocumentEditorPage } from '../components/DocumentEditorPage';
import { useWorkspacePrefix } from '../hooks/useProjects';

export function EditAssignmentPlan() {
  const { slug, aslug } = useParams<{ slug: string; aslug: string }>();
  const wsPrefix = useWorkspacePrefix();
  const projectSlug = slug ?? '';
  const assignmentSlug = aslug ?? '';

  return (
    <DocumentEditorPage
      loadUrl={`/api/projects/${projectSlug}/assignments/${assignmentSlug}/plan/edit`}
      saveUrl={`/api/projects/${projectSlug}/assignments/${assignmentSlug}/plan`}
      redirectTo={`${wsPrefix}/projects/${projectSlug}/assignments/${assignmentSlug}?tab=plan`}
      title="Edit Plan"
      description="Plans are separate from assignment status, so keep implementation steps here instead of overloading the assignment body."
      documentType="plan"
      helpTitle="Plan status is separate"
      helpBody="Plan status tracks the plan document itself. It does not replace the assignment lifecycle state."
    />
  );
}
