import { useParams } from 'react-router-dom';
import { DocumentEditorPage } from '../components/DocumentEditorPage';

export function EditTicket() {
  const { slug, aslug, id } = useParams<{ slug?: string; aslug?: string; id?: string }>();

  const isStandalone = Boolean(id);
  const loadUrl = isStandalone
    ? `/api/tickets/${id}/edit`
    : `/api/projects/${slug}/tickets/${aslug}/edit`;
  const saveUrl = isStandalone
    ? `/api/tickets/${id}`
    : `/api/projects/${slug}/tickets/${aslug}`;
  const redirectTo = isStandalone
    ? `/tickets/${id}`
    : `/projects/${slug}/tickets/${aslug}`;

  return (
    <DocumentEditorPage
      loadUrl={loadUrl}
      saveUrl={saveUrl}
      redirectTo={redirectTo}
      title="Edit Ticket"
      description="Edit ticket fields including status, priority, assignee, dependencies, and body."
      documentType="ticket"
      helpTitle="Ticket editing"
      helpBody="All fields are editable. Status can also be changed through lifecycle actions or kanban drag."
    />
  );
}
