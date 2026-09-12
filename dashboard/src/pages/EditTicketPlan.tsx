import { useParams } from 'react-router-dom';
import { DocumentEditorPage } from '../components/DocumentEditorPage';
import { ticketPageHref } from '../lib/routes';

export function EditTicketPlan() {
  const { id } = useParams<{ id: string }>();

  return (
    <DocumentEditorPage
      loadUrl={`/api/tickets/${id}/plan/edit`}
      saveUrl={`/api/tickets/${id}/plan`}
      redirectTo={ticketPageHref(id!, 'plan')}
      title="Edit Plan"
      description="Plans are separate from ticket status, so keep implementation steps here instead of overloading the ticket body."
      documentType="plan"
      helpTitle="Plan status is separate"
      helpBody="Plan status tracks the plan document itself. It does not replace the ticket lifecycle state."
    />
  );
}
