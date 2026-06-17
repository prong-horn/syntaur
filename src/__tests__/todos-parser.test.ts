import { describe, it, expect } from 'vitest';
import {
  parseChecklistItem,
  serializeChecklistItem,
  parseChecklist,
  serializeChecklist,
  parseLog,
  serializeLogEntry,
  generateShortId,
  generateUniqueId,
  computeCounts,
  archivePath,
  parseMetaToken,
  serializeMetaToken,
  encodeMetaValue,
  decodeMetaValue,
  isValidTag,
  assertValidTags,
} from '../todos/parser.js';
import type { TodoItem, LogEntry } from '../todos/types.js';

function makeItem(overrides: Partial<TodoItem> & { id: string; description: string; status: TodoItem['status']; tags: string[]; session: string | null }): TodoItem {
  return {
    branch: null,
    worktreePath: null,
    createdAt: null,
    updatedAt: null,
    planDir: null,
    linkedAssignmentId: null,
    linkedAssignmentRef: null,
    bundleId: null,
    ...overrides,
  };
}

describe('parseChecklistItem', () => {
  it('parses an open item', () => {
    const item = parseChecklistItem('- [ ] Fix broken link in README #docs [t:a3f1]');
    expect(item).toEqual(makeItem({
      id: 'a3f1',
      description: 'Fix broken link in README',
      status: 'open',
      tags: ['docs'],
      session: null,
    }));
  });

  it('parses a completed item', () => {
    const item = parseChecklistItem('- [x] Rename getUserById to findUser #api #refactor [t:d4e8]');
    expect(item).toEqual(makeItem({
      id: 'd4e8',
      description: 'Rename getUserById to findUser',
      status: 'completed',
      tags: ['api', 'refactor'],
      session: null,
    }));
  });

  it('parses a blocked item', () => {
    const item = parseChecklistItem('- [!] Update error messages #cleanup [t:f9a0]');
    expect(item).toEqual(makeItem({
      id: 'f9a0',
      description: 'Update error messages',
      status: 'blocked',
      tags: ['cleanup'],
      session: null,
    }));
  });

  it('parses an in-progress item with session', () => {
    const item = parseChecklistItem('- [>:d4e8f1a9] Add timeout #api [t:b7c2]');
    expect(item).toEqual(makeItem({
      id: 'b7c2',
      description: 'Add timeout',
      status: 'in_progress',
      tags: ['api'],
      session: 'd4e8f1a9',
    }));
  });

  it('parses an item with no tags', () => {
    const item = parseChecklistItem('- [ ] Simple task [t:1234]');
    expect(item).toEqual(makeItem({
      id: '1234',
      description: 'Simple task',
      status: 'open',
      tags: [],
      session: null,
    }));
  });

  it('returns null for non-item lines', () => {
    expect(parseChecklistItem('# Quick Todos')).toBeNull();
    expect(parseChecklistItem('')).toBeNull();
    expect(parseChecklistItem('Some text')).toBeNull();
  });
});

describe('parseChecklistItem — description with tag-like / id-like prose (B2, lossless via escaping)', () => {
  it('(a) keeps prose after a "#42" token and invents no tag', () => {
    const item = makeItem({
      id: 'a3f1',
      description: 'fix bug #42 in lexer',
      status: 'open',
      tags: [],
      session: null,
    });
    const reparsed = parseChecklistItem(serializeChecklistItem(item));
    expect(reparsed).toEqual(item);
    expect(reparsed?.description).toBe('fix bug #42 in lexer');
    expect(reparsed?.tags).toEqual([]);
  });

  it('(b) keeps literal "[t:dead]"-shaped prose and does not set id "dead"', () => {
    const item = makeItem({
      id: 'b7c2',
      description: 'see [t:dead] note',
      status: 'open',
      tags: [],
      session: null,
    });
    const reparsed = parseChecklistItem(serializeChecklistItem(item));
    expect(reparsed).toEqual(item);
    expect(reparsed?.description).toBe('see [t:dead] note');
    expect(reparsed?.id).toBe('b7c2');
  });

  it('(c) description ending in "#urgent" plus a real #p1 tag → description retains "#urgent", tags == [p1]', () => {
    const item = makeItem({
      id: 'c3d4',
      description: 'ship the fix and #urgent',
      status: 'open',
      tags: ['p1'],
      session: null,
    });
    const reparsed = parseChecklistItem(serializeChecklistItem(item));
    expect(reparsed).toEqual(item);
    expect(reparsed?.description).toBe('ship the fix and #urgent');
    expect(reparsed?.tags).toEqual(['p1']);
  });

  it('round-trips a description containing a literal backslash', () => {
    const item = makeItem({
      id: 'dddd',
      description: 'use C:\\path and \\#notatag here',
      status: 'open',
      tags: ['real'],
      session: null,
    });
    const reparsed = parseChecklistItem(serializeChecklistItem(item));
    expect(reparsed).toEqual(item);
  });

  // AC2: a newline in the description must not split the line and drop the id +
  // tail on re-parse.
  it('round-trips a description containing newlines (id + tail preserved)', () => {
    const item = makeItem({
      id: 'ee01',
      description: 'Line one\nLine two with detail\r\nLine three',
      status: 'open',
      tags: ['multi'],
      session: null,
    });
    const serialized = serializeChecklistItem(item);
    expect(serialized).not.toContain('\n'); // single physical line
    const reparsed = parseChecklistItem(serialized);
    expect(reparsed).toEqual(item);
  });

  // AC2: a literal backslash-n in the source must NOT be decoded to a newline.
  it('preserves a literal backslash-n (distinct from an encoded newline)', () => {
    const item = makeItem({
      id: 'ee02',
      description: 'regex \\n means newline',
      status: 'open',
      tags: [],
      session: null,
    });
    const reparsed = parseChecklistItem(serializeChecklistItem(item));
    expect(reparsed).toEqual(item);
    expect(reparsed?.description).toBe('regex \\n means newline');
  });
});

