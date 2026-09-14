import { describe, it, expect } from 'vitest';
import {
  appendStatusHistoryEntry,
  parseTicketFrontmatter,
  renameStatusInHistory,
  updateTicketFile,
} from '../lifecycle/frontmatter.js';

const SIMPLE_TICKET = `---
id: test-id-123
slug: test-ticket
title: "Test Ticket"
status: pending
priority: medium
created: "2026-03-18T10:00:00Z"
updated: "2026-03-18T10:00:00Z"
assignee: null
externalIds: []
depends_on: []
links: []
blocked: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# Test Ticket

Body content here.
`;

const COMPLEX_TICKET = `---
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
depends_on:
  - design-auth-schema
links:
  - other-project/some-ticket
  - my-project/another-task
blocked: null
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

describe('parseTicketFrontmatter', () => {
  it('parses simple ticket with empty arrays and null fields', () => {
    const fm = parseTicketFrontmatter(SIMPLE_TICKET);
    expect(fm.id).toBe('test-id-123');
    expect(fm.slug).toBe('test-ticket');
    expect(fm.title).toBe('Test Ticket');
    expect(fm.status).toBe('pending');
    expect(fm.priority).toBe('medium');
    expect(fm.created).toBe('2026-03-18T10:00:00Z');
    expect(fm.updated).toBe('2026-03-18T10:00:00Z');
    expect(fm.assignee).toBeNull();
    expect(fm.externalIds).toEqual([]);
    expect(fm.depends_on).toEqual([]);
    expect(fm.links).toEqual([]);
    expect(fm.blocked).toBeNull();
    expect(fm.workspace.repository).toBeNull();
    expect(fm.workspace.worktreePath).toBeNull();
    expect(fm.workspace.branch).toBeNull();
    expect(fm.workspace.parentBranch).toBeNull();
    expect(fm.tags).toEqual([]);
  });

  it('parses ticket with populated fields', () => {
    const fm = parseTicketFrontmatter(COMPLEX_TICKET);
    expect(fm.status).toBe('in_progress');
    expect(fm.assignee).toBe('claude-1');
    expect(fm.depends_on).toEqual(['design-auth-schema']);
    expect(fm.links).toEqual(['other-project/some-ticket', 'my-project/another-task']);
    expect(fm.workspace.repository).toBe('/Users/brennen/projects/auth-service');
    expect(fm.workspace.branch).toBe('feat/complex-task');
    expect(fm.workspace.parentBranch).toBe('main');
  });

  it('parses externalIds with nested objects', () => {
    const fm = parseTicketFrontmatter(COMPLEX_TICKET);
    expect(fm.externalIds.length).toBe(1);
    expect(fm.externalIds[0]).toEqual({
      system: 'jira',
      id: 'AUTH-43',
      url: 'https://jira.example.com/browse/AUTH-43',
    });
  });

  it('preserves externalIds entries that omit the url, defaulting to null', () => {
    const URL_LESS_TICKET = `---
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
depends_on: []
links: []
blocked: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# x
`;
    const fm = parseTicketFrontmatter(URL_LESS_TICKET);
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
depends_on: []
links: []
blocked: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# x
`;
    const fm = parseTicketFrontmatter(QUIRKY);
    expect(fm.externalIds).toHaveLength(5);
    expect(fm.externalIds[0].url).toBeNull();
    expect(fm.externalIds[1].url).toBeNull();
    expect(fm.externalIds[2].url).toBe('https://example.com/A-3');
    expect(fm.externalIds[3].url).toBeNull();
    expect(fm.externalIds[4].url).toBeNull();
  });

  it('throws on content without frontmatter', () => {
    expect(() => parseTicketFrontmatter('no frontmatter here')).toThrow(
      'No frontmatter found',
    );
  });
});

