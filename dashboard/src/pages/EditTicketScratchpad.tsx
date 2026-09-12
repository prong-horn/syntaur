import { useParams } from 'react-router-dom';
import { DocumentEditorPage } from '../components/DocumentEditorPage';

export function EditTicketScratchpad() {
  const { slug, aslug, id } = useParams<{ slug?: string; aslug?: string; id?: string }>();
  const isStandalone = Boolean(id);
  const loadUrl = isStandalone
    ? `/api/tickets/${id}/scratchpad/edit`
    : `/api/projects/${slug}/tickets/${aslug}/scratchpad/edit`;
  const saveUrl = isStandalone
    ? `/api/tickets/${id}/scratchpad`
    : `/api/projects/${slug}/tickets/${aslug}/scratchpad`;
  const redirectTo = isStandalone
    ? `/tickets/${id}?tab=scratchpad`
    : `/projects/${slug}/tickets/${aslug}?tab=scratchpad`;

  return (
    <DocumentEditorPage
      loadUrl={loadUrl}
      saveUrl={saveUrl}
      redirectTo={redirectTo}
      title="Edit Scratchpad"
      description="Scratchpad is the ticket’s working memory surface for notes, experiments, and temporary context."
      documentType="scratchpad"
      helpTitle="Scratchpad usage"
      helpBody="Scratchpad is for transient notes. Keep canonical objective and lifecycle data in ticket.md and any active plan files (plan.md, plan-v2.md, ...)."
    />
  );
}
