import { describe, it, expect, vi } from 'vitest';
import { isNativeLaunchEligible, injectBgArgs, launchClaudeBg, type ExecFn } from '../launch.js';
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
      expect.objectContaining({ cwd: '/repo/.worktrees/feat' }),
    );
  });

  it('plants SYNTAUR_HOSTED_BY=claude-bg in the exec env, inheriting the rest of process.env', async () => {
    const exec = vi.fn<ExecFn>(async () => ({ code: 0, stdout: '' }));
    await launchClaudeBg({
      plan: { command: 'claude', args: ['hi'], cwd: '/x' },
      name: 'proj/a1',
      exec,
    });
    const opts = exec.mock.calls[0][2];
    expect(opts.env?.SYNTAUR_HOSTED_BY).toBe('claude-bg');
    // The parent env is inherited, not replaced — the child still needs PATH etc.
    expect(opts.env?.PATH).toBe(process.env.PATH);
  });

  it('plants no SYNTAUR_LAUNCH_ID — the native tier creates no placeholder row', async () => {
    const exec = vi.fn<ExecFn>(async () => ({ code: 0, stdout: '' }));
    await launchClaudeBg({ plan: { command: 'claude', args: ['hi'], cwd: '/x' }, name: 'proj/a1', exec });
    expect(exec.mock.calls[0][2].env?.SYNTAUR_LAUNCH_ID).toBeUndefined();
  });
});