describe('updateTicketFile', () => {
  it('updates status field', () => {
    const result = updateTicketFile(SIMPLE_TICKET, {
      status: 'in_progress',
    });
    expect(result).toContain('status: in_progress');
    expect(result).not.toContain('status: pending');
  });

  it('updates assignee from null to a name', () => {
    const result = updateTicketFile(SIMPLE_TICKET, {
      assignee: 'claude-3',
    });
    expect(result).toContain('assignee: claude-3');
    expect(result).not.toContain('assignee: null');
  });

  it('updates assignee from a name back to null', () => {
    const result = updateTicketFile(COMPLEX_TICKET, {
      assignee: null,
    });
    expect(result).toContain('assignee: null');
    expect(result).not.toContain('assignee: claude-1');
  });

  it('updates blocked to a string value', () => {
    const result = updateTicketFile(SIMPLE_TICKET, {
      blocked: 'Waiting for API key',
    });
    expect(result).toContain('blocked: Waiting for API key');
  });

  it('updates blocked back to null', () => {
    const withReason = updateTicketFile(SIMPLE_TICKET, {
      blocked: 'some reason',
    });
    const result = updateTicketFile(withReason, {
      blocked: null,
    });
    expect(result).toContain('blocked: null');
  });

  it('updates timestamp with quotes', () => {
    const result = updateTicketFile(SIMPLE_TICKET, {
      updated: '2026-03-18T15:00:00Z',
    });
    expect(result).toContain('updated: "2026-03-18T15:00:00Z"');
  });

  it('preserves the markdown body unchanged', () => {
    const body = '# Test Ticket\n\nBody content here.\n';
    const result = updateTicketFile(SIMPLE_TICKET, {
      status: 'in_progress',
      assignee: 'claude-1',
      updated: '2026-03-18T15:00:00Z',
    });
    expect(result).toContain(body);
  });

  it('updates multiple fields at once', () => {
    const result = updateTicketFile(SIMPLE_TICKET, {
      status: 'in_progress',
      blocked: 'Need API key',
      updated: '2026-03-18T16:00:00Z',
    });
    expect(result).toContain('status: in_progress');
    expect(result).toContain('blocked: Need API key');
    expect(result).toContain('updated: "2026-03-18T16:00:00Z"');
  });

  // AC2: formatYamlValue must quote a scalar that is itself wrapped in quote
  // chars, else parseSimpleValue strips the literal quotes on read.
  it('round-trips a blocked value wrapped in double quotes (AC2)', () => {
    const result = updateTicketFile(SIMPLE_TICKET, {
      blocked: '"connection refused"',
    });
    expect(parseTicketFrontmatter(result).blocked).toBe('"connection refused"');
  });

  it('round-trips a blocked value wrapped in single quotes (AC2)', () => {
    const result = updateTicketFile(SIMPLE_TICKET, {
      blocked: "'singlequoted'",
    });
    expect(parseTicketFrontmatter(result).blocked).toBe("'singlequoted'");
  });

  it('still round-trips a blocked value with only interior quotes (AC2 over-trigger guard)', () => {
    const result = updateTicketFile(SIMPLE_TICKET, {
      blocked: 'say "hello" now',
    });
    expect(parseTicketFrontmatter(result).blocked).toBe('say "hello" now');
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
depends_on: []
links: []
blocked: waiting on API
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
    const fm = parseTicketFrontmatter(WITH_HISTORY);
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
    const fm = parseTicketFrontmatter(
      SIMPLE_TICKET.replace('externalIds: []', 'externalIds: []\nstatusHistory: []'),
    );
    expect(fm.statusHistory).toEqual([]);
  });

  it('returns [] when the key is absent', () => {
    expect(parseTicketFrontmatter(SIMPLE_TICKET).statusHistory).toEqual([]);
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
depends_on: []
links: []
blocked: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# x
`;
    const fm = parseTicketFrontmatter(TRICKY);
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
depends_on: []
links: []
blocked: null
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
    const fm = parseTicketFrontmatter(LAST_KEY);
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
    const appended = appendStatusHistoryEntry(SIMPLE_TICKET, {
      at: '2026-04-01T12:00:00Z',
      from: null,
      to: 'pending',
      command: 'create',
      by: null,
    });
    expect(appended).toContain('statusHistory:');
    // statusHistory is now the LAST key — parse must still find it.
    const fm = parseTicketFrontmatter(appended);
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
    const inline = SIMPLE_TICKET.replace(
      'externalIds: []',
      'externalIds: []\nstatusHistory: []',
    );
    const appended = appendStatusHistoryEntry(inline, ENTRY);
    expect(appended).not.toContain('statusHistory: []');
    const fm = parseTicketFrontmatter(appended);
    expect(fm.statusHistory).toHaveLength(1);
    expect(fm.statusHistory[0].to).toBe('review');
  });

  it('appends to an existing block, preserving prior entries and order', () => {
    const appended = appendStatusHistoryEntry(WITH_HISTORY, ENTRY);
    const fm = parseTicketFrontmatter(appended);
    expect(fm.statusHistory).toHaveLength(3);
    expect(fm.statusHistory[0].to).toBe('draft');
    expect(fm.statusHistory[1].to).toBe('blocked');
    expect(fm.statusHistory[2]).toEqual({ ...ENTRY });
  });

  it('does not disturb other frontmatter fields', () => {
    const appended = appendStatusHistoryEntry(WITH_HISTORY, ENTRY);
    const fm = parseTicketFrontmatter(appended);
    expect(fm.id).toBe('h-1');
    expect(fm.assignee).toBe('claude-1');
    expect(fm.blocked).toBe('waiting on API');
    expect(fm.status).toBe('blocked');
    expect(fm.depends_on).toEqual([]);
    expect(fm.tags).toEqual([]);
    // body intact
    expect(appended).toContain('# With History');
  });

  it('quotes a reason containing YAML-special characters', () => {
    const appended = appendStatusHistoryEntry(SIMPLE_TICKET, {
      at: '2026-04-01T12:00:00Z',
      from: 'in_progress',
      to: 'blocked',
      command: 'block',
      by: null,
      reason: 'blocked: needs review',
    });
    const fm = parseTicketFrontmatter(appended);
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
depends_on: []
links: []
blocked: null
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
    const fm = parseTicketFrontmatter(renamed);
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
    const fm = parseTicketFrontmatter(renameStatusInHistory(FIXTURE, 'in_review', 'review'));
    expect(fm.statusHistory[0].to).toBe('review');
    expect(fm.statusHistory[1].from).toBe('review');
  });

  it('does not relabel a status whose id is only a substring', () => {
    // 'review' must NOT match 'in_review'.
    const fm = parseTicketFrontmatter(renameStatusInHistory(FIXTURE, 'review', 'x'));
    expect(fm.statusHistory[0].to).toBe('in_review');
    expect(fm.statusHistory[1].from).toBe('in_review');
  });

  it('leaves null `from` entries untouched', () => {
    const fm = parseTicketFrontmatter(renameStatusInHistory(FIXTURE, 'completed', 'done'));
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
    const fm = parseTicketFrontmatter(renamed);
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
    const fm = parseTicketFrontmatter(SIMPLE_TICKET);
    expect(fm.archived).toBe(false);
    expect(fm.archivedAt).toBeNull();
    expect(fm.archivedReason).toBeNull();
  });

  it('inserts archive fields into a file that lacks them, and round-trips', () => {
    const result = updateTicketFile(SIMPLE_TICKET, {
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
    const fm = parseTicketFrontmatter(result);
    expect(fm.archived).toBe(true);
    expect(fm.archivedAt).toBe('2026-05-31T12:00:00Z');
    expect(fm.archivedReason).toBe('superseded');
    expect(fm.status).toBe('pending');
  });

  it('replaces existing archive fields in place (no duplicate keys)', () => {
    const archived = updateTicketFile(SIMPLE_TICKET, {
      archived: true,
      archivedAt: '2026-05-31T12:00:00Z',
      archivedReason: 'temp',
      updated: '2026-05-31T12:00:00Z',
    });
    const restored = updateTicketFile(archived, {
      archived: false,
      archivedAt: null,
      archivedReason: null,
      updated: '2026-05-31T13:00:00Z',
    });
    expect(restored.match(/^archived:/gm)).toHaveLength(1);
    const fm = parseTicketFrontmatter(restored);
    expect(fm.archived).toBe(false);
    expect(fm.archivedAt).toBeNull();
    expect(fm.archivedReason).toBeNull();
    expect(fm.updated).toBe('2026-05-31T13:00:00Z');
    // restore preserves status
    expect(fm.status).toBe('pending');
  });
});

// ── derived-status v3: dimension-aware history + asserted-fact fields ──────

import { updateOverride, updatePlanBlock } from '../lifecycle/frontmatter.js';

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
    const content = appendStatusHistoryEntry(SIMPLE_TICKET, entry);
    const parsed = parseTicketFrontmatter(content);
    expect(parsed.statusHistory).toHaveLength(1);
    expect(parsed.statusHistory[0]).toMatchObject(entry);
  });

  it('old headline-only entries parse unchanged (no dimension keys)', () => {
    const content = appendStatusHistoryEntry(SIMPLE_TICKET, {
      at: '2026-06-09T12:00:00Z',
      from: 'pending',
      to: 'in_progress',
      command: 'start',
      by: null,
    });
    const parsed = parseTicketFrontmatter(content);
    const e = parsed.statusHistory[0];
    expect(e.phaseFrom).toBeUndefined();
    expect(e.dispositionTo).toBeUndefined();
    // serialized form stays byte-identical to v1 (no dimension lines)
    expect(content).not.toContain('phaseFrom');
  });

  it('renameStatusInHistory relabels phaseFrom/phaseTo but not disposition keys', () => {
    let content = appendStatusHistoryEntry(SIMPLE_TICKET, {
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
    const e = parseTicketFrontmatter(content).statusHistory[0];
    expect(e.from).toBe('code_review');
    expect(e.phaseFrom).toBe('code_review');
    expect(e.phaseTo).toBe('code_review');
    expect(e.dispositionFrom).toBe('active'); // dimension values untouched
  });
});

describe('asserted-fact frontmatter fields (v3)', () => {
  it('defaults are null/false on legacy files', () => {
    const parsed = parseTicketFrontmatter(SIMPLE_TICKET);
    expect(parsed.phase).toBeNull();
    expect(parsed.disposition).toBeNull();
    expect(parsed.plan.file).toBeNull();
    expect(parsed.plan.approvedDigest).toBeNull();
    expect(parsed.override).toBeNull();
    expect(parsed.parked).toBeNull();
    expect(parsed.reviewRequested).toBe(false);
    expect(parsed.reworkRequested).toBe(false);
    expect(parsed.implementationStarted).toBe(false);
  });

  it('updatePlanBlock writes and clears a nested record', () => {
    const approval = {
      file: 'plan-v2.md',
      approvedDigest: 'abc123',
      approvedBy: 'human',
      approvedAt: '2026-06-09T12:00:00Z',
    };
    let content = updatePlanBlock(SIMPLE_TICKET, approval);
    expect(parseTicketFrontmatter(content).plan).toMatchObject(approval);
    // set again in place (edit, not duplicate)
    content = updatePlanBlock(content, { ...approval, file: 'plan-v3.md' });
    const reparsed = parseTicketFrontmatter(content);
    expect(reparsed.plan?.file).toBe('plan-v3.md');
    expect(content.match(/^plan:/gm)).toHaveLength(1);
    // clear → null, key preserved
    content = updatePlanBlock(content, {
      approvedDigest: null,
      approvedAt: null,
      approvedBy: null,
    });
    const cleared = parseTicketFrontmatter(content).plan;
    expect(cleared.approvedDigest).toBeNull();
    expect(cleared.file).toBe('plan-v3.md');
  });

  it('updateOverride writes and clears the pin record', () => {
    const pin = {
      status: 'blocked',
      source: 'agent:claude',
      reason: 'waiting on vendor',
      at: '2026-06-09T12:00:00Z',
    };
    let content = updateOverride(COMPLEX_TICKET, pin);
    expect(parseTicketFrontmatter(content).override).toEqual(pin);
    content = updateOverride(content, null);
    expect(parseTicketFrontmatter(content).override).toBeNull();
  });

  it('updateTicketFile handles new scalar fields incl. insertion when missing', () => {
    const content = updateTicketFile(SIMPLE_TICKET, {
      phase: 'planning',
      disposition: 'active',
      parked: null,
      reviewRequested: true,
      reworkRequested: true,
      implementationStarted: true,
    });
    const parsed = parseTicketFrontmatter(content);
    expect(parsed.phase).toBe('planning');
    expect(parsed.disposition).toBe('active');
    expect(parsed.reviewRequested).toBe(true);
    expect(parsed.reworkRequested).toBe(true);
    expect(parsed.implementationStarted).toBe(true);
  });
});

import { parseTicketFull } from '../dashboard/parser.js';

describe('ticket workflow: field (both parsers + updater)', () => {
  const withWorkflow = SIMPLE_TICKET.replace(
    'status: pending',
    'workflow: bugfix\nstatus: pending',
  );

  it('parseTicketFrontmatter reads an explicit workflow id', () => {
    expect(parseTicketFrontmatter(withWorkflow).workflow).toBe('bugfix');
  });

  it('parseTicketFrontmatter yields null when workflow is absent', () => {
    expect(parseTicketFrontmatter(SIMPLE_TICKET).workflow).toBeNull();
  });

  it('the dashboard parseTicketFull reads the same workflow id (parser parity)', () => {
    expect(parseTicketFull(withWorkflow).workflow).toBe('bugfix');
    expect(parseTicketFull(SIMPLE_TICKET).workflow).toBeNull();
  });

  it('updateTicketFile sets workflow (whitelisted) and it round-trips through both parsers', () => {
    const updated = updateTicketFile(SIMPLE_TICKET, { workflow: 'research' });
    expect(parseTicketFrontmatter(updated).workflow).toBe('research');
    expect(parseTicketFull(updated).workflow).toBe('research');
  });
});
