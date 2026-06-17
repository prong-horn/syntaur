import { describe, expect, it } from 'vitest';
import { updateAssignmentWorkspace, parseAssignmentFrontmatter } from '../lifecycle/frontmatter.js';

const SAMPLE = `---
id: abc
slug: demo
title: "Demo"
project: p
status: pending
priority: medium
created: "2026-04-23T12:00:00Z"
updated: "2026-04-23T12:00:00Z"
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

Body here.
`;

describe('updateAssignmentWorkspace', () => {
  it('updates all nested fields in place', () => {
    const next = updateAssignmentWorkspace(SAMPLE, {
      repository: '/Users/x/repo',
      worktreePath: '/Users/x/repo/.worktrees/demo',
      branch: 'feature/demo',
      parentBranch: 'main',
    });
    const parsed = parseAssignmentFrontmatter(next);
    expect(parsed.workspace.repository).toBe('/Users/x/repo');
    expect(parsed.workspace.worktreePath).toBe('/Users/x/repo/.worktrees/demo');
    expect(parsed.workspace.branch).toBe('feature/demo');
    expect(parsed.workspace.parentBranch).toBe('main');
  });

  it('preserves body and other frontmatter fields', () => {
    const next = updateAssignmentWorkspace(SAMPLE, {
      branch: 'feature/x',
    });
    expect(next).toContain('Body here.');
    const parsed = parseAssignmentFrontmatter(next);
    expect(parsed.id).toBe('abc');
    expect(parsed.slug).toBe('demo');
    expect(parsed.tags).toEqual([]);
    expect(parsed.workspace.branch).toBe('feature/x');
    expect(parsed.workspace.repository).toBeNull();
  });

  it('updates only the provided field, leaving others untouched', () => {
    const next = updateAssignmentWorkspace(SAMPLE, {
      worktreePath: '/tmp/wt',
    });
    const parsed = parseAssignmentFrontmatter(next);
    expect(parsed.workspace.worktreePath).toBe('/tmp/wt');
    expect(parsed.workspace.branch).toBeNull();
    expect(parsed.workspace.parentBranch).toBeNull();
  });

  it('throws when frontmatter is missing', () => {
    expect(() => updateAssignmentWorkspace('no frontmatter here', { branch: 'x' })).toThrow(
      /No frontmatter found/,
    );
  });

  it('does not edit a same-named field outside the workspace block', () => {
    const sneaky = `---
id: abc
slug: demo
title: "Demo"
externalIds:
  - system: linear
    id: ABC-1
    branch: should-not-be-touched
    url: https://linear.app/x
status: pending
priority: medium
created: "2026-04-23T12:00:00Z"
updated: "2026-04-23T12:00:00Z"
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

Body.
`;
    const next = updateAssignmentWorkspace(sneaky, { branch: 'feature/x' });
    // The bogus externalIds branch line must not have been changed.
    expect(next).toContain('branch: should-not-be-touched');
    // The real workspace.branch must have been updated.
    expect(next).toMatch(/workspace:[\s\S]*?\n  branch: feature\/x/);
  });

  it('preserves unknown workspace fields when updating known ones', () => {
    const withExtra = `---
id: abc
slug: demo
title: "Demo"
status: pending
priority: medium
created: "2026-04-23T12:00:00Z"
updated: "2026-04-23T12:00:00Z"
workspace:
  repository: /tmp/r
  worktreePath: /tmp/w
  branch: old
  parentBranch: main
  customField: keep-me
tags: []
---
Body.
`;
    const next = updateAssignmentWorkspace(withExtra, { branch: 'new' });
    expect(next).toContain('customField: keep-me');
    expect(next).toMatch(/workspace:[\s\S]*?\n  branch: new/);
  });

  // AC1: findWorkspaceBlock must use the regex match offset, not
  // indexOf('workspace:'), so an earlier scalar containing the substring
  // 'workspace:' (e.g. a title) does not shift the splice into the wrong place.
  it('updates the real workspace block even when the title contains "workspace:"', () => {
    const TRICKY = `---
id: tw
slug: tricky-ws
title: "Refactor the workspace: module"
status: pending
priority: medium
created: "2026-04-23T12:00:00Z"
updated: "2026-04-23T12:00:00Z"
workspace:
  repository: /tmp/r
  worktreePath: /tmp/w
  branch: old
  parentBranch: main
tags: []
---

Body.
`;
    const next = updateAssignmentWorkspace(TRICKY, { branch: 'feature/new' });
    // Title scalar is untouched (not torn by a mis-offset splice).
    expect(next).toContain('title: "Refactor the workspace: module"');
    const fm = parseAssignmentFrontmatter(next);
    expect(fm.title).toBe('Refactor the workspace: module');
    // The REAL workspace block's branch was updated, the old value is gone.
    expect(next).toMatch(/^  branch: feature\/new$/m);
    expect(next).not.toMatch(/^  branch: old$/m);
    expect(fm.workspace.branch).toBe('feature/new');
    // Result still parses cleanly end-to-end.
    expect(() => parseAssignmentFrontmatter(next)).not.toThrow();
  });
});
