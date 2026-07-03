import { describe, it, expect, vi } from 'vitest';
import { isNativeLaunchEligible, injectBgArgs, launchClaudeBg } from '../launch.js';
import type { AgentConfig } from '../../../utils/config.js';

const agent: AgentConfig = { id: 'claude', label: 'Claude', command: 'claude' };

describe('isNativeLaunchEligible', () => {
  it('is eligible for a plain claude agent with no print flag', () => {
    expect(isNativeLaunchEligible(agent, ['/grab-assignment p a'])).toBe(true);
  });

  it('is ineligible when the agent resolves from shell aliases', () => {
    expect(isNativeLaunchEligible({ ...agent, resolveFromShellAliases: true }, ['hi'])).toBe(false);
  });

  it('is ineligible when args contain -p', () => {
    expect(isNativeLaunchEligible(agent, ['-p', 'hi'])).toBe(false);
  });

  it('is ineligible when args contain --print', () => {
    expect(isNativeLaunchEligible(agent, ['hi', '--print'])).toBe(false);
  });
});

describe('injectBgArgs', () => {
  it('prepends --bg --name <name>, preserving existing args verbatim', () => {
    expect(injectBgArgs(['/grab-assignment p a', '--agent', 'b'], 'proj/a1')).toEqual([
      '--bg', '--name', 'proj/a1', '/grab-assignment p a', '--agent', 'b',
    ]);
  });

  it('preserves a --model flag already in the args', () => {
    expect(injectBgArgs(['hi', '--model', 'opus'], 'p/a')).toEqual(['--bg', '--name', 'p/a', 'hi', '--model', 'opus']);
  });
});

describe('launchClaudeBg', () => {
  it('spawns plan.command with injected --bg argv in plan.cwd', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: '' }));
    await launchClaudeBg({
      plan: { command: 'claude', args: ['/grab-assignment p a', '--agent', 'b'], cwd: '/repo/.worktrees/feat' },
      name: 'proj/a1',
      exec,
    });
    expect(exec).toHaveBeenCalledWith(
      'claude',
      ['--bg', '--name', 'proj/a1', '/grab-assignment p a', '--agent', 'b'],
      { cwd: '/repo/.worktrees/feat' },
    );
  });
});