describe('serializeChecklistItem', () => {
  it('serializes an open item', () => {
    const item = makeItem({ id: 'a3f1', description: 'Fix link', status: 'open', tags: ['docs'], session: null });
    expect(serializeChecklistItem(item)).toBe('- [ ] Fix link #docs [t:a3f1]');
  });

  it('serializes an in-progress item with session', () => {
    const item = makeItem({ id: 'b7c2', description: 'Add timeout', status: 'in_progress', tags: [], session: 'abc123' });
    expect(serializeChecklistItem(item)).toBe('- [>:abc123] Add timeout [t:b7c2]');
  });

  it('serializes a blocked item', () => {
    const item = makeItem({ id: 'f9a0', description: 'Update errors', status: 'blocked', tags: ['api'], session: null });
    expect(serializeChecklistItem(item)).toBe('- [!] Update errors #api [t:f9a0]');
  });

  it('emits no meta token when all meta fields are null', () => {
    const item = makeItem({ id: 'aaaa', description: 'x', status: 'open', tags: [], session: null });
    expect(serializeChecklistItem(item)).toBe('- [ ] x [t:aaaa]');
  });

  it('emits a meta token when meta fields are set', () => {
    const item = makeItem({
      id: 'aaaa',
      description: 'x',
      status: 'open',
      tags: [],
      session: null,
      branch: 'feat/foo',
      createdAt: '2026-04-29T12:00:00Z',
      updatedAt: '2026-04-29T12:30:00Z',
    });
    expect(serializeChecklistItem(item)).toBe(
      '- [ ] x [t:aaaa] <b=feat/foo;c=2026-04-29T12:00:00Z;u=2026-04-29T12:30:00Z>',
    );
  });
});

