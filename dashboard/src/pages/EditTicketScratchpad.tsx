import { useParams } from 'react-router-dom';
import { DocumentEditorPage } from '../components/DocumentEditorPage';
import { ticketPageHref } from '../lib/routes';

export function EditTicketScratchpad() {
  const { id } = useParams<{ id: string }>();

  return (
    <DocumentEditorPage
      loadUrl={`/api/tickets/${id}/scratchpad/edit`}
      saveUrl={`/api/tickets/${id}/scratchpad`}
      redirectTo={ticketPageHref(id!, 'scratchpad')}
      title="Edit Scratchpad"
      description="Scratchpad notes are private working memory and do not affect ticket status."
      documentType="scratchpad"
      helpTitle="Scratchpad is working memory"
      helpBody="Use the scratchpad for drafts, open questions, and intermediate notes. It is not part of the handoff record."
    />
  );
}
