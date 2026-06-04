import { describe, it, expect } from 'vitest';
import {
  appendStatusHistoryEntry,
  parseAssignmentFrontmatter,
  updateAssignmentFile,
} from '../lifecycle/frontmatter.js';

const SIMPLE_ASSIGNMENT = `---
id: test-id-123
slug: test-assignment
title: "Test Assignment"
status: pending
priority: medium
created: "2026-03-18T10:00:00Z"
updated: "2026-03-18T10:00:00Z"
assignee: null
externalIds: []
dependsOn: []
links: []
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# Test Assignment

Body content here.
`;

const COMPLEX_ASSIGNMENT = `---
id: complex-id-456
slug: complex-task
title: "Complex Task"
status: in_progress
priority: high
created: "2026-03-15T09:30:00Z"
updated: "2026-03-18T14:30:00Z"
assignee: claude-1
externalIds:
  - system: jira
    id: AUTH-43
    url: https://jira.example.com/browse/AUTH-43
dependsOn:
  - design-auth-schema
links:
  - other-project/some-assignment
  - my-project/another-task
blockedReason: null
workspace:
  repository: /Users/brennen/projects/auth-service
  worktreePath: /Users/brennen/projects/auth-service-worktrees/complex-task
  branch: feat/complex-task
  parentBranch: main
tags: []
---

# Complex Task

Body content here.
`;

describe('parseAssignmentFrontmatter', () => {
  it('parses simple assignment with empty arrays and null fields', () => {
    const fm = parseAssignmentFrontmatter(SIMPLE_ASSIGNMENT);
    expect(fm.id).toBe('test-id-123');
    expect(fm.slug).toBe('test-assignment');
    expect(fm.title).toBe('Test Assignment');
    expect(fm.status).toBe('pending');
    expect(fm.priority).toBe('medium');
    expect(fm.created).toBe('2026-03-18T10:00:00Z');
    expect(fm.updated).toBe('2026-03-18T10:00:00Z');
    expect(fm.assignee).toBeNull();
    expect(fm.externalIds).toEqual([]);
    expect(fm.dependsOn).toEqual([]);
    expect(fm.links).toEqual([]);
    expect(fm.blockedReason).toBeNull();
    expect(fm.workspace.repository).toBeNull();
    expect(fm.workspace.worktreePath).toBeNull();
    expect(fm.workspace.branch).toBeNull();
    expect(fm.workspace.parentBranch).toBeNull();
    expect(fm.tags).toEqual([]);
  });

  it('parses assignment with populated fields', () => {
    const fm = parseAssignmentFrontmatter(COMPLEX_ASSIGNMENT);
    expect(fm.status).toBe('in_progress');
    expect(fm.assignee).toBe('claude-1');
    expect(fm.dependsOn).toEqual(['design-auth-schema']);
    expect(fm.links).toEqual(['other-project/some-assignment', 'my-project/another-task']);
    expect(fm.workspace.repository).toBe('/Users/brennen/projects/auth-service');
    expect(fm.workspace.branch).toBe('feat/complex-task');
    expect(fm.workspace.parentBranch).toBe('main');
  });

  it('parses externalIds with nested objects', () => {
    const fm = parseAssignmentFrontmatter(COMPLEX_ASSIGNMENT);
    expect(fm.externalIds.length).toBe(1);
    expect(fm.externalIds[0]).toEqual({
      system: 'jira',
      id: 'AUTH-43',
      url: 'https://jira.example.com/browse/AUTH-43',
    });
  });

  it('preserves externalIds entries that omit the url, defaulting to null', () => {
    const URL_LESS_ASSIGNMENT = `---
id: u-1
slug: link-less
title: "Link-less"
status: pending
priority: medium
created: "2026-03-15T09:30:00Z"
updated: "2026-03-15T09:30:00Z"
assignee: null
externalIds:
  - system: linear
    id: ENG-7
  - system: jira
    id: PROJ-99
    url: https://jira.example.com/browse/PROJ-99
dependsOn: []
links: []
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# x
`;
    const fm = parseAssignmentFrontmatter(URL_LESS_ASSIGNMENT);
    expect(fm.externalIds).toHaveLength(2);
    expect(fm.externalIds[0]).toEqual({ system: 'linear', id: 'ENG-7', url: null });
    expect(fm.externalIds[1]).toEqual({
      system: 'jira',
      id: 'PROJ-99',
      url: 'https://jira.example.com/browse/PROJ-99',
    });
  });

  it('normalizes explicit null, empty, tilde, and quoted url scalars', () => {
    const QUIRKY = `---
id: u-2
slug: quirky
title: "Quirky"
status: pending
priority: medium
created: "2026-03-15T09:30:00Z"
updated: "2026-03-15T09:30:00Z"
assignee: null
externalIds:
  - system: jira
    id: A-1
    url: null
  - system: jira
    id: A-2
    url: ""
  - system: jira
    id: A-3
    url: "https://example.com/A-3"
  - system: jira
    id: A-4
    url: ~
  - system: jira
    id: A-5
    url:
dependsOn: []
links: []
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# x
`;
    const fm = parseAssignmentFrontmatter(QUIRKY);
    expect(fm.externalIds).toHaveLength(5);
    expect(fm.externalIds[0].url).toBeNull();
    expect(fm.externalIds[1].url).toBeNull();
    expect(fm.externalIds[2].url).toBe('https://example.com/A-3');
    expect(fm.externalIds[3].url).toBeNull();
    expect(fm.externalIds[4].url).toBeNull();
  });

  it('throws on content without frontmatter', () => {
    expect(() => parseAssignmentFrontmatter('no frontmatter here')).toThrow(
      'No frontmatter found',
    );
  });
});

