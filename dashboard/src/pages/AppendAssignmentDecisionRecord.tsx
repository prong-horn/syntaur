import { useParams } from 'react-router-dom';
import { AppendEntryPage } from '../components/AppendEntryPage';
import { useWorkspacePrefix } from '../hooks/useMissions';

export function AppendAssignmentDecisionRecord() {
  const { slug, aslug } = useParams<{ slug: string; aslug: string }>();
  const wsPrefix = useWorkspacePrefix();
  const missionSlug = slug ?? '';
  const assignmentSlug = aslug ?? '';

  return (
    <AppendEntryPage
      loadUrl={`/api/missions/${missionSlug}/assignments/${assignmentSlug}/decision-record/edit`}
      saveUrl={`/api/missions/${missionSlug}/assignments/${assignmentSlug}/decision-record/entries`}
      redirectTo={`${wsPrefix}/missions/${missionSlug}/assignments/${assignmentSlug}?tab=decisions`}
      title="Append Decision Entry"
      description="Record a new decision and rationale without editing prior entries."
      helpTitle="Append-only decision history"
      helpBody="Decision records should accumulate over time so the implementation rationale remains auditable and reviewable."
    />
  );
}
