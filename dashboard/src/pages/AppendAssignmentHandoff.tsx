import { useParams } from 'react-router-dom';
import { AppendEntryPage } from '../components/AppendEntryPage';
import { useWorkspacePrefix } from '../hooks/useMissions';

export function AppendAssignmentHandoff() {
  const { slug, aslug } = useParams<{ slug: string; aslug: string }>();
  const wsPrefix = useWorkspacePrefix();
  const missionSlug = slug ?? '';
  const assignmentSlug = aslug ?? '';

  return (
    <AppendEntryPage
      loadUrl={`/api/missions/${missionSlug}/assignments/${assignmentSlug}/handoff/edit`}
      saveUrl={`/api/missions/${missionSlug}/assignments/${assignmentSlug}/handoff/entries`}
      redirectTo={`${wsPrefix}/missions/${missionSlug}/assignments/${assignmentSlug}?tab=handoff`}
      title="Append Handoff Entry"
      description="Add a new handoff without rewriting previous history."
      helpTitle="Append-only handoff history"
      helpBody="Handoff log entries preserve the baton-passing trail between sessions and agents. Add a new entry instead of editing older ones."
    />
  );
}
