import { useParams } from 'react-router-dom';
import { AppendEntryPage } from '../components/AppendEntryPage';
import { ticketPageHref } from '../lib/routes';

export function AppendTicketHandoff() {
  const { id } = useParams<{ id: string }>();

  return (
    <AppendEntryPage
      loadUrl={`/api/tickets/${id}/handoff/edit`}
      saveUrl={`/api/tickets/${id}/handoff/entries`}
      redirectTo={ticketPageHref(id!, 'handoff')}
      title="Append Handoff Entry"
      description="Add a new handoff without rewriting previous history."
      helpTitle="Append-only handoff history"
      helpBody="Handoff log entries preserve the baton-passing trail between sessions and agents. Add a new entry instead of editing older ones."
    />
  );
}
