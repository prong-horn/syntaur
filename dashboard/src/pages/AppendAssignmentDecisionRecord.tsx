import { useParams } from 'react-router-dom';
import { AppendEntryPage } from '../components/AppendEntryPage';
import { useWorkspacePrefix } from '../hooks/useProjects';

export function AppendAssignmentDecisionRecord() {
  const { slug, aslug, id } = useParams<{ slug?: string; aslug?: string; id?: string }>();
  const wsPrefix = useWorkspacePrefix();
  const isStandalone = Boolean(id);
  const loadUrl = isStandalone
    ? `/api/assignments/${id}/decision-record/edit`
    : `/api/projects/${slug}/assignments/${aslug}/decision-record/edit`;
  const saveUrl = isStandalone
    ? `/api/assignments/${id}/decision-record/entries`
    : `/api/projects/${slug}/assignments/${aslug}/decision-record/entries`;
  const redirectTo = isStandalone
    ? `/assignments/${id}?tab=decisions`
    : `${wsPrefix}/projects/${slug}/assignments/${aslug}?tab=decisions`;

  return (
    <AppendEntryPage
      loadUrl={loadUrl}
      saveUrl={saveUrl}
      redirectTo={redirectTo}
      title="Append Decision Entry"
      description="Record a new decision and rationale without editing prior entries."
      helpTitle="Append-only decision history"
      helpBody="Decision records should accumulate over time so the implementation rationale remains auditable and reviewable."
    />
  );
}
