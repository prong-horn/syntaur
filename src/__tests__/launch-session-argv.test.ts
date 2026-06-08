import { describe, expect, it } from 'vitest';
import { buildSessionArgv } from '../launch/argv.js';
import { LaunchError } from '../launch/plan.js';
import { BUILTIN_AGENTS, type AgentConfig } from '../utils/config.js';

const claude = BUILTIN_AGENTS.find((a) => a.id === 'claude')!;
const codex = BUILTIN_AGENTS.find((a) => a.id === 'codex')!;
const codexWithBaseArgs: AgentConfig = {
  ...codex,
  args: ['--profile', 'work'],
};

describe('buildSessionArgv', () => {
  it('returns the same shape as buildAgentArgv', () => {
    const result = buildSessionArgv(claude, 'sess-1', 'resume');
    expect(result).toHaveProperty('argv.command');
    expect(result).toHaveProperty('argv.args');
    expect(result).toHaveProperty('shellFallbackWarning');
  });

  it('builds claude resume argv: --resume <id>', () => {
    const { argv, shellFallbackWarning } = buildSessionArgv(claude, 'sess-1', 'resume');
    expect(argv.command).toBe('claude');
    expect(argv.args).toEqual(['--resume', 'sess-1']);
    expect(shellFallbackWarning).toBeNull();
  });

  it('builds claude fork argv: --resume <id> --fork-session', () => {
    const { argv } = buildSessionArgv(claude, 'sess-2', 'fork');
    expect(argv.command).toBe('claude');
    expect(argv.args).toEqual(['--resume', 'sess-2', '--fork-session']);
  });

  it('builds codex resume argv: resume <id> (subcommand syntax)', () => {
    const { argv } = buildSessionArgv(codex, 'sess-3', 'resume');
    expect(argv.command).toBe('codex');
    expect(argv.args).toEqual(['resume', 'sess-3']);
  });

  it('builds codex fork argv: fork <id>', () => {
    const { argv } = buildSessionArgv(codex, 'sess-4', 'fork');
    expect(argv.command).toBe('codex');
    expect(argv.args).toEqual(['fork', 'sess-4']);
  });

  it('preserves existing agent.args before invocation args', () => {
    const { argv } = buildSessionArgv(codexWithBaseArgs, 'sess-5', 'resume');
    expect(argv.command).toBe('codex');
    expect(argv.args).toEqual(['--profile', 'work', 'resume', 'sess-5']);
  });

  it('injects --model after agent.args and before the resume subcommand args', () => {
    const codexWithModel: AgentConfig = { ...codex, model: 'gpt-5.5-codex' };
    const { argv } = buildSessionArgv(codexWithModel, 'sess-5b', 'resume');
    expect(argv.command).toBe('codex');
    expect(argv.args).toEqual(['--model', 'gpt-5.5-codex', 'resume', 'sess-5b']);
  });

  it('injects --model after agent.args (claude resume) when both args and model are set', () => {
    const claudeWithModel: AgentConfig = { ...claude, args: ['--verbose'], model: 'opus' };
    const { argv } = buildSessionArgv(claudeWithModel, 'sess-5c', 'resume');
    expect(argv.args).toEqual(['--verbose', '--model', 'opus', '--resume', 'sess-5c']);
  });

  it('omits --model when model is unset', () => {
    const { argv } = buildSessionArgv(codex, 'sess-5d', 'resume');
    expect(argv.args).not.toContain('--model');
  });

  it('applies invocation.command override over agent.command', () => {
    const custom: AgentConfig = {
      id: 'custom',
      label: 'Custom',
      command: 'custom',
      resume: { command: 'custom-resume-bin', args: ['--id', '{id}'] },
    };
    const { argv } = buildSessionArgv(custom, 'sess-6', 'resume');
    expect(argv.command).toBe('custom-resume-bin');
    expect(argv.args).toEqual(['--id', 'sess-6']);
  });

  it('throws LaunchError(mode-not-supported) when the agent has no resume entry', () => {
    const noResume: AgentConfig = {
      id: 'no-resume',
      label: 'No Resume',
      command: 'x',
      fork: { args: ['fork', '{id}'] },
    };
    expect(() => buildSessionArgv(noResume, 'sess', 'resume')).toThrow(
      expect.objectContaining({ code: 'mode-not-supported' }),
    );
    expect(() => buildSessionArgv(noResume, 'sess', 'resume')).toThrow(
      LaunchError,
    );
  });

  it('throws LaunchError(mode-not-supported) when the agent has no fork entry', () => {
    const noFork: AgentConfig = {
      id: 'no-fork',
      label: 'No Fork',
      command: 'x',
      resume: { args: ['--resume', '{id}'] },
    };
    expect(() => buildSessionArgv(noFork, 'sess', 'fork')).toThrow(
      expect.objectContaining({ code: 'mode-not-supported' }),
    );
  });

  it('rewrites command to $SHELL with -i -c when resolveFromShellAliases is set', () => {
    const agent: AgentConfig = {
      ...claude,
      resolveFromShellAliases: true,
    };
    const { argv, shellFallbackWarning } = buildSessionArgv(
      agent,
      'sess-7',
      'resume',
      { SHELL: '/bin/zsh' },
    );
    expect(argv.command).toBe('/bin/zsh');
    expect(argv.args[0]).toBe('-i');
    expect(argv.args[1]).toBe('-c');
    expect(argv.args[2]).toContain("'claude'");
    expect(argv.args[2]).toContain("'--resume'");
    expect(argv.args[2]).toContain("'sess-7'");
    expect(shellFallbackWarning).toBeNull();
  });

  it('uses the invocation.command override inside the shell-alias rewrite', () => {
    const agent: AgentConfig = {
      id: 'aliased',
      label: 'Aliased',
      command: 'aliased',
      resolveFromShellAliases: true,
      resume: { command: 'aliased-resume', args: ['--id', '{id}'] },
    };
    const { argv } = buildSessionArgv(agent, 'sess-8', 'resume', {
      SHELL: '/bin/zsh',
    });
    expect(argv.args[2]).toContain("'aliased-resume'");
  });

  it('falls back to /bin/sh and emits a warning when $SHELL is unset', () => {
    const agent: AgentConfig = {
      ...claude,
      resolveFromShellAliases: true,
    };
    const { argv, shellFallbackWarning } = buildSessionArgv(
      agent,
      'sess-9',
      'resume',
      {},
    );
    expect(argv.command).toBe('/bin/sh');
    expect(shellFallbackWarning).toMatch(/\$SHELL is unset/);
  });

  it('falls back to /bin/sh when $SHELL is not absolute', () => {
    const agent: AgentConfig = {
      ...claude,
      resolveFromShellAliases: true,
    };
    const { argv, shellFallbackWarning } = buildSessionArgv(
      agent,
      'sess-10',
      'resume',
      { SHELL: 'zsh' },
    );
    expect(argv.command).toBe('/bin/sh');
    expect(shellFallbackWarning).toMatch(/is not absolute/);
  });

  it('escapes single quotes in agent command for shell wrapping', () => {
    const weird: AgentConfig = {
      id: 'weird',
      label: 'Weird',
      command: "say'hi",
      resolveFromShellAliases: true,
      resume: { args: ['--resume', '{id}'] },
    };
    const { argv } = buildSessionArgv(weird, 'sess-11', 'resume', {
      SHELL: '/bin/zsh',
    });
    expect(argv.args[2]).toContain(`'say'\\''hi'`);
  });

  describe('builtin pi/openclaw/hermes', () => {
    const pi = BUILTIN_AGENTS.find((a) => a.id === 'pi')!;
    const openclaw = BUILTIN_AGENTS.find((a) => a.id === 'openclaw')!;
    const hermes = BUILTIN_AGENTS.find((a) => a.id === 'hermes')!;

    it('builds pi resume argv: --session <id>', () => {
      const { argv } = buildSessionArgv(pi, 'sess-pi-1', 'resume');
      expect(argv.command).toBe('pi');
      expect(argv.args).toEqual(['--session', 'sess-pi-1']);
    });

    it('builds pi fork argv: --fork <id>', () => {
      const { argv } = buildSessionArgv(pi, 'sess-pi-2', 'fork');
      expect(argv.command).toBe('pi');
      expect(argv.args).toEqual(['--fork', 'sess-pi-2']);
    });

    it('openclaw resume and fork throw mode-not-supported (no recipe)', () => {
      expect(() => buildSessionArgv(openclaw, 'sess', 'resume')).toThrow(
        expect.objectContaining({ code: 'mode-not-supported' }),
      );
      expect(() => buildSessionArgv(openclaw, 'sess', 'fork')).toThrow(
        expect.objectContaining({ code: 'mode-not-supported' }),
      );
    });

    it('hermes resume and fork throw mode-not-supported (no recipe)', () => {
      expect(() => buildSessionArgv(hermes, 'sess', 'resume')).toThrow(
        expect.objectContaining({ code: 'mode-not-supported' }),
      );
      expect(() => buildSessionArgv(hermes, 'sess', 'fork')).toThrow(
        expect.objectContaining({ code: 'mode-not-supported' }),
      );
    });
  });
});
