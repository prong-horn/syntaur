import { describe, it, expect } from 'vitest';
import { canTransition, getTargetStatus, isTerminalStatus } from '../lifecycle/state-machine.js';

describe('state-machine', () => {
  describe('canTransition', () => {
    it('allows pending -> in_progress via start', () => {
      expect(canTransition('pending', 'start')).toBe(true);
    });

    it('allows pending -> blocked via block', () => {
      expect(canTransition('pending', 'block')).toBe(true);
    });

    it('allows in_progress -> blocked via block', () => {
      expect(canTransition('in_progress', 'block')).toBe(true);
    });

    it('allows in_progress -> review via review', () => {
      expect(canTransition('in_progress', 'review')).toBe(true);
    });

    it('allows in_progress -> completed via complete', () => {
      expect(canTransition('in_progress', 'complete')).toBe(true);
    });

    it('allows in_progress -> failed via fail', () => {
      expect(canTransition('in_progress', 'fail')).toBe(true);
    });

    it('allows blocked -> in_progress via unblock', () => {
      expect(canTransition('blocked', 'unblock')).toBe(true);
    });

    it('allows review -> in_progress via start (rework)', () => {
      expect(canTransition('review', 'start')).toBe(true);
    });

    it('allows review -> completed via complete', () => {
      expect(canTransition('review', 'complete')).toBe(true);
    });

    it('allows review -> failed via fail', () => {
      expect(canTransition('review', 'fail')).toBe(true);
    });

    it('allows completed -> in_progress via reopen', () => {
      expect(canTransition('completed', 'reopen')).toBe(true);
    });

    it('allows failed -> in_progress via reopen', () => {
      expect(canTransition('failed', 'reopen')).toBe(true);
    });

    it('rejects completed -> anything except reopen', () => {
      expect(canTransition('completed', 'start')).toBe(false);
      expect(canTransition('completed', 'complete')).toBe(false);
      expect(canTransition('completed', 'block')).toBe(false);
      expect(canTransition('completed', 'unblock')).toBe(false);
      expect(canTransition('completed', 'review')).toBe(false);
      expect(canTransition('completed', 'fail')).toBe(false);
    });

    it('rejects failed -> anything except reopen', () => {
      expect(canTransition('failed', 'start')).toBe(false);
      expect(canTransition('failed', 'complete')).toBe(false);
      expect(canTransition('failed', 'block')).toBe(false);
      expect(canTransition('failed', 'unblock')).toBe(false);
      expect(canTransition('failed', 'review')).toBe(false);
      expect(canTransition('failed', 'fail')).toBe(false);
    });

    it('rejects invalid transitions from non-terminal statuses', () => {
      expect(canTransition('pending', 'complete')).toBe(false);
      expect(canTransition('pending', 'review')).toBe(false);
      expect(canTransition('pending', 'fail')).toBe(false);
      expect(canTransition('pending', 'unblock')).toBe(false);
      expect(canTransition('blocked', 'start')).toBe(false);
      expect(canTransition('blocked', 'complete')).toBe(false);
      expect(canTransition('blocked', 'review')).toBe(false);
      expect(canTransition('blocked', 'fail')).toBe(false);
      expect(canTransition('review', 'block')).toBe(false);
      expect(canTransition('review', 'unblock')).toBe(false);
      expect(canTransition('in_progress', 'start')).toBe(false);
      expect(canTransition('in_progress', 'unblock')).toBe(false);
    });
  });

  describe('getTargetStatus', () => {
    it('returns in_progress for pending:start', () => {
      expect(getTargetStatus('pending', 'start')).toBe('in_progress');
    });

    it('returns blocked for pending:block', () => {
      expect(getTargetStatus('pending', 'block')).toBe('blocked');
    });

    it('returns completed for in_progress:complete', () => {
      expect(getTargetStatus('in_progress', 'complete')).toBe('completed');
    });

    it('returns null for invalid transition', () => {
      expect(getTargetStatus('completed', 'start')).toBeNull();
    });

    it('returns in_progress for review:start (rework)', () => {
      expect(getTargetStatus('review', 'start')).toBe('in_progress');
    });

    it('returns in_progress for completed:reopen', () => {
      expect(getTargetStatus('completed', 'reopen')).toBe('in_progress');
    });

    it('returns in_progress for failed:reopen', () => {
      expect(getTargetStatus('failed', 'reopen')).toBe('in_progress');
    });
  });

  describe('isTerminalStatus', () => {
    it('returns true for completed', () => {
      expect(isTerminalStatus('completed')).toBe(true);
    });

    it('returns true for failed', () => {
      expect(isTerminalStatus('failed')).toBe(true);
    });

    it('returns false for non-terminal statuses', () => {
      expect(isTerminalStatus('pending')).toBe(false);
      expect(isTerminalStatus('in_progress')).toBe(false);
      expect(isTerminalStatus('blocked')).toBe(false);
      expect(isTerminalStatus('review')).toBe(false);
    });
  });
});