describe('updateAssignmentFile', () => {
  it('updates status field', () => {
    const result = updateAssignmentFile(SIMPLE_ASSIGNMENT, {
      status: 'in_progress',
    });
    expect(result).toContain('status: in_progress');
    expect(result).not.toContain('status: pending');
  });

  it('updates assignee from null to a name', () => {
    const result = updateAssignmentFile(SIMPLE_ASSIGNMENT, {
      assignee: 'claude-3',
    });
    expect(result).toContain('assignee: claude-3');
    expect(result).not.toContain('assignee: null');
  });

  it('updates assignee from a name back to null', () => {
    const result = updateAssignmentFile(COMPLEX_ASSIGNMENT, {
      assignee: null,
    });
    expect(result).toContain('assignee: null');
    expect(result).not.toContain('assignee: claude-1');
  });

  it('updates blockedReason to a string value', () => {
    const result = updateAssignmentFile(SIMPLE_ASSIGNMENT, {
      blockedReason: 'Waiting for API key',
    });
    expect(result).toContain('blockedReason: Waiting for API key');
  });

  it('updates blockedReason back to null', () => {
    const withReason = updateAssignmentFile(SIMPLE_ASSIGNMENT, {
      blockedReason: 'some reason',
    });
    const result = updateAssignmentFile(withReason, {
      blockedReason: null,
    });
    expect(result).toContain('blockedReason: null');
  });

  it('updates timestamp with quotes', () => {
    const result = updateAssignmentFile(SIMPLE_ASSIGNMENT, {
      updated: '2026-03-18T15:00:00Z',
    });
    expect(result).toContain('updated: "2026-03-18T15:00:00Z"');
  });

  it('preserves the markdown body unchanged', () => {
    const body = '# Test Assignment\n\nBody content here.\n';
    const result = updateAssignmentFile(SIMPLE_ASSIGNMENT, {
      status: 'in_progress',
      assignee: 'claude-1',
      updated: '2026-03-18T15:00:00Z',
    });
    expect(result).toContain(body);
  });

  it('updates multiple fields at once', () => {
    const result = updateAssignmentFile(SIMPLE_ASSIGNMENT, {
      status: 'blocked',
      blockedReason: 'Need API key',
      updated: '2026-03-18T16:00:00Z',
    });
    expect(result).toContain('status: blocked');
    expect(result).toContain('blockedReason: Need API key');
    expect(result).toContain('updated: "2026-03-18T16:00:00Z"');
  });
});

const WITH_HISTORY = `---
id: h-1
slug: with-history
title: "With History"
status: blocked
priority: medium
created: "2026-03-18T10:00:00Z"
updated: "2026-03-18T11:00:00Z"
assignee: claude-1
externalIds: []
statusHistory:
  - at: "2026-03-18T10:00:00Z"
    from: null
    to: draft
    command: create
    by: null
  - at: "2026-03-18T11:00:00Z"
    from: draft
    to: blocked
    command: block
    by: claude-1
    reason: waiting on API
dependsOn: []
links: []
blockedReason: waiting on API
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# With History
`;

