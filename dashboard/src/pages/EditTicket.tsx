import { useParams } from 'react-router-dom';
import { DocumentEditorPage } from '../components/DocumentEditorPage';
import { ticketPageHref } from '../lib/routes';

export function EditTicket() {
  const { id } = useParams<{ id: string }>();

  return (
    <DocumentEditorPage
      loadUrl={`/api/tickets/${id}/edit`}
      saveUrl={`/api/tickets/${id}`}
      redirectTo={ticketPageHref(id!)}
      title="Edit Ticket"
      description="Edit ticket fields including status, priority, assignee, dependencies, and body."
      documentType="ticket"
      helpTitle="Ticket editing"
      helpBody="All fields are editable. Status can also be changed through lifecycle actions or kanban drag."
    />
  );
}
