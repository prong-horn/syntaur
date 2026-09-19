import { describe, expect, it } from 'vitest';
import { resolveTicketFileEditor } from '../ticketEditorRoutes';
import type { TicketTemplateFileDetail } from '../../../data/types';

const file: TicketTemplateFileDetail = {
  path: 'plans/plan-v2.md',
  role: 'plan',
  writer: 'agent',
  description: 'Current plan',
  state: 'approved',
  exists: true,
  createOn: 'planning',
  body: 'Plan',
};

describe('manifest-derived file editors', () => {
  it('opens the plan role at its actual path', () => {
    const editor = resolveTicketFileEditor('T/1', file);
    expect(editor?.loadUrl).toBe('/api/tickets/T%2F1/plan/edit');
    expect(editor?.redirectTo).toBe('/t/T%2F1?tab=file%3Aplans%2Fplan-v2.md');
  });

  it('does not offer an editor for CLI-owned files', () => {
    expect(resolveTicketFileEditor('T-1', { ...file, writer: 'cli' })).toBeNull();
  });
});
