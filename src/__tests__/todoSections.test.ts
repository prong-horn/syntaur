import { describe, expect, it } from 'vitest';
import {
  TODO_SECTIONS,
  groupTodosBySections,
  sectionIdForStatus,
  type TodoSectionId,
} from '../utils/todoSections.js';
import type { TodoStatus } from '../todos/types.js';

const todo = (id: string, status: TodoStatus) => ({ id, status });

describe('sectionIdForStatus', () => {
  it('maps open and blocked into the open-blocked section', () => {
    expect(sectionIdForStatus('open')).toBe('open-blocked');
    expect(sectionIdForStatus('blocked')).toBe('open-blocked');
  });

  it('maps in_progress to in-progress and completed to done', () => {
    expect(sectionIdForStatus('in_progress')).toBe('in-progress');
    expect(sectionIdForStatus('completed')).toBe('done');
  });
});

describe('TODO_SECTIONS', () => {
  it('declares the three sections in fixed order', () => {
    expect(TODO_SECTIONS.map((s) => s.id)).toEqual([
      'open-blocked',
      'in-progress',
      'done',
    ]);
  });

  it('defaults Done collapsed and the others expanded', () => {
    const byId = Object.fromEntries(TODO_SECTIONS.map((s) => [s.id, s])) as Record<
      TodoSectionId,
      (typeof TODO_SECTIONS)[number]
    >;
    expect(byId['open-blocked'].defaultCollapsed).toBe(false);
    expect(byId['in-progress'].defaultCollapsed).toBe(false);
    expect(byId.done.defaultCollapsed).toBe(true);
  });

  it('uses open/in_progress/completed as the drop statuses', () => {
    const byId = Object.fromEntries(TODO_SECTIONS.map((s) => [s.id, s]));
    expect(byId['open-blocked'].dropStatus).toBe('open');
    expect(byId['in-progress'].dropStatus).toBe('in_progress');
    expect(byId.done.dropStatus).toBe('completed');
  });
});

describe('groupTodosBySections', () => {
  it('returns all three sections in order even when empty', () => {
    const groups = groupTodosBySections([]);
    expect(groups.map((g) => g.config.id)).toEqual([
      'open-blocked',
      'in-progress',
      'done',
    ]);
    expect(groups.every((g) => g.items.length === 0)).toBe(true);
  });

  it('places each todo in its section, merging open + blocked', () => {
    const items = [
      todo('a', 'open'),
      todo('b', 'blocked'),
      todo('c', 'in_progress'),
      todo('d', 'completed'),
    ];
    const groups = groupTodosBySections(items);
    const byId = Object.fromEntries(groups.map((g) => [g.config.id, g.items.map((i) => i.id)]));
    expect(byId['open-blocked']).toEqual(['a', 'b']);
    expect(byId['in-progress']).toEqual(['c']);
    expect(byId.done).toEqual(['d']);
  });

  it('preserves the relative input order within a section', () => {
    const items = [
      todo('x1', 'open'),
      todo('b1', 'blocked'),
      todo('x2', 'open'),
      todo('b2', 'blocked'),
    ];
    const [openBlocked] = groupTodosBySections(items);
    expect(openBlocked.items.map((i) => i.id)).toEqual(['x1', 'b1', 'x2', 'b2']);
  });
});