describe('parseMetaToken / serializeMetaToken', () => {
  it('parses a full meta token', () => {
    const m = parseMetaToken('- [ ] x [t:aaaa] <b=feat/foo;w=/tmp/wt;c=2026-04-29T12:00:00Z;u=2026-04-29T12:30:00Z;p=/plans/aaaa>');
    expect(m).toEqual({
      branch: 'feat/foo',
      worktreePath: '/tmp/wt',
      createdAt: '2026-04-29T12:00:00Z',
      updatedAt: '2026-04-29T12:30:00Z',
      planDir: '/plans/aaaa',
      linkedAssignmentId: null,
      linkedAssignmentRef: null,
      bundleId: null,
    });
  });

  it('returns all-null for legacy line without meta token', () => {
    const m = parseMetaToken('- [ ] x [t:aaaa]');
    expect(m).toEqual({
      branch: null,
      worktreePath: null,
      createdAt: null,
      updatedAt: null,
      planDir: null,
      linkedAssignmentId: null,
      linkedAssignmentRef: null,
      bundleId: null,
    });
  });

  it('round-trips linkedAssignmentId + linkedAssignmentRef through serialize/parse', () => {
    const original = makeItem({
      id: 'aaaa',
      description: 'Build the thing',
      status: 'in_progress',
      tags: [],
      session: null,
      linkedAssignmentId: 'de2f0367-697b-4e3a-8457-1ccd43c5518c',
      linkedAssignmentRef: 'syntaur-meta/promote-todos-to-assignment-from-dashboard',
    });
    const line = serializeChecklistItem(original);
    expect(line).toContain('l=de2f0367-697b-4e3a-8457-1ccd43c5518c');
    expect(line).toContain('lr=syntaur-meta/promote-todos-to-assignment-from-dashboard');
    const parsed = parseChecklistItem(line);
    expect(parsed?.linkedAssignmentId).toBe('de2f0367-697b-4e3a-8457-1ccd43c5518c');
    expect(parsed?.linkedAssignmentRef).toBe('syntaur-meta/promote-todos-to-assignment-from-dashboard');
  });

  it('round-trips percent-encoded special characters', () => {
    const original = makeItem({
      id: 'aaaa',
      description: 'x',
      status: 'open',
      tags: [],
      session: null,
      branch: 'feat/has=equals;and<angles>and[brackets]100%',
    });
    const line = serializeChecklistItem(original);
    const parsed = parseChecklistItem(line);
    expect(parsed?.branch).toBe('feat/has=equals;and<angles>and[brackets]100%');
  });

  it('is order-insensitive on parse', () => {
    const m = parseMetaToken('- [ ] x [t:aaaa] <u=2026;b=foo;c=2025>');
    expect(m.branch).toBe('foo');
    expect(m.createdAt).toBe('2025');
    expect(m.updatedAt).toBe('2026');
  });

  it('drops unknown keys silently', () => {
    const m = parseMetaToken('- [ ] x [t:aaaa] <b=foo;x=ignored>');
    expect(m.branch).toBe('foo');
  });

  it('preserves "<" inside the description (cut still happens at id)', () => {
    const item = parseChecklistItem('- [ ] add <html> example #web [t:aaaa]');
    expect(item?.description).toBe('add <html> example');
  });

  it('encodeMetaValue / decodeMetaValue round-trip', () => {
    const raw = 'a;b=c<d>e[f]g%h';
    const encoded = encodeMetaValue(raw);
    expect(encoded).not.toContain(';');
    expect(encoded).not.toContain('=');
    expect(encoded).not.toContain('<');
    expect(decodeMetaValue(encoded)).toBe(raw);
  });

  it('serializeMetaToken returns empty string when nothing to emit', () => {
    const item = makeItem({ id: 'a', description: 'x', status: 'open', tags: [], session: null });
    expect(serializeMetaToken(item)).toBe('');
  });
});

describe('parseChecklist', () => {
  it('parses a full checklist file', () => {
    const content = `---
workspace: syntaur
archiveInterval: weekly
---

# Quick Todos

- [ ] Fix link #docs [t:a3f1]
- [x] Done task [t:b7c2]
`;
    const checklist = parseChecklist(content);
    expect(checklist.workspace).toBe('syntaur');
    expect(checklist.archiveInterval).toBe('weekly');
    expect(checklist.items).toHaveLength(2);
    expect(checklist.items[0].status).toBe('open');
    expect(checklist.items[1].status).toBe('completed');
  });

  it('returns defaults for missing frontmatter', () => {
    const checklist = parseChecklist('- [ ] Task [t:1234]');
    expect(checklist.workspace).toBe('_global');
    expect(checklist.archiveInterval).toBe('weekly');
    expect(checklist.items).toHaveLength(1);
  });
});

describe('serializeChecklist round-trip', () => {
  it('preserves content through parse/serialize', () => {
    const original = `---
workspace: test
archiveInterval: monthly
---

# Quick Todos

- [ ] Task one #tag1 [t:aaaa]
- [x] Task two #tag2 [t:bbbb]
`;
    const parsed = parseChecklist(original);
    const serialized = serializeChecklist(parsed);
    const reparsed = parseChecklist(serialized);
    expect(reparsed.workspace).toBe(parsed.workspace);
    expect(reparsed.archiveInterval).toBe(parsed.archiveInterval);
    expect(reparsed.items).toEqual(parsed.items);
  });
});

describe('parseLog', () => {
  it('parses log entries', () => {
    const content = `---
workspace: syntaur
---

# Todo Log

### 2026-04-07T14:30:00Z — t:a3f1, t:b7c2
**Items:** Fix link, Add timeout
**Session:** d4e8f1a9
**Branch:** fix/readme
**Summary:** Fixed dead link.

### 2026-04-07T16:00:00Z — t:d4e8
**Items:** Rename getUserById
**Summary:** 14 files changed.
**Blockers:** GraphQL resolver needs schema migration.
`;
    const log = parseLog(content);
    expect(log.workspace).toBe('syntaur');
    expect(log.entries).toHaveLength(2);
    expect(log.entries[0].itemIds).toEqual(['a3f1', 'b7c2']);
    expect(log.entries[0].session).toBe('d4e8f1a9');
    expect(log.entries[0].branch).toBe('fix/readme');
    expect(log.entries[1].blockers).toBe('GraphQL resolver needs schema migration.');
  });
});

