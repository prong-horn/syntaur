import { describe, it, expect, vi } from 'vitest';
import { buildTmuxLaunchArgv, tmuxSessionName, launchInTmux, tmuxSessionExists } from '../launch.js';

describe('tmux launch', () => {
  it('builds a detached new-session argv (name, cwd, agent argv)', () => {
    expect(buildTmuxLaunchArgv({
      sessionName: 'syntaur-p-a', cwd: '/repo/.worktrees/feat',
      command: 'claude', args: ['/grab-assignment p a', '--agent', 'b'],
    })).toEqual([
      'new-session', '-d', '-s', 'syntaur-p-a', '-c', '/repo/.worktrees/feat',
      'claude', '/grab-assignment p a', '--agent', 'b',
    ]);
  });
  it('tmuxSessionName is deterministic + strips . and :', () => {
    expect(tmuxSessionName('proj', 'my.assignment')).toBe('syntaur-proj-my-assignment');
    expect(tmuxSessionName(null, 'stand:alone')).toBe('syntaur-stand-alone');
  });
  it('launchInTmux runs the built argv through exec', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: '' }));
    await launchInTmux({ sessionName: 'w', cwd: '/x', command: 'claude', args: ['hi'], exec });
    expect(exec).toHaveBeenCalledWith('tmux', ['new-session', '-d', '-s', 'w', '-c', '/x', 'claude', 'hi']);
  });
  it('tmuxSessionExists parses `has-session` exit', async () => {
    const ok = vi.fn(async () => ({ code: 0, stdout: '' }));
    expect(await tmuxSessionExists('w', ok)).toBe(true);
    const no = vi.fn(async () => { throw new Error('no session'); });
    expect(await tmuxSessionExists('w', no)).toBe(false);
  });
});
