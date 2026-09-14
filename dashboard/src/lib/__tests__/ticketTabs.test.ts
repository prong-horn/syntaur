import { describe, it, expect } from 'vitest';
import { buildTicketTabs } from '../ticketTabs';
import type { TicketDetail, TicketTemplateFileDetail } from '../../hooks/useProjects';

function file(overrides: Partial<TicketTemplateFileDetail> & Pick<TicketTemplateFileDetail, 'path' | 'role'>): TicketTemplateFileDetail {
  return {
    writer: 'agent',
    description: 'desc',
    state: 'editable',
    exists: true,
    createOn: 'ticket-creation',
    body: 'body',
    ...overrides,
  };
}

function detail(
  templateId: string,
  files: TicketTemplateFileDetail[],
): Pick<TicketDetail, 'templateBlock' | 'engagements'> {
  return {
    templateBlock: { id: templateId, files },
    engagements: [],
  };
}

describe('buildTicketTabs', () => {
  it('feature template lists journal and plan tabs between chat and activity', () => {
    const tabs = buildTicketTabs(
      detail('feature', [
        file({ path: 'journal.md', role: 'log', logEntries: [{ timestamp: 't', type: 'progress', author: 'a', firstLine: 'x', body: 'x' }] }),
        file({ path: 'plan.md', role: 'plan', createOn: 'planning', state: 'approved', planStatus: 'approved' }),
      ]),
    );
    expect(tabs.map((t) => t.label)).toEqual([
      'Summary',
      'Chat',
      'journal',
      'plan',
      'Activity',
      'Session Activity',
    ]);
    expect(tabs.find((t) => t.value === 'file:journal.md')?.count).toBe(1);
    expect(tabs.find((t) => t.value === 'file:plan.md')?.badge).toBe('approved');
    expect(tabs.find((t) => t.value === 'file:plan.md')?.count).toBeUndefined();
  });

  it('quick template has no file tabs', () => {
    const tabs = buildTicketTabs(detail('quick', []));
    expect(tabs.map((t) => t.label)).toEqual([
      'Summary',
      'Chat',
      'Activity',
      'Session Activity',
    ]);
  });

  it('legacy template lists all six companion files', () => {
    const legacyFiles = [
      'scratchpad.md',
      'handoff.md',
      'decision-record.md',
      'progress.md',
      'comments.md',
      'plan.md',
    ].map((path) =>
      file({
        path,
        role: path === 'plan.md' ? 'plan' : path === 'progress.md' ? 'log' : path === 'scratchpad.md' ? 'notes' : 'plain',
        exists: path !== 'plan.md',
        state: path === 'plan.md' ? 'missing' : 'present',
        createOn: path === 'plan.md' ? 'planning' : 'ticket-creation',
      }),
    );
    const tabs = buildTicketTabs(detail('legacy', legacyFiles));
    expect(tabs.filter((t) => t.kind === 'template-file').map((t) => t.label)).toEqual([
      'scratchpad',
      'handoff',
      'decision-record',
      'progress',
      'comments',
      'plan',
    ]);
    const planTab = tabs.find((t) => t.value === 'file:plan.md');
    expect(planTab?.file?.exists).toBe(false);
    expect(planTab?.file?.createOn).toBe('planning');
  });
});