describe('parseStatusHistory', () => {
  it('parses a block of entries including one with a reason', () => {
    const fm = parseAssignmentFrontmatter(WITH_HISTORY);
    expect(fm.statusHistory).toHaveLength(2);
    expect(fm.statusHistory[0]).toEqual({
      at: '2026-03-18T10:00:00Z',
      from: null,
      to: 'draft',
      command: 'create',
      by: null,
    });
    expect(fm.statusHistory[1]).toEqual({
      at: '2026-03-18T11:00:00Z',
      from: 'draft',
      to: 'blocked',
      command: 'block',
      by: 'claude-1',
      reason: 'waiting on API',
    });
  });

  it('returns [] for the inline empty list form', () => {
    const fm = parseAssignmentFrontmatter(
      SIMPLE_ASSIGNMENT.replace('externalIds: []', 'externalIds: []\nstatusHistory: []'),
    );
    expect(fm.statusHistory).toEqual([]);
  });

  it('returns [] when the key is absent', () => {
    expect(parseAssignmentFrontmatter(SIMPLE_ASSIGNMENT).statusHistory).toEqual([]);
  });

  it('parses the real block even when an earlier scalar contains "statusHistory:"', () => {
    // The title value contains the substring "statusHistory:". A naive
    // indexOf('statusHistory:') would lock onto the title and drop the real block.
    const TRICKY = `---
id: t-1
slug: tricky
title: "Audit statusHistory: behavior"
status: in_progress
priority: medium
created: "2026-03-18T10:00:00Z"
updated: "2026-03-18T10:00:00Z"
assignee: null
externalIds: []
statusHistory:
  - at: "2026-03-18T10:00:00Z"
    from: null
    to: draft
    command: create
    by: null
dependsOn: []
links: []
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# x
`;
    const fm = parseAssignmentFrontmatter(TRICKY);
    expect(fm.title).toBe('Audit statusHistory: behavior');
    expect(fm.statusHistory).toHaveLength(1);
    expect(fm.statusHistory[0]).toMatchObject({ to: 'draft', command: 'create' });
  });

  it('parses a statusHistory block that is the LAST frontmatter key (EOF-safe)', () => {
    // No trailing top-level key and no `\n---` inside the captured frontmatter —
    // this is the case the naive externalIds boundary regex would drop.
    const LAST_KEY = `---
id: e-1
slug: eof
title: "EOF"
status: in_progress
priority: medium
created: "2026-03-18T10:00:00Z"
updated: "2026-03-18T10:00:00Z"
assignee: null
externalIds: []
dependsOn: []
links: []
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
statusHistory:
  - at: "2026-03-18T10:00:00Z"
    from: null
    to: draft
    command: create
    by: null
  - at: "2026-03-18T10:05:00Z"
    from: draft
    to: in_progress
    command: start
    by: claude
---

# EOF
`;
    const fm = parseAssignmentFrontmatter(LAST_KEY);
    expect(fm.statusHistory).toHaveLength(2);
    expect(fm.statusHistory[1].to).toBe('in_progress');
    expect(fm.statusHistory[1].command).toBe('start');
    expect(fm.statusHistory[1].by).toBe('claude');
  });
});

