import { describe, expect, it } from 'vitest';
import { parseLegacyLibraryPath, parseLibraryPath } from '../libraryPath';

describe('libraryPath', () => {
  it('parses canonical library routes', () => {
    expect(parseLibraryPath('/library/playbooks')).toEqual({ section: 'playbooks', view: 'list' });
    expect(parseLibraryPath('/library/playbooks/create')).toEqual({ section: 'playbooks', view: 'create' });
    expect(parseLibraryPath('/library/playbooks/my-slug')).toEqual({
      section: 'playbooks',
      view: 'detail',
      slug: 'my-slug',
    });
    expect(parseLibraryPath('/library/playbooks/my-slug/edit')).toEqual({
      section: 'playbooks',
      view: 'edit',
      slug: 'my-slug',
    });
    expect(parseLibraryPath('/library/playbooks/manifest')).toEqual({
      section: 'playbooks',
      view: 'detail',
      slug: 'manifest',
    });
    expect(parseLibraryPath('/library/agents/new')).toEqual({ section: 'agents', view: 'create' });
    expect(parseLibraryPath('/library/agents/foo/edit')).toEqual({
      section: 'agents',
      view: 'edit',
      agentId: 'foo',
    });
    expect(parseLibraryPath('/library/templates/feature')).toEqual({
      section: 'templates',
      view: 'detail',
      templateId: 'feature',
    });
  });

  it('parses legacy playbook paths', () => {
    expect(parseLegacyLibraryPath('/playbooks/create')).toEqual({ section: 'playbooks', view: 'create' });
    expect(parseLegacyLibraryPath('/playbooks/new')).toEqual({
      section: 'playbooks',
      view: 'detail',
      slug: 'new',
    });
  });
});
