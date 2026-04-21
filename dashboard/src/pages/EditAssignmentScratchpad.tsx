import { useParams } from 'react-router-dom';
import { DocumentEditorPage } from '../components/DocumentEditorPage';
import { useWorkspacePrefix } from '../hooks/useProjects';

export function EditAssignmentScratchpad() {
  const { slug, aslug, id } = useParams<{ slug?: string; aslug?: string; id?: string }>();
  const wsPrefix = useWorkspacePrefix();
  const isStandalone = Boolean(id);
  const loadUrl = isStandalone
    ? `/api/assignments/${id}/scratchpad/edit`
    : `/api/projects/${slug}/assignments/${aslug}/scratchpad/edit`;
  const saveUrl = isStandalone
    ? `/api/assignments/${id}/scratchpad`
    : `/api/projects/${slug}/assignments/${aslug}/scratchpad`;
  const redirectTo = isStandalone
    ? `/assignments/${id}?tab=scratchpad`
    : `${wsPrefix}/projects/${slug}/assignments/${aslug}?tab=scratchpad`;

  return (
    <DocumentEditorPage
      loadUrl={loadUrl}
      saveUrl={saveUrl}
      redirectTo={redirectTo}
      title="Edit Scratchpad"
      description="Scratchpad is the assignment’s working memory surface for notes, experiments, and temporary context."
      documentType="scratchpad"
      helpTitle="Scratchpad usage"
      helpBody="Scratchpad is for transient notes. Keep canonical objective and lifecycle data in assignment.md and any active plan files (plan.md, plan-v2.md, ...)."
    />
  );
}
