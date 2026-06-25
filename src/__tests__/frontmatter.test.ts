import { describe, it, expect } from 'vitest';
import {
  appendStatusHistoryEntry,
  parseAssignmentFrontmatter,
  renameStatusInHistory,
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

  // AC2: formatYamlValue must quote a scalar that is itself wrapped in quote
  // chars, else parseSimpleValue strips the literal quotes on read.
  it('round-trips a blockedReason whose value is wrapped in double quotes (AC2)', () => {
    const result = updateAssignmentFile(SIMPLE_ASSIGNMENT, {
      blockedReason: '"connection refused"',
    });
    expect(parseAssignmentFrontmatter(result).blockedReason).toBe('"connection refused"');
  });

  it('round-trips a blockedReason wrapped in single quotes (AC2)', () => {
    const result = updateAssignmentFile(SIMPLE_ASSIGNMENT, {
      blockedReason: "'singlequoted'",
    });
    expect(parseAssignmentFrontmatter(result).blockedReason).toBe("'singlequoted'");
  });

  it('still round-trips a value with only interior quotes (AC2 over-trigger guard)', () => {
    const result = updateAssignmentFile(SIMPLE_ASSIGNMENT, {
      blockedReason: 'say "hello" now',
    });
    expect(parseAssignmentFrontmatter(result).blockedReason).toBe('say "hello" now');
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

describe('renameStatusInHistory', () => {
  const FIXTURE = `---
id: r-1
slug: ren
title: "Ren"
status: completed
priority: medium
created: "2026-03-18T10:00:00Z"
updated: "2026-03-18T12:00:00Z"
assignee: null
externalIds: []
statusHistory:
  - at: "2026-03-18T10:00:00Z"
    from: null
    to: in_review
    command: create
    by: null
  - at: "2026-03-18T12:00:00Z"
    from: in_review
    to: completed
    command: complete
    by: claude
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

# Ren
`;

  it('relabels from/to in place, preserving at and appending no entry', () => {
    const renamed = renameStatusInHistory(FIXTURE, 'completed', 'done');
    const fm = parseAssignmentFrontmatter(renamed);
    expect(fm.statusHistory).toHaveLength(2); // no new entry
    expect(fm.statusHistory[0]).toEqual({
      at: '2026-03-18T10:00:00Z',
      from: null,
      to: 'in_review',
      command: 'create',
      by: null,
    });
    expect(fm.statusHistory[1]).toMatchObject({
      at: '2026-03-18T12:00:00Z', // at preserved
      from: 'in_review',
      to: 'done', // relabeled
      command: 'complete',
    });
  });

  it('rewrites both from and to occurrences of the old id', () => {
    // Rename in_review → review: the create entry's `to` and the complete
    // entry's `from` both reference in_review.
    const fm = parseAssignmentFrontmatter(renameStatusInHistory(FIXTURE, 'in_review', 'review'));
    expect(fm.statusHistory[0].to).toBe('review');
    expect(fm.statusHistory[1].from).toBe('review');
  });

  it('does not relabel a status whose id is only a substring', () => {
    // 'review' must NOT match 'in_review'.
    const fm = parseAssignmentFrontmatter(renameStatusInHistory(FIXTURE, 'review', 'x'));
    expect(fm.statusHistory[0].to).toBe('in_review');
    expect(fm.statusHistory[1].from).toBe('in_review');
  });

  it('leaves null `from` entries untouched', () => {
    const fm = parseAssignmentFrontmatter(renameStatusInHistory(FIXTURE, 'completed', 'done'));
    expect(fm.statusHistory[0].from).toBeNull();
  });

  // AC3: newId must be serialized via formatYamlValue, not by reusing the OLD
  // value's quote state. Renaming to a YAML keyword/number look-alike must keep
  // the entry intact and string-typed.
  it('keeps a history entry when renaming a status to the YAML keyword null (AC3)', () => {
    // FIXTURE: create.to = in_review, complete.from = in_review. Renaming
    // in_review -> null writes the create entry's `to`. Unquoted `to: null`
    // makes parseStatusHistory drop the entry (data loss).
    const renamed = renameStatusInHistory(FIXTURE, 'in_review', 'null');
    const fm = parseAssignmentFrontmatter(renamed);
    expect(fm.statusHistory).toHaveLength(2); // create entry NOT dropped
    expect(fm.statusHistory[0].to).toBe('null'); // string, intact
    expect(fm.statusHistory[1].from).toBe('null');
    expect(renamed).toMatch(/to: "null"/); // quoted so any YAML parser sees a string
  });

  it('quotes numeric / boolean new ids in history so they stay strings (AC3)', () => {
    expect(renameStatusInHistory(FIXTURE, 'completed', '42')).toMatch(/to: "42"/);
    expect(renameStatusInHistory(FIXTURE, 'completed', 'true')).toMatch(/to: "true"/);
  });

  it('still writes a plain id unquoted (AC3 over-trigger guard)', () => {
    const renamed = renameStatusInHistory(FIXTURE, 'completed', 'done');
    expect(renamed).toMatch(/to: done/);
    expect(renamed).not.toMatch(/to: "done"/);
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

// ── derived-status v3: dimension-aware history + asserted-fact fields ──────

import { updateOverride, updatePlanApproval } from '../lifecycle/frontmatter.js';

describe('dimension-aware statusHistory (v3)', () => {
  it('round-trips an entry with phase/disposition keys', () => {
    const entry = {
      at: '2026-06-09T12:00:00Z',
      from: 'blocked',
      to: 'blocked',
      command: 'derive',
      by: 'agent:claude',
      phaseFrom: 'planning',
      phaseTo: 'ready_to_implement',
      dispositionFrom: 'blocked',
      dispositionTo: 'blocked',
    };
    const content = appendStatusHistoryEntry(SIMPLE_ASSIGNMENT, entry);
    const parsed = parseAssignmentFrontmatter(content);
    expect(parsed.statusHistory).toHaveLength(1);
    expect(parsed.statusHistory[0]).toMatchObject(entry);
  });

  it('old headline-only entries parse unchanged (no dimension keys)', () => {
    const content = appendStatusHistoryEntry(SIMPLE_ASSIGNMENT, {
      at: '2026-06-09T12:00:00Z',
      from: 'pending',
      to: 'in_progress',
      command: 'start',
      by: null,
    });
    const parsed = parseAssignmentFrontmatter(content);
    const e = parsed.statusHistory[0];
    expect(e.phaseFrom).toBeUndefined();
    expect(e.dispositionTo).toBeUndefined();
    // serialized form stays byte-identical to v1 (no dimension lines)
    expect(content).not.toContain('phaseFrom');
  });

  it('renameStatusInHistory relabels phaseFrom/phaseTo but not disposition keys', () => {
    let content = appendStatusHistoryEntry(SIMPLE_ASSIGNMENT, {
      at: '2026-06-09T12:00:00Z',
      from: 'review',
      to: 'review',
      command: 'derive',
      by: null,
      phaseFrom: 'review',
      phaseTo: 'review',
      dispositionFrom: 'active',
      dispositionTo: 'active',
    });
    content = renameStatusInHistory(content, 'review', 'code_review');
    const e = parseAssignmentFrontmatter(content).statusHistory[0];
    expect(e.from).toBe('code_review');
    expect(e.phaseFrom).toBe('code_review');
    expect(e.phaseTo).toBe('code_review');
    expect(e.dispositionFrom).toBe('active'); // dimension values untouched
  });
});

describe('asserted-fact frontmatter fields (v3)', () => {
  it('defaults are null/false on legacy files', () => {
    const parsed = parseAssignmentFrontmatter(SIMPLE_ASSIGNMENT);
    expect(parsed.phase).toBeNull();
    expect(parsed.disposition).toBeNull();
    expect(parsed.planApproval).toBeNull();
    expect(parsed.override).toBeNull();
    expect(parsed.parked).toBe(false);
    expect(parsed.reviewRequested).toBe(false);
    expect(parsed.reworkRequested).toBe(false);
    expect(parsed.implementationStarted).toBe(false);
  });

  it('updatePlanApproval writes and clears a nested record', () => {
    const approval = {
      file: 'plan-v2.md',
      digest: 'abc123',
      by: 'human',
      at: '2026-06-09T12:00:00Z',
    };
    let content = updatePlanApproval(SIMPLE_ASSIGNMENT, approval);
    expect(parseAssignmentFrontmatter(content).planApproval).toEqual(approval);
    // set again in place (edit, not duplicate)
    content = updatePlanApproval(content, { ...approval, file: 'plan-v3.md' });
    const reparsed = parseAssignmentFrontmatter(content);
    expect(reparsed.planApproval?.file).toBe('plan-v3.md');
    expect(content.match(/^planApproval:/gm)).toHaveLength(1);
    // clear → null, key preserved
    content = updatePlanApproval(content, null);
    expect(parseAssignmentFrontmatter(content).planApproval).toBeNull();
    expect(content).toMatch(/^planApproval: null$/m);
  });

  it('updateOverride writes and clears the pin record', () => {
    const pin = {
      status: 'blocked',
      source: 'agent:claude',
      reason: 'waiting on vendor',
      at: '2026-06-09T12:00:00Z',
    };
    let content = updateOverride(COMPLEX_ASSIGNMENT, pin);
    expect(parseAssignmentFrontmatter(content).override).toEqual(pin);
    content = updateOverride(content, null);
    expect(parseAssignmentFrontmatter(content).override).toBeNull();
  });

  it('updateAssignmentFile handles new scalar fields incl. insertion when missing', () => {
    const content = updateAssignmentFile(SIMPLE_ASSIGNMENT, {
      phase: 'planning',
      disposition: 'active',
      parked: false,
      reviewRequested: true,
      reworkRequested: true,
      implementationStarted: true,
    });
    const parsed = parseAssignmentFrontmatter(content);
    expect(parsed.phase).toBe('planning');
    expect(parsed.disposition).toBe('active');
    expect(parsed.reviewRequested).toBe(true);
    expect(parsed.reworkRequested).toBe(true);
    expect(parsed.implementationStarted).toBe(true);
  });
});
