import { describe, it, expect, vi } from 'vitest';
import { runLaunch } from '../actions.js';
import type { AgentConfig } from '../../../utils/config.js';

const plan = { command: 'claude', args: ['hi'], cwd: '/x' };
const claudeAgent: AgentConfig = { id: 'claude', label: 'Claude', command: 'claude' };
const codexAgent: AgentConfig = { id: 'codex', label: 'Codex', command: 'codex' };

describe('runLaunch degradation', () => {
  it('uses hand-off when no tier is available', async () => {
    const handOff = vi.fn(async () => {});
    expect(await runLaunch(plan, { handOff }, undefined)).toBe('handoff');
    expect(handOff).toHaveBeenCalledOnce();
  });
});

describe('runLaunch native --bg dispatch', () => {
  function deps(overrides: Partial<Parameters<typeof runLaunch>[1]> = {}) {
    return {
      handOff: vi.fn(async () => {}),
      claudeBgAvailable: true,
      launchClaudeBg: vi.fn(async () => {}),
      ...overrides,
    };
  }

  it('uses native --bg when the agent is claude, claudeBgAvailable, and eligible', async () => {
    const d = deps();
    const mode = await runLaunch(plan, d, { agent: claudeAgent, name: 'proj/a1' });
    expect(mode).toBe('claude-bg');
    expect(d.launchClaudeBg).toHaveBeenCalledWith({ plan, name: 'proj/a1' });
    expect(d.handOff).not.toHaveBeenCalled();
  });

  it('falls through to hand-off when claudeBgAvailable is false', async () => {
    const d = deps({ claudeBgAvailable: false });
    const mode = await runLaunch(plan, d, { agent: claudeAgent, name: 'proj/a1' });
    expect(mode).toBe('handoff');
    expect(d.launchClaudeBg).not.toHaveBeenCalled();
    expect(d.handOff).toHaveBeenCalledOnce();
  });

  it('falls through to hand-off for a non-claude runner even when claudeBgAvailable', async () => {
    const d = deps();
    const mode = await runLaunch(plan, d, { agent: codexAgent, name: 'proj/a1' });
    expect(mode).toBe('handoff');
    expect(d.launchClaudeBg).not.toHaveBeenCalled();
  });

  it('falls through to hand-off when the built args are print-mode (ineligible)', async () => {
    const d = deps();
    const printPlan = { ...plan, args: ['hi', '--print'] };
    const mode = await runLaunch(printPlan, d, { agent: claudeAgent, name: 'proj/a1' });
    expect(mode).toBe('handoff');
    expect(d.launchClaudeBg).not.toHaveBeenCalled();
  });

  it('falls through to hand-off for a shell-alias-wrapped agent (ineligible)', async () => {
    const d = deps();
    const aliasAgent: AgentConfig = { ...claudeAgent, resolveFromShellAliases: true };
    const mode = await runLaunch(plan, d, { agent: aliasAgent, name: 'proj/a1' });
    expect(mode).toBe('handoff');
    expect(d.launchClaudeBg).not.toHaveBeenCalled();
  });

  it('a failed --bg spawn falls back to hand-off instead of throwing', async () => {
    const d = deps({ launchClaudeBg: vi.fn(async () => { throw new Error('ENOENT'); }) });
    const mode = await runLaunch(plan, d, { agent: claudeAgent, name: 'proj/a1' });
    expect(mode).toBe('handoff');
    expect(d.handOff).toHaveBeenCalledOnce();
  });

  it('a failed --bg spawn calls onNativeLaunchFailure with the error before falling back (spec §7: surfaced in status)', async () => {
    const err = new Error('ENOENT');
    const onNativeLaunchFailure = vi.fn();
    const d = deps({ launchClaudeBg: vi.fn(async () => { throw err; }), onNativeLaunchFailure });
    const mode = await runLaunch(plan, d, { agent: claudeAgent, name: 'proj/a1' });
    expect(mode).toBe('handoff');
    expect(onNativeLaunchFailure).toHaveBeenCalledWith(err);
  });

  it('does not call onNativeLaunchFailure when --bg succeeds', async () => {
    const onNativeLaunchFailure = vi.fn();
    const d = deps({ onNativeLaunchFailure });
    await runLaunch(plan, d, { agent: claudeAgent, name: 'proj/a1' });
    expect(onNativeLaunchFailure).not.toHaveBeenCalled();
  });
});

