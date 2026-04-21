import { useParams } from 'react-router-dom';
import { AppendEntryPage } from '../components/AppendEntryPage';
import { useWorkspacePrefix } from '../hooks/useProjects';

export function AppendAssignmentHandoff() {
  const { slug, aslug, id } = useParams<{ slug?: string; aslug?: string; id?: string }>();
  const wsPrefix = useWorkspacePrefix();
  const isStandalone = Boolean(id);
  const loadUrl = isStandalone
    ? `/api/assignments/${id}/handoff/edit`
    : `/api/projects/${slug}/assignments/${aslug}/handoff/edit`;
  const saveUrl = isStandalone
    ? `/api/assignments/${id}/handoff/entries`
    : `/api/projects/${slug}/assignments/${aslug}/handoff/entries`;
  const redirectTo = isStandalone
    ? `/assignments/${id}?tab=handoff`
    : `${wsPrefix}/projects/${slug}/assignments/${aslug}?tab=handoff`;

  return (
    <AppendEntryPage
      loadUrl={loadUrl}
      saveUrl={saveUrl}
      redirectTo={redirectTo}
      title="Append Handoff Entry"
      description="Add a new handoff without rewriting previous history."
      helpTitle="Append-only handoff history"
      helpBody="Handoff log entries preserve the baton-passing trail between sessions and agents. Add a new entry instead of editing older ones."
    />
  );
}
