import { useParams } from 'react-router-dom';
import { AppendEntryPage } from '../components/AppendEntryPage';
import { ticketPageHref } from '../lib/routes';

export function AppendTicketDecisionRecord() {
  const { id } = useParams<{ id: string }>();

  return (
    <AppendEntryPage
      loadUrl={`/api/tickets/${id}/decision-record/edit`}
      saveUrl={`/api/tickets/${id}/decision-record/entries`}
      redirectTo={ticketPageHref(id!, 'decisions')}
      title="Append Decision Entry"
      description="Record a new decision and rationale without editing prior entries."
      helpTitle="Append-only decision history"
      helpBody="Decision records should accumulate over time so the implementation rationale remains auditable and reviewable."
    />
  );
}