describe('serializeLogEntry', () => {
  it('serializes a log entry', () => {
    const entry: LogEntry = {
      timestamp: '2026-04-07T14:30:00Z',
      itemIds: ['a3f1'],
      items: 'Fix link',
      session: 'abc123',
      branch: 'fix/link',
      summary: 'Fixed it.',
      blockers: null,
      status: null,
    };
    const result = serializeLogEntry(entry);
    expect(result).toContain('### 2026-04-07T14:30:00Z — t:a3f1');
    expect(result).toContain('**Items:** Fix link');
    expect(result).toContain('**Session:** abc123');
    expect(result).toContain('**Branch:** fix/link');
    expect(result).toContain('**Summary:** Fixed it.');
    expect(result).not.toContain('Blockers');
  });
});

describe('generateShortId', () => {
  it('generates 4-character hex strings', () => {
    const id = generateShortId();
    expect(id).toMatch(/^[a-f0-9]{4}$/);
  });
});

describe('generateUniqueId', () => {
  it('avoids collisions', () => {
    const existing = new Set(['0000', '0001', '0002']);
    const id = generateUniqueId(existing);
    expect(existing.has(id)).toBe(false);
    expect(id).toMatch(/^[a-f0-9]{4}$/);
  });
});

describe('computeCounts', () => {
  it('computes status counts', () => {
    const items: TodoItem[] = [
      makeItem({ id: '1', description: 'a', status: 'open', tags: [], session: null }),
      makeItem({ id: '2', description: 'b', status: 'open', tags: [], session: null }),
      makeItem({ id: '3', description: 'c', status: 'completed', tags: [], session: null }),
      makeItem({ id: '4', description: 'd', status: 'blocked', tags: [], session: null }),
    ];
    const counts = computeCounts(items);
    expect(counts).toEqual({ open: 2, in_progress: 0, completed: 1, blocked: 1, total: 4 });
  });
});

describe('archivePath', () => {
  it('generates daily archive path', () => {
    const path = archivePath('/tmp/todos', 'syntaur', 'daily', new Date(2026, 3, 7));
    expect(path).toContain('archive/syntaur-2026-04-07.md');
  });

  it('generates weekly archive path', () => {
    const path = archivePath('/tmp/todos', 'syntaur', 'weekly', new Date(2026, 3, 7));
    expect(path).toContain('archive/syntaur-2026-W');
  });

  it('generates monthly archive path', () => {
    const path = archivePath('/tmp/todos', 'syntaur', 'monthly', new Date(2026, 3, 7));
    expect(path).toContain('archive/syntaur-2026-04.md');
  });
});

// AC5: tags are emitted raw (`#${t}`) while the description is escaped, so a tag
// with whitespace/newline/`#` corrupts the single-line checklist entry and the
// next parse drops the [t:id] + metadata. Validate at every entry + serializer.
describe('tag validation prevents checklist corruption (AC5)', () => {
  it('isValidTag accepts the parser tag class, rejects everything else', () => {
    expect(isValidTag('api')).toBe(true);
    expect(isValidTag('v2_x-y')).toBe(true);
    expect(isValidTag('foo bar')).toBe(false); // space
    expect(isValidTag('foo\nbar')).toBe(false); // newline
    expect(isValidTag('foo#bar')).toBe(false); // hash
    expect(isValidTag('')).toBe(false); // empty
    expect(isValidTag(123 as unknown as string)).toBe(false); // non-string
  });

  it('assertValidTags throws on any invalid tag, passes valid arrays', () => {
    expect(() => assertValidTags(['ok', 'a-b_c'])).not.toThrow();
    expect(() => assertValidTags([])).not.toThrow();
    expect(() => assertValidTags(['bad tag'])).toThrow();
    expect(() => assertValidTags(['has\nnewline'])).toThrow();
    expect(() => assertValidTags([123 as unknown as string])).toThrow();
  });

  it('serializeChecklistItem throws rather than emit a corrupting line', () => {
    for (const bad of ['foo bar', 'foo\nbar', 'foo#bar', '']) {
      const item = makeItem({ id: 'a1', description: 'task', status: 'open', tags: [bad], session: null });
      expect(() => serializeChecklistItem(item)).toThrow();
    }
  });

  it('valid tags still serialize and round-trip with id + meta intact (positive control)', () => {
    const item = makeItem({
      id: 'ab12',
      description: 'do thing',
      status: 'open',
      tags: ['api', 'v2_x'],
      session: null,
      branch: 'feat/x',
    });
    const reparsed = parseChecklistItem(serializeChecklistItem(item));
    expect(reparsed?.id).toBe('ab12');
    expect(reparsed?.tags).toEqual(['api', 'v2_x']);
    expect(reparsed?.branch).toBe('feat/x');
  });
});
