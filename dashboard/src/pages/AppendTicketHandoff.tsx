import { useParams } from 'react-router-dom';
import { AppendEntryPage } from '../components/AppendEntryPage';

export function AppendTicketHandoff() {
  const { slug, aslug, id } = useParams<{ slug?: string; aslug?: string; id?: string }>();
  const isStandalone = Boolean(id);
  const loadUrl = isStandalone
    ? `/api/tickets/${id}/handoff/edit`
    : `/api/projects/${slug}/tickets/${aslug}/handoff/edit`;
  const saveUrl = isStandalone
    ? `/api/tickets/${id}/handoff/entries`
    : `/api/projects/${slug}/tickets/${aslug}/handoff/entries`;
  const redirectTo = isStandalone
    ? `/tickets/${id}?tab=handoff`
    : `/projects/${slug}/tickets/${aslug}?tab=handoff`;

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
