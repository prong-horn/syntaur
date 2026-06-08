import { describe, expect, it } from 'vitest';
import { formatAgentLine } from '../commands/agents.js';
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
});