describe('runLaunch syntaurd dispatch', () => {
  function deps(overrides: Partial<Parameters<typeof runLaunch>[1]> = {}) {
    return {
      handOff: vi.fn(async () => {}),
      claudeBgAvailable: true,
      launchClaudeBg: vi.fn(async () => {}),
      syntaurdAvailable: true,
      launchSyntaurd: vi.fn(async () => {}),
      ...overrides,
    };
  }

  it('dispatches via syntaurd FIRST when available, even with claude-bg available', async () => {
    const d = deps();
    const mode = await runLaunch(plan, d, { agent: claudeAgent, name: 'proj/a1' });
    expect(mode).toBe('syntaurd');
    expect(d.launchSyntaurd).toHaveBeenCalledWith({ plan, name: 'proj/a1', agent: claudeAgent });
    expect(d.launchClaudeBg).not.toHaveBeenCalled();
  });

  it('dispatches a non-claude agent via syntaurd (no runner guard)', async () => {
    const d = deps();
    expect(await runLaunch(plan, d, { agent: codexAgent, name: 'proj/a1' })).toBe('syntaurd');
  });

  it('dispatches a shell-alias agent via syntaurd (a PTY runs anything)', async () => {
    const d = deps();
    const aliasAgent = { ...claudeAgent, resolveFromShellAliases: true };
    expect(await runLaunch(plan, d, { agent: aliasAgent, name: 'proj/a1' })).toBe('syntaurd');
  });

  it('dispatches a print-mode plan via syntaurd (no argv eligibility guard)', async () => {
    const d = deps();
    const printPlan = { ...plan, args: ['hi', '--print'] };
    expect(await runLaunch(printPlan, d, { agent: claudeAgent, name: 'proj/a1' })).toBe('syntaurd');
  });

  it('falls through to claude-bg when syntaurdAvailable is false (v2 behavior preserved)', async () => {
    const d = deps({ syntaurdAvailable: false });
    expect(await runLaunch(plan, d, { agent: claudeAgent, name: 'proj/a1' })).toBe('claude-bg');
    expect(d.launchSyntaurd).not.toHaveBeenCalled();
  });

  it('falls through when the launchSyntaurd dep is absent', async () => {
    const d = deps({ launchSyntaurd: undefined });
    expect(await runLaunch(plan, d, { agent: claudeAgent, name: 'proj/a1' })).toBe('claude-bg');
  });

  it('skips syntaurd without native input and uses hand-off', async () => {
    const d = deps();
    expect(await runLaunch(plan, d)).toBe('handoff');
    expect(d.launchSyntaurd).not.toHaveBeenCalled();
  });

  it('a failed syntaurd dispatch calls onSyntaurdLaunchFailure and degrades to claude-bg', async () => {
    const err = new Error('daemon start timeout');
    const onSyntaurdLaunchFailure = vi.fn();
    const d = deps({ launchSyntaurd: vi.fn(async () => { throw err; }), onSyntaurdLaunchFailure });
    expect(await runLaunch(plan, d, { agent: claudeAgent, name: 'proj/a1' })).toBe('claude-bg');
    expect(onSyntaurdLaunchFailure).toHaveBeenCalledWith(err);
  });

  it('a failed syntaurd dispatch with no claude-bg degrades to hand-off', async () => {
    const d = deps({ claudeBgAvailable: false, launchSyntaurd: vi.fn(async () => { throw new Error('x'); }) });
    expect(await runLaunch(plan, d, { agent: claudeAgent, name: 'proj/a1' })).toBe('handoff');
    expect(d.handOff).toHaveBeenCalledOnce();
  });

  it('does not call onSyntaurdLaunchFailure when the dispatch succeeds', async () => {
    const onSyntaurdLaunchFailure = vi.fn();
    const d = deps({ onSyntaurdLaunchFailure });
    await runLaunch(plan, d, { agent: claudeAgent, name: 'proj/a1' });
    expect(onSyntaurdLaunchFailure).not.toHaveBeenCalled();
  });
});
