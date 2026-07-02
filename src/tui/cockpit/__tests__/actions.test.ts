import { describe, it, expect, vi } from 'vitest';
import { runLaunch } from '../actions.js';

const plan = { command: 'claude', args: ['hi'], cwd: '/x' };

describe('runLaunch degradation', () => {
  it('uses tmux when available', async () => {
    const launchInTmux = vi.fn(async () => {});
    const handOff = vi.fn(async () => {});
    expect(await runLaunch('syntaur-p-a', plan, { tmuxAvailable: true, launchInTmux, handOff })).toBe('tmux');
    expect(launchInTmux).toHaveBeenCalledOnce();
    expect(handOff).not.toHaveBeenCalled();
  });
  it('falls back to hand-off without tmux', async () => {
    const launchInTmux = vi.fn(async () => {});
    const handOff = vi.fn(async () => {});
    expect(await runLaunch('syntaur-p-a', plan, { tmuxAvailable: false, launchInTmux, handOff })).toBe('handoff');
    expect(handOff).toHaveBeenCalledOnce();
    expect(launchInTmux).not.toHaveBeenCalled();
  });
});
