import { describe, expect, it } from 'vitest';
import { computeWorktreeDefaults } from '../utils/worktree-defaults.js';

describe('computeWorktreeDefaults', () => {
  it('uses project-prefixed branch when projectSlug is non-empty', () => {
    const out = computeWorktreeDefaults({
      projectSlug: 'proj',
      assignmentSlug: 'task',
      existing: { repository: '/r', branch: null, parentBranch: null },
    });
    expect(out.branch).toBe('syntaur/proj/task');
    expect(out.worktreePath).toBe('/r/.worktrees/syntaur/proj/task');
    expect(out.repository).toBe('/r');
    expect(out.parentBranch).toBeDefined();
  });

  it('drops the project segment when projectSlug is empty (standalone fallback)', () => {
    const out = computeWorktreeDefaults({
      projectSlug: '',
      assignmentSlug: 'task',
      existing: { repository: '/r', branch: null, parentBranch: null },
    });
    expect(out.branch).toBe('syntaur/task');
    expect(out.worktreePath).toBe('/r/.worktrees/syntaur/task');
  });

  it('honors existing parentBranch instead of falling back', () => {
    const out = computeWorktreeDefaults({
      projectSlug: 'proj',
      assignmentSlug: 'task',
      existing: { repository: '/r', branch: null, parentBranch: 'develop' },
    });
    expect(out.parentBranch).toBe('develop');
  });

  it('honors existing repository instead of probing cwd', () => {
    const out = computeWorktreeDefaults({
      projectSlug: 'proj',
      assignmentSlug: 'task',
      existing: { repository: '/custom/repo', branch: null, parentBranch: null },
    });
    expect(out.repository).toBe('/custom/repo');
    expect(out.worktreePath).toBe('/custom/repo/.worktrees/syntaur/proj/task');
  });
});
