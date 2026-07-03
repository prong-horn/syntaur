import { describe, it, expect, vi } from 'vitest';
import { runLaunch } from '../actions.js';
import type { AgentConfig } from '../../../utils/config.js';

const plan = { command: 'claude', args: ['hi'], cwd: '/x' };
const claudeAgent: AgentConfig = { id: 'claude', label: 'Claude', command: 'claude' };
const codexAgent: AgentConfig = { id: 'codex', label: 'Codex', command: 'codex' };

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

describe('runLaunch native --bg dispatch', () => {
  function deps(overrides: Partial<Parameters<typeof runLaunch>[2]> = {}) {
    return {
      tmuxAvailable: true,
      launchInTmux: vi.fn(async () => {}),
      handOff: vi.fn(async () => {}),
      claudeBgAvailable: true,
      launchClaudeBg: vi.fn(async () => {}),
      ...overrides,
    };
  }

  it('uses native --bg when the agent is claude, claudeBgAvailable, and eligible', async () => {
    const d = deps();
    const mode = await runLaunch('syntaur-p-a', plan, d, { agent: claudeAgent, name: 'proj/a1' });
    expect(mode).toBe('claude-bg');
    expect(d.launchClaudeBg).toHaveBeenCalledWith({ plan, name: 'proj/a1' });
    expect(d.launchInTmux).not.toHaveBeenCalled();
  });

  it('falls through to tmux when claudeBgAvailable is false', async () => {
    const d = deps({ claudeBgAvailable: false });
    const mode = await runLaunch('syntaur-p-a', plan, d, { agent: claudeAgent, name: 'proj/a1' });
    expect(mode).toBe('tmux');
    expect(d.launchClaudeBg).not.toHaveBeenCalled();
  });

  it('falls through to tmux for a non-claude runner even when claudeBgAvailable', async () => {
    const d = deps();
    const mode = await runLaunch('syntaur-p-a', plan, d, { agent: codexAgent, name: 'proj/a1' });
    expect(mode).toBe('tmux');
    expect(d.launchClaudeBg).not.toHaveBeenCalled();
  });

  it('falls through to tmux when the built args are print-mode (ineligible)', async () => {
    const d = deps();
    const printPlan = { ...plan, args: ['hi', '--print'] };
    const mode = await runLaunch('syntaur-p-a', printPlan, d, { agent: claudeAgent, name: 'proj/a1' });
    expect(mode).toBe('tmux');
    expect(d.launchClaudeBg).not.toHaveBeenCalled();
  });

  it('falls through to tmux for a shell-alias-wrapped agent (ineligible)', async () => {
    const d = deps();
    const aliasAgent: AgentConfig = { ...claudeAgent, resolveFromShellAliases: true };
    const mode = await runLaunch('syntaur-p-a', plan, d, { agent: aliasAgent, name: 'proj/a1' });
    expect(mode).toBe('tmux');
    expect(d.launchClaudeBg).not.toHaveBeenCalled();
  });

  it('a failed --bg spawn falls back to tmux instead of throwing', async () => {
    const d = deps({ launchClaudeBg: vi.fn(async () => { throw new Error('ENOENT'); }) });
    const mode = await runLaunch('syntaur-p-a', plan, d, { agent: claudeAgent, name: 'proj/a1' });
    expect(mode).toBe('tmux');
    expect(d.launchInTmux).toHaveBeenCalledOnce();
  });

  it('a failed --bg spawn without tmux falls back to hand-off', async () => {
    const d = deps({ tmuxAvailable: false, launchClaudeBg: vi.fn(async () => { throw new Error('ENOENT'); }) });
    const mode = await runLaunch('syntaur-p-a', plan, d, { agent: claudeAgent, name: 'proj/a1' });
    expect(mode).toBe('handoff');
    expect(d.handOff).toHaveBeenCalledOnce();
  });

  it('a failed --bg spawn calls onNativeLaunchFailure with the error before falling back (spec §7: surfaced in status)', async () => {
    const err = new Error('ENOENT');
    const onNativeLaunchFailure = vi.fn();
    const d = deps({ launchClaudeBg: vi.fn(async () => { throw err; }), onNativeLaunchFailure });
    const mode = await runLaunch('syntaur-p-a', plan, d, { agent: claudeAgent, name: 'proj/a1' });
    expect(mode).toBe('tmux');
    expect(onNativeLaunchFailure).toHaveBeenCalledWith(err);
  });

  it('does not call onNativeLaunchFailure when --bg succeeds', async () => {
    const onNativeLaunchFailure = vi.fn();
    const d = deps({ onNativeLaunchFailure });
    await runLaunch('syntaur-p-a', plan, d, { agent: claudeAgent, name: 'proj/a1' });
    expect(onNativeLaunchFailure).not.toHaveBeenCalled();
  });
});
