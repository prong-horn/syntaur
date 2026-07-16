import { describe, it, expect, vi } from 'vitest';
import {
  buildTmuxLaunchArgv,
  tmuxSessionName,
  launchInTmux,
  launchInTmuxWithPid,
  tmuxSessionExists,
} from '../launch.js';

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

describe('launchInTmuxWithPid (fallback provenance)', () => {
  it('captures the pane pid via -P -F', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: '4242\n' }));
    const pid = await launchInTmuxWithPid({ sessionName: 'w', cwd: '/x', command: 'claude', args: ['hi'], exec });
    expect(pid).toBe(4242);
    expect(exec).toHaveBeenCalledWith('tmux', [
      'new-session', '-d', '-P', '-F', '#{pane_pid}', '-s', 'w', '-c', '/x', 'claude', 'hi',
    ]);
  });

  it('returns null when the pane pid is unparseable', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: '' }));
    expect(await launchInTmuxWithPid({ sessionName: 'w', cwd: '/x', command: 'claude', args: ['hi'], exec })).toBeNull();
  });

  it('renders env as a POSIX `env KEY=VALUE …` command prefix (works on every tmux version)', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: '99\n' }));
    await launchInTmuxWithPid({
      sessionName: 'w', cwd: '/x', command: 'claude', args: ['hi'], exec,
      env: { SYNTAUR_LAUNCH_ID: 'uuid-1', SYNTAUR_HOSTED_BY: 'tmux' },
    });
    expect(exec).toHaveBeenCalledWith('tmux', [
      'new-session', '-d', '-P', '-F', '#{pane_pid}', '-s', 'w', '-c', '/x',
      'env', 'SYNTAUR_LAUNCH_ID=uuid-1', 'SYNTAUR_HOSTED_BY=tmux', 'claude', 'hi',
    ]);
  });

  it('adds no env prefix when env is absent', async () => {
    // Typed params so `mock.calls[0][1]` is inspectable (an untyped
    // `vi.fn(async () => …)` infers a zero-length tuple for its call args).
    const exec = vi.fn(async (_cmd: string, _args: string[]) => ({ code: 0, stdout: '1\n' }));
    await launchInTmuxWithPid({ sessionName: 'w', cwd: '/x', command: 'claude', args: ['hi'], exec });
    expect(exec.mock.calls[0][1]).not.toContain('env');
  });

  it('composes with a shell-alias plan (env execs into $SHELL)', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: '7\n' }));
    await launchInTmuxWithPid({
      sessionName: 'w', cwd: '/x', command: '/bin/zsh', args: ['-i', '-c', "claude 'hi'"], exec,
      env: { SYNTAUR_LAUNCH_ID: 'uuid-1' },
    });
    expect(exec).toHaveBeenCalledWith('tmux', [
      'new-session', '-d', '-P', '-F', '#{pane_pid}', '-s', 'w', '-c', '/x',
      'env', 'SYNTAUR_LAUNCH_ID=uuid-1', '/bin/zsh', '-i', '-c', "claude 'hi'",
    ]);
  });
});
