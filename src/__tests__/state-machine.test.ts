import { describe, it, expect } from 'vitest';
import { canTransition, getTargetStatus, isTerminalStatus } from '../lifecycle/state-machine.js';

describe('state-machine', () => {
  describe('canTransition (guards removed — always true for known commands)', () => {
    it('returns true for any known command regardless of current status', () => {
      expect(canTransition('pending', 'start')).toBe(true);
      expect(canTransition('completed', 'start')).toBe(true);
      expect(canTransition('failed', 'complete')).toBe(true);
      expect(canTransition('blocked', 'review')).toBe(true);
    });

    it('returns false for unknown commands', () => {
      expect(canTransition('pending', 'nonexistent')).toBe(false);
    });
  });

  describe('getTargetStatus', () => {
    it('returns in_progress for start', () => {
      expect(getTargetStatus('pending', 'start')).toBe('in_progress');
      expect(getTargetStatus('review', 'start')).toBe('in_progress');
      expect(getTargetStatus('completed', 'start')).toBe('in_progress');
    });

    it('returns blocked for block', () => {
      expect(getTargetStatus('pending', 'block')).toBe('blocked');
      expect(getTargetStatus('in_progress', 'block')).toBe('blocked');
    });

    it('returns completed for complete', () => {
      expect(getTargetStatus('in_progress', 'complete')).toBe('completed');
    });

    it('returns in_progress for unblock', () => {
      expect(getTargetStatus('blocked', 'unblock')).toBe('in_progress');
    });

    it('returns review for review', () => {
      expect(getTargetStatus('in_progress', 'review')).toBe('review');
    });

    it('returns failed for fail', () => {
      expect(getTargetStatus('in_progress', 'fail')).toBe('failed');
    });

    it('returns in_progress for reopen', () => {
      expect(getTargetStatus('completed', 'reopen')).toBe('in_progress');
      expect(getTargetStatus('failed', 'reopen')).toBe('in_progress');
    });

    it('returns null for unknown command', () => {
      expect(getTargetStatus('pending', 'nonexistent')).toBeNull();
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
