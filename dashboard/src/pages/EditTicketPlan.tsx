import { useParams } from 'react-router-dom';
import { DocumentEditorPage } from '../components/DocumentEditorPage';

export function EditTicketPlan() {
  const { slug, aslug, id } = useParams<{ slug?: string; aslug?: string; id?: string }>();
  const isStandalone = Boolean(id);
  const loadUrl = isStandalone
    ? `/api/tickets/${id}/plan/edit`
    : `/api/projects/${slug}/tickets/${aslug}/plan/edit`;
  const saveUrl = isStandalone
    ? `/api/tickets/${id}/plan`
    : `/api/projects/${slug}/tickets/${aslug}/plan`;
  const redirectTo = isStandalone
    ? `/tickets/${id}?tab=plan`
    : `/projects/${slug}/tickets/${aslug}?tab=plan`;

  return (
    <DocumentEditorPage
      loadUrl={loadUrl}
      saveUrl={saveUrl}
      redirectTo={redirectTo}
      title="Edit Plan"
      description="Plans are separate from ticket status, so keep implementation steps here instead of overloading the ticket body."
      documentType="plan"
      helpTitle="Plan status is separate"
      helpBody="Plan status tracks the plan document itself. It does not replace the ticket lifecycle state."
    />
  );
}