describe('appendStatusHistoryEntry', () => {
  const ENTRY = {
    at: '2026-04-01T12:00:00Z',
    from: 'in_progress',
    to: 'review',
    command: 'review',
    by: 'claude-2',
  };

  it('creates the block when no statusHistory key exists, and round-trips (EOF combined)', () => {
    const appended = appendStatusHistoryEntry(SIMPLE_ASSIGNMENT, {
      at: '2026-04-01T12:00:00Z',
      from: null,
      to: 'pending',
      command: 'create',
      by: null,
    });
    expect(appended).toContain('statusHistory:');
    // statusHistory is now the LAST key — parse must still find it.
    const fm = parseAssignmentFrontmatter(appended);
    expect(fm.statusHistory).toHaveLength(1);
    expect(fm.statusHistory[0]).toEqual({
      at: '2026-04-01T12:00:00Z',
      from: null,
      to: 'pending',
      command: 'create',
      by: null,
    });
  });

  it('converts an inline empty list to a block', () => {
    const inline = SIMPLE_ASSIGNMENT.replace(
      'externalIds: []',
      'externalIds: []\nstatusHistory: []',
    );
    const appended = appendStatusHistoryEntry(inline, ENTRY);
    expect(appended).not.toContain('statusHistory: []');
    const fm = parseAssignmentFrontmatter(appended);
    expect(fm.statusHistory).toHaveLength(1);
    expect(fm.statusHistory[0].to).toBe('review');
  });

  it('appends to an existing block, preserving prior entries and order', () => {
    const appended = appendStatusHistoryEntry(WITH_HISTORY, ENTRY);
    const fm = parseAssignmentFrontmatter(appended);
    expect(fm.statusHistory).toHaveLength(3);
    expect(fm.statusHistory[0].to).toBe('draft');
    expect(fm.statusHistory[1].to).toBe('blocked');
    expect(fm.statusHistory[2]).toEqual({ ...ENTRY });
  });

  it('does not disturb other frontmatter fields', () => {
    const appended = appendStatusHistoryEntry(WITH_HISTORY, ENTRY);
    const fm = parseAssignmentFrontmatter(appended);
    expect(fm.id).toBe('h-1');
    expect(fm.assignee).toBe('claude-1');
    expect(fm.blockedReason).toBe('waiting on API');
    expect(fm.status).toBe('blocked');
    expect(fm.dependsOn).toEqual([]);
    expect(fm.tags).toEqual([]);
    // body intact
    expect(appended).toContain('# With History');
  });

  it('quotes a reason containing YAML-special characters', () => {
    const appended = appendStatusHistoryEntry(SIMPLE_ASSIGNMENT, {
      at: '2026-04-01T12:00:00Z',
      from: 'in_progress',
      to: 'blocked',
      command: 'block',
      by: null,
      reason: 'blocked: needs review',
    });
    const fm = parseAssignmentFrontmatter(appended);
    expect(fm.statusHistory[0].reason).toBe('blocked: needs review');
  });

  it('throws on content without frontmatter', () => {
    expect(() => appendStatusHistoryEntry('no frontmatter', ENTRY)).toThrow(
      'No frontmatter found',
    );
  });
});

describe('archive frontmatter fields', () => {
  it('defaults missing archive fields to false/null/null', () => {
    const fm = parseAssignmentFrontmatter(SIMPLE_ASSIGNMENT);
    expect(fm.archived).toBe(false);
    expect(fm.archivedAt).toBeNull();
    expect(fm.archivedReason).toBeNull();
  });

  it('inserts archive fields into a file that lacks them, and round-trips', () => {
    const result = updateAssignmentFile(SIMPLE_ASSIGNMENT, {
      archived: true,
      archivedAt: '2026-05-31T12:00:00Z',
      archivedReason: 'superseded',
      updated: '2026-05-31T12:00:00Z',
    });
    expect(result).toContain('archived: true');
    expect(result).toContain('archivedAt: "2026-05-31T12:00:00Z"');
    expect(result).toContain('archivedReason: superseded');
    // status untouched
    expect(result).toContain('status: pending');
    const fm = parseAssignmentFrontmatter(result);
    expect(fm.archived).toBe(true);
    expect(fm.archivedAt).toBe('2026-05-31T12:00:00Z');
    expect(fm.archivedReason).toBe('superseded');
    expect(fm.status).toBe('pending');
  });

  it('replaces existing archive fields in place (no duplicate keys)', () => {
    const archived = updateAssignmentFile(SIMPLE_ASSIGNMENT, {
      archived: true,
      archivedAt: '2026-05-31T12:00:00Z',
      archivedReason: 'temp',
      updated: '2026-05-31T12:00:00Z',
    });
    const restored = updateAssignmentFile(archived, {
      archived: false,
      archivedAt: null,
      archivedReason: null,
      updated: '2026-05-31T13:00:00Z',
    });
    expect(restored.match(/^archived:/gm)).toHaveLength(1);
    const fm = parseAssignmentFrontmatter(restored);
    expect(fm.archived).toBe(false);
    expect(fm.archivedAt).toBeNull();
    expect(fm.archivedReason).toBeNull();
    expect(fm.updated).toBe('2026-05-31T13:00:00Z');
    // restore preserves status
    expect(fm.status).toBe('pending');
  });
});
