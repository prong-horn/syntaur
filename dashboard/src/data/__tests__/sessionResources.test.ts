import { describe, expect, it } from 'vitest';
import { sessionsList, workspaceUsage } from '../sessionResources';

describe('sessionResources', () => {
  it('sessionsList delegates to canonical agent-sessions URL', () => {
    const resource = sessionsList({ page: 0, pageSize: 50, search: 'abc' });
    expect(resource.url).toContain('/api/agent-sessions');
    expect(resource.url).toContain('search=abc');
    expect(resource.tags).toContain('sessions');
  });

  it('workspaceUsage includes groupBy in cache key', () => {
    const a = workspaceUsage({ window: '30d' }, 'project');
    const b = workspaceUsage({ window: '30d' }, 'ticket');
    expect(a.url).not.toBe(b.url);
    expect(b.url).toContain('groupBy=ticket');
    expect(a.tags).toContain('usage');
  });
});
