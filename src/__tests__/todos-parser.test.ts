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
} from '../todos/parser.js';
import type { TodoItem, LogEntry } from '../todos/types.js';

describe('parseChecklistItem', () => {
  it('parses an open item', () => {
    const item = parseChecklistItem('- [ ] Fix broken link in README #docs [t:a3f1]');
    expect(item).toEqual({
      id: 'a3f1',
      description: 'Fix broken link in README',
      status: 'open',
      tags: ['docs'],
      session: null,
    });
  });

  it('parses a completed item', () => {
    const item = parseChecklistItem('- [x] Rename getUserById to findUser #api #refactor [t:d4e8]');
    expect(item).toEqual({
      id: 'd4e8',
      description: 'Rename getUserById to findUser',
      status: 'completed',
      tags: ['api', 'refactor'],
      session: null,
    });
  });

  it('parses a blocked item', () => {
    const item = parseChecklistItem('- [!] Update error messages #cleanup [t:f9a0]');
    expect(item).toEqual({
      id: 'f9a0',
      description: 'Update error messages',
      status: 'blocked',
      tags: ['cleanup'],
      session: null,
    });
  });

  it('parses an in-progress item with session', () => {
    const item = parseChecklistItem('- [>:d4e8f1a9] Add timeout #api [t:b7c2]');
    expect(item).toEqual({
      id: 'b7c2',
      description: 'Add timeout',
      status: 'in_progress',
      tags: ['api'],
      session: 'd4e8f1a9',
    });
  });

  it('parses an item with no tags', () => {
    const item = parseChecklistItem('- [ ] Simple task [t:1234]');
    expect(item).toEqual({
      id: '1234',
      description: 'Simple task',
      status: 'open',
      tags: [],
      session: null,
    });
  });

  it('returns null for non-item lines', () => {
    expect(parseChecklistItem('# Quick Todos')).toBeNull();
    expect(parseChecklistItem('')).toBeNull();
    expect(parseChecklistItem('Some text')).toBeNull();
  });
});

describe('serializeChecklistItem', () => {
  it('serializes an open item', () => {
    const item: TodoItem = { id: 'a3f1', description: 'Fix link', status: 'open', tags: ['docs'], session: null };
    expect(serializeChecklistItem(item)).toBe('- [ ] Fix link #docs [t:a3f1]');
  });

  it('serializes an in-progress item with session', () => {
    const item: TodoItem = { id: 'b7c2', description: 'Add timeout', status: 'in_progress', tags: [], session: 'abc123' };
    expect(serializeChecklistItem(item)).toBe('- [>:abc123] Add timeout [t:b7c2]');
  });

  it('serializes a blocked item', () => {
    const item: TodoItem = { id: 'f9a0', description: 'Update errors', status: 'blocked', tags: ['api'], session: null };
    expect(serializeChecklistItem(item)).toBe('- [!] Update errors #api [t:f9a0]');
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
      { id: '1', description: 'a', status: 'open', tags: [], session: null },
      { id: '2', description: 'b', status: 'open', tags: [], session: null },
      { id: '3', description: 'c', status: 'completed', tags: [], session: null },
      { id: '4', description: 'd', status: 'blocked', tags: [], session: null },
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
