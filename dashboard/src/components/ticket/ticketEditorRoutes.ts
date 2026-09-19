import { apiUrl } from '../../data/resources';
import type { TicketTemplateFileDetail } from '../../data/types';
import type { EditableDocumentType } from '../../hooks/useProjects';

export function ticketTabHref(id: string, tab?: string, extra?: Readonly<Record<string, string>>): string {
  const base = `/t/${encodeURIComponent(id)}`;
  const params = new URLSearchParams();
  if (tab) params.set('tab', tab);
  if (extra) {
    for (const [key, value] of Object.entries(extra)) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export function ticketEditQueryHref(id: string): string {
  return ticketTabHref(id, undefined, { edit: 'ticket' });
}

export function ticketFileEditQueryHref(id: string, filePath: string): string {
  return ticketTabHref(id, `file:${filePath}`, { edit: '1' });
}

export interface TicketEditorSpec {
  loadUrl: string;
  saveUrl: string;
  redirectTo: string;
  title: string;
  description?: string;
  documentType: EditableDocumentType;
  helpTitle: string;
  helpBody: string;
}

export function resolveTicketBodyEditor(id: string): TicketEditorSpec {
  return {
    loadUrl: apiUrl(['tickets', id, 'edit']),
    saveUrl: apiUrl(['tickets', id]),
    redirectTo: ticketTabHref(id),
    title: 'Edit Ticket',
    description: 'Edit ticket fields including status, priority, assignee, dependencies, and body.',
    documentType: 'ticket',
    helpTitle: 'Ticket editing',
    helpBody: 'All fields are editable. Status can also be changed through lifecycle actions or kanban drag.',
  };
}

/** Manifest-derived editor URLs; null when the file is CLI/read-only. */
export function resolveTicketFileEditor(
  id: string,
  file: TicketTemplateFileDetail,
): TicketEditorSpec | null {
  if (file.role === 'log' || file.writer === 'cli') return null;
  const section = file.role === 'plan' ? 'plan' :
    (file.role === 'notes' || file.role === 'scratchpad' ? 'scratchpad' : null);
  if (section === 'plan') {
    return {
      loadUrl: apiUrl(['tickets', id, 'plan', 'edit']),
      saveUrl: apiUrl(['tickets', id, 'plan']),
      redirectTo: ticketTabHref(id, `file:${file.path}`),
      title: 'Edit Plan',
      description:
        'Plans are separate from ticket status, so keep implementation steps here instead of overloading the ticket body.',
      documentType: 'plan',
      helpTitle: 'Plan status is separate',
      helpBody: 'Plan status tracks the plan document itself. It does not replace the ticket lifecycle state.',
    };
  }
  if (section === 'scratchpad') {
    return {
      loadUrl: apiUrl(['tickets', id, 'scratchpad', 'edit']),
      saveUrl: apiUrl(['tickets', id, 'scratchpad']),
      redirectTo: ticketTabHref(id, `file:${file.path}`),
      title: 'Edit Scratchpad',
      description: 'Scratchpad notes are informal working memory for the ticket.',
      documentType: 'scratchpad',
      helpTitle: 'Scratchpad',
      helpBody: 'Use the scratchpad for drafts and notes that do not belong in the plan or journal.',
    };
  }
  return null;
}
