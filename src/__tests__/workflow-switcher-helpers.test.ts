import { describe, it, expect } from 'vitest';
import {
  workflowApiBase,
  affectedEndpoint,
  validateNewWorkflowId,
  canDeleteWorkflow,
  nextWorkflowAfterDelete,
} from '../../dashboard/src/pages/workflow-switcher-helpers';

describe('workflow-switcher-helpers', () => {
  it('routes default to the legacy statuses path and others to /workflows/:id', () => {
    expect(workflowApiBase('default')).toBe('/api/config/statuses');
    expect(workflowApiBase('bug')).toBe('/api/config/workflows/bug');
    expect(workflowApiBase('a b')).toBe('/api/config/workflows/a%20b');
  });

  it('builds the affected endpoint per workflow', () => {
    expect(affectedEndpoint('default', 'in_progress')).toBe(
      '/api/config/statuses/affected/in_progress',
    );
    expect(affectedEndpoint('bug', 'open')).toBe('/api/config/workflows/bug/affected/open');
  });

  it('validates new workflow ids', () => {
    expect(validateNewWorkflowId('bug', ['default'])).toBeNull();
    expect(validateNewWorkflowId('', ['default'])).toMatch(/enter/i);
    expect(validateNewWorkflowId('Bad Id!', ['default'])).toMatch(/letters/i);
    expect(validateNewWorkflowId('x'.repeat(65), ['default'])).toMatch(/long/i);
    expect(validateNewWorkflowId('default', ['default'])).toMatch(/already exists/i);
    expect(validateNewWorkflowId('  bug  ', ['default'])).toBeNull(); // trims
  });

  it('protects the default from deletion', () => {
    expect(canDeleteWorkflow('default')).toBe(false);
    expect(canDeleteWorkflow('bug')).toBe(true);
  });

  it('selects the next workflow after a delete', () => {
    expect(nextWorkflowAfterDelete('bug', ['default', 'bug', 'chore'], 'default')).toBe('default');
    // deleting the current global default → fall to first remaining
    expect(nextWorkflowAfterDelete('bug', ['bug', 'chore'], 'bug')).toBe('chore');
    expect(nextWorkflowAfterDelete('only', ['only'], 'only')).toBe('default');
  });
});
