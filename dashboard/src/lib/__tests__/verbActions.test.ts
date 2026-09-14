import { describe, expect, it } from 'vitest';
import {
  offeredVerbCommands,
  pickPrimaryVerb,
  pickSecondaryVerbs,
  verbFromNextLine,
} from '../verbActions';
import type { TicketTransitionAction } from '../../hooks/useProjects';

function action(command: string, targetStatus: string): TicketTransitionAction {
  return {
    command,
    label: command,
    description: command,
    targetStatus,
    disabled: false,
    disabledReason: null,
    warning: null,
    requiresReason: command === 'drop' || command === 'block' || command === 'park',
  };
}

describe('verbActions', () => {
  it('parses verbs from Next lines', () => {
    expect(verbFromNextLine('Next: syntaur plan create SCR-1')).toBe('plan');
    expect(verbFromNextLine('Next: syntaur approve SYN-1')).toBe('approve');
    expect(verbFromNextLine('Next: syntaur start SYN-1')).toBe('start');
    expect(verbFromNextLine(null)).toBeNull();
  });

  it('offers stage-appropriate move and flag verbs per template', () => {
    expect(offeredVerbCommands('feature', 'backlog', { blocked: null, parked: null })).toEqual([
      'plan',
      'drop',
      'block',
      'park',
    ]);
    expect(offeredVerbCommands('quick', 'backlog', { blocked: null, parked: null })).toEqual([
      'done',
      'drop',
      'block',
      'park',
    ]);
    expect(
      offeredVerbCommands('bug', 'review', { blocked: 'waiting', parked: null }),
    ).toEqual(['plan', 'approve', 'done', 'drop', 'unblock', 'park']);
    expect(
      offeredVerbCommands('feature', 'done', { blocked: null, parked: null }),
    ).toEqual(['reopen']);
  });

  it('picks primary from Next and secondary flag verbs', () => {
    const available = [
      action('plan', 'planning'),
      action('drop', 'dropped'),
      action('block', 'backlog'),
    ];
    const primary = pickPrimaryVerb('Next: syntaur plan create SCR-1', available);
    expect(primary?.command).toBe('plan');
    const secondary = pickSecondaryVerbs(available, primary);
    expect(secondary.map((a) => a.command)).toEqual(['drop', 'block']);
  });
});
