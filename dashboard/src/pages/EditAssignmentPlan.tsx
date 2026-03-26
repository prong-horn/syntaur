import { useParams } from 'react-router-dom';
import { DocumentEditorPage } from '../components/DocumentEditorPage';

export function EditAssignmentPlan() {
  const { slug, aslug } = useParams<{ slug: string; aslug: string }>();
  const missionSlug = slug ?? '';
  const assignmentSlug = aslug ?? '';

  return (
    <DocumentEditorPage
      loadUrl={`/api/missions/${missionSlug}/assignments/${assignmentSlug}/plan/edit`}
      saveUrl={`/api/missions/${missionSlug}/assignments/${assignmentSlug}/plan`}
      redirectTo={`/missions/${missionSlug}/assignments/${assignmentSlug}?tab=plan`}
      title="Edit Plan"
      description="Plans are separate from assignment status, so keep implementation steps here instead of overloading the assignment body."
      documentType="plan"
      helpTitle="Plan status is separate"
      helpBody="Plan status tracks the plan document itself. It does not replace the assignment lifecycle state."
    />
  );
}
