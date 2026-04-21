import { useParams } from 'react-router-dom';
import { AppendEntryPage } from '../components/AppendEntryPage';
import { useWorkspacePrefix } from '../hooks/useProjects';

export function AppendAssignmentHandoff() {
  const { slug, aslug } = useParams<{ slug: string; aslug: string }>();
  const wsPrefix = useWorkspacePrefix();
  const projectSlug = slug ?? '';
  const assignmentSlug = aslug ?? '';

  return (
    <AppendEntryPage
      loadUrl={`/api/projects/${projectSlug}/assignments/${assignmentSlug}/handoff/edit`}
      saveUrl={`/api/projects/${projectSlug}/assignments/${assignmentSlug}/handoff/entries`}
      redirectTo={`${wsPrefix}/projects/${projectSlug}/assignments/${assignmentSlug}?tab=handoff`}
      title="Append Handoff Entry"
      description="Add a new handoff without rewriting previous history."
      helpTitle="Append-only handoff history"
      helpBody="Handoff log entries preserve the baton-passing trail between sessions and agents. Add a new entry instead of editing older ones."
    />
  );
}
