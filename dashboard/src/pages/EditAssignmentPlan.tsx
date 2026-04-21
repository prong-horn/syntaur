import { useParams } from 'react-router-dom';
import { DocumentEditorPage } from '../components/DocumentEditorPage';
import { useWorkspacePrefix } from '../hooks/useProjects';

export function EditAssignmentPlan() {
  const { slug, aslug, id } = useParams<{ slug?: string; aslug?: string; id?: string }>();
  const wsPrefix = useWorkspacePrefix();
  const isStandalone = Boolean(id);
  const loadUrl = isStandalone
    ? `/api/assignments/${id}/plan/edit`
    : `/api/projects/${slug}/assignments/${aslug}/plan/edit`;
  const saveUrl = isStandalone
    ? `/api/assignments/${id}/plan`
    : `/api/projects/${slug}/assignments/${aslug}/plan`;
  const redirectTo = isStandalone
    ? `/assignments/${id}?tab=plan`
    : `${wsPrefix}/projects/${slug}/assignments/${aslug}?tab=plan`;

  return (
    <DocumentEditorPage
      loadUrl={loadUrl}
      saveUrl={saveUrl}
      redirectTo={redirectTo}
      title="Edit Plan"
      description="Plans are separate from assignment status, so keep implementation steps here instead of overloading the assignment body."
      documentType="plan"
      helpTitle="Plan status is separate"
      helpBody="Plan status tracks the plan document itself. It does not replace the assignment lifecycle state."
    />
  );
}
