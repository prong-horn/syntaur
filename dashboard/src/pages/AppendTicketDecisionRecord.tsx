import { useParams } from 'react-router-dom';
import { AppendEntryPage } from '../components/AppendEntryPage';

export function AppendTicketDecisionRecord() {
  const { slug, aslug, id } = useParams<{ slug?: string; aslug?: string; id?: string }>();
  const isStandalone = Boolean(id);
  const loadUrl = isStandalone
    ? `/api/tickets/${id}/decision-record/edit`
    : `/api/projects/${slug}/tickets/${aslug}/decision-record/edit`;
  const saveUrl = isStandalone
    ? `/api/tickets/${id}/decision-record/entries`
    : `/api/projects/${slug}/tickets/${aslug}/decision-record/entries`;
  const redirectTo = isStandalone
    ? `/tickets/${id}?tab=decisions`
    : `/projects/${slug}/tickets/${aslug}?tab=decisions`;

  return (
    <AppendEntryPage
      loadUrl={loadUrl}
      saveUrl={saveUrl}
      redirectTo={redirectTo}
      title="Append Decision Entry"
      description="Record a new decision and rationale without editing prior entries."
      helpTitle="Append-only decision history"
      helpBody="Decision records should accumulate over time so the implementation rationale remains auditable and reviewable."
    />
  );
}
