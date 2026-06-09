import { describe, expect, it } from 'vitest';
import {
  formatAgentLine,
  buildAgentFromOptions,
  mergeOptionsIntoAgent,
} from '../commands/agents.js';
import type { AgentConfig } from '../utils/config.js';

const base: AgentConfig = { id: 'claude', label: 'Claude', command: 'claude' };

describe('formatAgentLine (CLI diff representation)', () => {
  it('includes model and playbook in the line', () => {
    const line = formatAgentLine({ ...base, model: 'opus', playbook: 'e2e-dev-cycle' });
    expect(line).toContain('model=opus');
    expect(line).toContain('playbook=e2e-dev-cycle');
  });

  it('produces a DIFFERENT line when only the model changes (so renderDiff sees a change)', () => {
    // This is the regression guard: before the fix, formatAgentLine ignored
    // model/playbook, so a `set --model X` rendered an identical line and
    // renderDiff falsely reported "(no changes)".
    expect(formatAgentLine(base)).not.toBe(formatAgentLine({ ...base, model: 'opus' }));
  });

  it('produces a DIFFERENT line when only the playbook changes', () => {
    expect(formatAgentLine(base)).not.toBe(
      formatAgentLine({ ...base, playbook: 'create-and-plan-assignment' }),
    );
  });

  it('omits model/playbook flags when unset', () => {
    const line = formatAgentLine(base);
    expect(line).not.toContain('model=');
    expect(line).not.toContain('playbook=');
  });

  it('includes the FULL launchPrompt (not truncated) for diff identity', () => {
    const a = '@assignment Run @e2e-dev-cycle then do the first long thing carefully please';
    const b = '@assignment Run @e2e-dev-cycle then do the second long thing carefully please';
    // Two prompts sharing a 40+ char prefix must still render distinct lines,
    // or a launchPrompt-only `set` would falsely report "(no changes)".
    expect(formatAgentLine({ ...base, launchPrompt: a })).not.toBe(
      formatAgentLine({ ...base, launchPrompt: b }),
    );
    expect(formatAgentLine({ ...base, launchPrompt: a })).toContain(a);
  });

  it('produces a DIFFERENT line when only the launchPrompt changes', () => {
    expect(formatAgentLine(base)).not.toBe(
      formatAgentLine({ ...base, launchPrompt: '@assignment go' }),
    );
  });
});

describe('CLI add/set launchPrompt', () => {
  it('add --launch-prompt sets the field (stored untrimmed)', () => {
    const agent = buildAgentFromOptions(
      { id: 'a', label: 'A', command: 'claude', launchPrompt: '  @assignment go  ' },
      null,
    );
    expect(agent.launchPrompt).toBe('  @assignment go  ');
  });

  it('add with blank --launch-prompt omits the field', () => {
    const agent = buildAgentFromOptions(
      { id: 'a', label: 'A', command: 'claude', launchPrompt: '   ' },
      null,
    );
    expect(agent.launchPrompt).toBeUndefined();
  });

  it('set --launch-prompt updates the field', () => {
    const merged = mergeOptionsIntoAgent(base, { launchPrompt: '@assignment Run @e2e-dev-cycle.' });
    expect(merged.launchPrompt).toBe('@assignment Run @e2e-dev-cycle.');
  });

  it('set --launch-prompt "" clears the field', () => {
    const merged = mergeOptionsIntoAgent({ ...base, launchPrompt: 'something' }, { launchPrompt: '' });
    expect(merged.launchPrompt).toBeUndefined();
  });

  it('set without --launch-prompt leaves an existing value untouched', () => {
    const merged = mergeOptionsIntoAgent({ ...base, launchPrompt: 'keep me' }, { model: 'opus' });
    expect(merged.launchPrompt).toBe('keep me');
  });
});
