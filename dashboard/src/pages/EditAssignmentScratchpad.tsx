import { useParams } from 'react-router-dom';
import { DocumentEditorPage } from '../components/DocumentEditorPage';

export function EditAssignmentScratchpad() {
  const { slug, aslug } = useParams<{ slug: string; aslug: string }>();
  const missionSlug = slug ?? '';
  const assignmentSlug = aslug ?? '';

  return (
    <DocumentEditorPage
      loadUrl={`/api/missions/${missionSlug}/assignments/${assignmentSlug}/scratchpad/edit`}
      saveUrl={`/api/missions/${missionSlug}/assignments/${assignmentSlug}/scratchpad`}
      redirectTo={`/missions/${missionSlug}/assignments/${assignmentSlug}?tab=scratchpad`}
      title="Edit Scratchpad"
      description="Scratchpad is the assignment’s working memory surface for notes, experiments, and temporary context."
      documentType="scratchpad"
      helpTitle="Scratchpad usage"
      helpBody="Scratchpad is for transient notes. Keep canonical objective and lifecycle data in assignment.md and plan.md."
    />
  );
}
