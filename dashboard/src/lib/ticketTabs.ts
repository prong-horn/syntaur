import type { TicketDetail, TicketTemplateFileDetail } from '../hooks/useProjects';

export type TicketTabKind =
  | 'summary'
  | 'chat'
  | 'template-file'
  | 'activity'
  | 'session-activity';

export interface TicketTabSpec {
  value: string;
  label: string;
  count?: number;
  /** Plan-role tabs show file state (missing/unapproved/approved/stale). */
  badge?: string;
  kind: TicketTabKind;
  file?: TicketTemplateFileDetail;
}

function tabLabelForFile(file: TicketTemplateFileDetail): string {
  return file.path.replace(/\.md$/i, '');
}

function tabCountForFile(file: TicketTemplateFileDetail): number | undefined {
  if (file.role === 'plan') return undefined;
  if (file.role === 'log') {
    const n = file.logEntries?.length ?? 0;
    return n > 0 ? n : undefined;
  }
  if (file.exists) return 1;
  return undefined;
}

function tabBadgeForFile(file: TicketTemplateFileDetail): string | undefined {
  if (file.role === 'plan') return file.state;
  return undefined;
}

/** Pure tab list: Summary, Chat, manifest file tabs, Activity, Session Activity. */
export function buildTicketTabs(
  detail: Pick<TicketDetail, 'templateBlock' | 'engagements'>,
): TicketTabSpec[] {
  const tabs: TicketTabSpec[] = [
    { value: 'summary', label: 'Summary', kind: 'summary' },
    { value: 'chat', label: 'Chat', kind: 'chat' },
  ];

  for (const file of detail.templateBlock.files) {
    tabs.push({
      value: `file:${file.path}`,
      label: tabLabelForFile(file),
      count: tabCountForFile(file),
      badge: tabBadgeForFile(file),
      kind: 'template-file',
      file,
    });
  }

  tabs.push(
    { value: 'activity', label: 'Activity', kind: 'activity' },
    {
      value: 'session-activity',
      label: 'Session Activity',
      kind: 'session-activity',
      count: detail.engagements.length > 0 ? detail.engagements.length : undefined,
    },
  );

  return tabs;
}

/** Map legacy companion paths to existing editor routes when available. */
export function templateFileEditSection(
  path: string,
): 'plan' | 'scratchpad' | 'handoff' | 'decision-record' | null {
  switch (path) {
    case 'plan.md':
      return 'plan';
    case 'scratchpad.md':
      return 'scratchpad';
    case 'handoff.md':
      return 'handoff';
    case 'decision-record.md':
      return 'decision-record';
    default:
      return null;
  }
}
