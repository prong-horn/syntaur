import { useParams } from 'react-router-dom';
import { DocumentEditorPage } from '../components/DocumentEditorPage';
import { useWorkspacePrefix } from '../hooks/useProjects';

export function EditAssignmentScratchpad() {
  const { slug, aslug } = useParams<{ slug: string; aslug: string }>();
  const wsPrefix = useWorkspacePrefix();
  const projectSlug = slug ?? '';
  const assignmentSlug = aslug ?? '';

  return (
    <DocumentEditorPage
      loadUrl={`/api/projects/${projectSlug}/assignments/${assignmentSlug}/scratchpad/edit`}
      saveUrl={`/api/projects/${projectSlug}/assignments/${assignmentSlug}/scratchpad`}
      redirectTo={`${wsPrefix}/projects/${projectSlug}/assignments/${assignmentSlug}?tab=scratchpad`}
      title="Edit Scratchpad"
      description="Scratchpad is the assignment’s working memory surface for notes, experiments, and temporary context."
      documentType="scratchpad"
      helpTitle="Scratchpad usage"
      helpBody="Scratchpad is for transient notes. Keep canonical objective and lifecycle data in assignment.md and any active plan files (plan.md, plan-v2.md, ...)."
    />
  );
}
