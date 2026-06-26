import { describe, expect, it } from 'vitest';
import { buildAgentArgv, shellQuote, formatFallbackCwdWarning } from '../tui/launch.js';
import { buildSessionArgv } from '../launch/argv.js';
import { agentNameArgs, modelFlagArgs } from '../utils/agents-schema.js';
import type { AgentConfig } from '../utils/config.js';

describe('shellQuote', () => {
  it('wraps simple values in single quotes', () => {
    expect(shellQuote('hello')).toBe("'hello'");
  });

  it('escapes embedded single quotes', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it('passes spaces and double quotes verbatim inside single quotes', () => {
    expect(shellQuote('a b "c"')).toBe(`'a b "c"'`);
  });

  it('handles empty string', () => {
    expect(shellQuote('')).toBe("''");
  });

  it('handles newlines', () => {
    expect(shellQuote('a\nb')).toBe(`'a\nb'`);
  });
});

describe('buildAgentArgv', () => {
  const prompt = 'hello world';

  it('defaults promptArgPosition to "first"', () => {
    const agent: AgentConfig = { id: 'x', label: 'X', command: 'claude' };
    const { argv } = buildAgentArgv(agent, prompt);
    expect(argv.command).toBe('claude');
    expect(argv.args).toEqual([prompt]);
  });

  it('honors promptArgPosition: "last"', () => {
    const agent: AgentConfig = {
      id: 'x',
      label: 'X',
      command: 'claude',
      args: ['--flag'],
      promptArgPosition: 'last',
    };
    const { argv } = buildAgentArgv(agent, prompt);
    expect(argv.args).toEqual(['--flag', prompt]);
  });

  it('honors promptArgPosition: "none" (no prompt appended)', () => {
    const agent: AgentConfig = {
      id: 'x',
      label: 'X',
      command: 'echo',
      args: ['static'],
      promptArgPosition: 'none',
    };
    const { argv } = buildAgentArgv(agent, prompt);
    expect(argv.args).toEqual(['static']);
    expect(argv.args).not.toContain(prompt);
  });

  it('builds $SHELL -i -c with proper quoting when resolveFromShellAliases=true', () => {
    const agent: AgentConfig = {
      id: 'c',
      label: 'Claude alias',
      command: 'c',
      args: ['--dangerously-skip-permissions'],
      resolveFromShellAliases: true,
    };
    const { argv, shellFallbackWarning } = buildAgentArgv(agent, prompt, {
      SHELL: '/bin/zsh',
    });
    expect(argv.command).toBe('/bin/zsh');
    expect(argv.args[0]).toBe('-i');
    expect(argv.args[1]).toBe('-c');
    expect(argv.args[2]).toBe(
      `'c' 'hello world' '--dangerously-skip-permissions'`,
    );
    expect(shellFallbackWarning).toBeNull();
  });

  it('escapes tricky characters inside the shell -c string', () => {
    const agent: AgentConfig = {
      id: 'c',
      label: 'x',
      command: 'c',
      resolveFromShellAliases: true,
    };
    const { argv } = buildAgentArgv(agent, `it's a "test"\nstring`, {
      SHELL: '/bin/zsh',
    });
    // prompt: it's a "test"\nstring  →  'it'\''s a "test"\nstring'
    expect(argv.args[2]).toBe(`'c' 'it'\\''s a "test"\nstring'`);
  });

  it('falls back to /bin/sh when $SHELL is unset', () => {
    const agent: AgentConfig = {
      id: 'c',
      label: 'x',
      command: 'c',
      resolveFromShellAliases: true,
    };
    const { argv, shellFallbackWarning } = buildAgentArgv(agent, prompt, {});
    expect(argv.command).toBe('/bin/sh');
    expect(shellFallbackWarning).toMatch(/unset/);
  });

  it('falls back to /bin/sh when $SHELL is not absolute', () => {
    const agent: AgentConfig = {
      id: 'c',
      label: 'x',
      command: 'c',
      resolveFromShellAliases: true,
    };
    const { argv, shellFallbackWarning } = buildAgentArgv(agent, prompt, {
      SHELL: 'zsh',
    });
    expect(argv.command).toBe('/bin/sh');
    expect(shellFallbackWarning).toMatch(/not absolute/);
  });

  it('returns null fallback warning when both worktreePath and branch are set', () => {
    expect(
      formatFallbackCwdWarning({
        assignmentSlug: 'demo',
        workspaceDir: '/x',
        worktreePath: '/x',
        branch: 'main',
      }),
    ).toBeNull();
  });

  it('warns when only worktreePath is missing', () => {
    expect(
      formatFallbackCwdWarning({
        assignmentSlug: 'demo',
        workspaceDir: '/cwd',
        worktreePath: null,
        branch: 'main',
      }),
    ).toBe('syntaur: workspace.worktreePath not set for demo — launching in /cwd');
  });

  it('warns when only branch is missing', () => {
    expect(
      formatFallbackCwdWarning({
        assignmentSlug: 'demo',
        workspaceDir: '/cwd',
        worktreePath: '/x',
        branch: null,
      }),
    ).toBe('syntaur: workspace.branch not set for demo — launching in /cwd');
  });

  it('warns with both fields when both are missing', () => {
    expect(
      formatFallbackCwdWarning({
        assignmentSlug: 'demo',
        workspaceDir: '/cwd',
        worktreePath: null,
        branch: null,
      }),
    ).toBe(
      'syntaur: workspace.worktreePath and workspace.branch not set for demo — launching in /cwd',
    );
  });

  it('keeps plain command + args when resolveFromShellAliases is false', () => {
    const agent: AgentConfig = {
      id: 'x',
      label: 'X',
      command: '/usr/local/bin/claude',
      args: ['--foo', 'bar'],
    };
    const { argv } = buildAgentArgv(agent, prompt);
    expect(argv.command).toBe('/usr/local/bin/claude');
    expect(argv.args).toEqual([prompt, '--foo', 'bar']);
  });

  describe('model injection', () => {
    it('appends --model after agent.args (position first)', () => {
      const agent: AgentConfig = { id: 'x', label: 'X', command: 'claude', model: 'opus' };
      const { argv } = buildAgentArgv(agent, prompt);
      expect(argv.args).toEqual([prompt, '--model', 'opus']);
    });

    it('places --model after args, before the trailing prompt (position last)', () => {
      const agent: AgentConfig = {
        id: 'x',
        label: 'X',
        command: 'claude',
        args: ['--flag'],
        promptArgPosition: 'last',
        model: 'sonnet',
      };
      const { argv } = buildAgentArgv(agent, prompt);
      expect(argv.args).toEqual(['--flag', '--model', 'sonnet', prompt]);
    });

    it('omits --model when model is blank/absent', () => {
      const agent: AgentConfig = { id: 'x', label: 'X', command: 'claude', model: '  ' };
      const { argv } = buildAgentArgv(agent, prompt);
      expect(argv.args).toEqual([prompt]);
      expect(argv.args).not.toContain('--model');
    });

    it('profile model REPLACES a hand-written --model in args (no duplicate flag)', () => {
      const agent: AgentConfig = {
        id: 'x',
        label: 'X',
        command: 'claude',
        args: ['--model', 'sonnet'],
        promptArgPosition: 'none',
        model: 'opus',
      };
      const { argv } = buildAgentArgv(agent, prompt);
      // The manual --model sonnet is stripped; exactly one --model remains.
      expect(argv.args).toEqual(['--model', 'opus']);
      expect(argv.args.filter((a) => a === '--model')).toHaveLength(1);
    });

    it('strips the combined --model=/-m forms and the -m flag from args', () => {
      const combined = buildAgentArgv(
        {
          id: 'x',
          label: 'X',
          command: 'claude',
          args: ['--model=sonnet', '--keep'],
          promptArgPosition: 'none',
          model: 'opus',
        },
        prompt,
      );
      expect(combined.argv.args).toEqual(['--keep', '--model', 'opus']);

      const shortFlag = buildAgentArgv(
        {
          id: 'x',
          label: 'X',
          command: 'claude',
          args: ['-m', 'sonnet', '--keep'],
          promptArgPosition: 'none',
          model: 'opus',
        },
        prompt,
      );
      expect(shortFlag.argv.args).toEqual(['--keep', '--model', 'opus']);
    });

    it('leaves a hand-written --model in args untouched when the profile has no model', () => {
      const agent: AgentConfig = {
        id: 'x',
        label: 'X',
        command: 'claude',
        args: ['--model', 'sonnet'],
        promptArgPosition: 'none',
      };
      const { argv } = buildAgentArgv(agent, prompt);
      expect(argv.args).toEqual(['--model', 'sonnet']);
    });

    it('includes --model in the resolveFromShellAliases quoting', () => {
      const agent: AgentConfig = {
        id: 'c',
        label: 'x',
        command: 'c',
        args: ['--x'],
        resolveFromShellAliases: true,
        model: 'opus',
      };
      const { argv } = buildAgentArgv(agent, prompt, { SHELL: '/bin/zsh' });
      expect(argv.args[2]).toBe(`'c' 'hello world' '--x' '--model' 'opus'`);
    });
  });

  describe('agentName injection (Claude --agent)', () => {
    it('emits --agent <name> BEFORE the prompt (position first)', () => {
      const agent: AgentConfig = {
        id: 'claude',
        label: 'Claude',
        command: 'claude',
        agentName: 'job-applier',
      };
      const { argv } = buildAgentArgv(agent, prompt);
      expect(argv.command).toBe('claude');
      expect(argv.args).toEqual(['--agent', 'job-applier', prompt]);
    });

    it('keeps --agent first even with position "last"', () => {
      const agent: AgentConfig = {
        id: 'claude',
        label: 'Claude',
        command: 'claude',
        args: ['--flag'],
        promptArgPosition: 'last',
        agentName: 'job-applier',
      };
      const { argv } = buildAgentArgv(agent, prompt);
      expect(argv.args).toEqual(['--agent', 'job-applier', '--flag', prompt]);
    });

    it('suppresses a profile --model when agentName is set', () => {
      // (Persisted config rejects agentName+model; this guards the argv path
      // for a one-shot override applied over a base agent that carried a model.)
      const agent: AgentConfig = {
        id: 'claude',
        label: 'Claude',
        command: 'claude',
        model: 'opus',
        agentName: 'job-applier',
      };
      const { argv } = buildAgentArgv(agent, prompt);
      expect(argv.args).not.toContain('--model');
      expect(argv.args).toEqual(['--agent', 'job-applier', prompt]);
    });

    it('places --agent after the command in the shell-alias quoting', () => {
      const agent: AgentConfig = {
        id: 'c',
        label: 'C',
        command: 'c',
        resolveFromShellAliases: true,
        agentName: 'job-applier',
      };
      const { argv } = buildAgentArgv(agent, prompt, { SHELL: '/bin/zsh' });
      expect(argv.args[2]).toBe(`'c' '--agent' 'job-applier' 'hello world'`);
    });

    it('does NOT inject --agent on resume (buildSessionArgv)', () => {
      const agent: AgentConfig = {
        id: 'claude',
        label: 'Claude',
        command: 'claude',
        agentName: 'job-applier',
        resume: { args: ['--resume', '{id}'] },
      };
      const { argv } = buildSessionArgv(agent, 'sess-123', 'resume');
      expect(argv.args).not.toContain('--agent');
      expect(argv.args).toEqual(['--resume', 'sess-123']);
    });
  });
});

describe('agentNameArgs', () => {
  it('returns the flag pair when agentName is set', () => {
    expect(
      agentNameArgs({ id: 'x', label: 'X', command: 'claude', agentName: 'job-applier' }),
    ).toEqual(['--agent', 'job-applier']);
  });

  it('trims surrounding whitespace', () => {
    expect(
      agentNameArgs({ id: 'x', label: 'X', command: 'claude', agentName: '  job-applier ' }),
    ).toEqual(['--agent', 'job-applier']);
  });

  it('returns [] when agentName is undefined or blank', () => {
    expect(agentNameArgs({ id: 'x', label: 'X', command: 'claude' })).toEqual([]);
    expect(
      agentNameArgs({ id: 'x', label: 'X', command: 'claude', agentName: '   ' }),
    ).toEqual([]);
  });
});

describe('modelFlagArgs', () => {
  it('returns the flag pair when model is set', () => {
    expect(modelFlagArgs({ id: 'x', label: 'X', command: 'claude', model: 'opus' })).toEqual([
      '--model',
      'opus',
    ]);
  });

  it('trims surrounding whitespace', () => {
    expect(modelFlagArgs({ id: 'x', label: 'X', command: 'claude', model: '  opus ' })).toEqual([
      '--model',
      'opus',
    ]);
  });

  it('returns [] when model is undefined or blank', () => {
    expect(modelFlagArgs({ id: 'x', label: 'X', command: 'claude' })).toEqual([]);
    expect(modelFlagArgs({ id: 'x', label: 'X', command: 'claude', model: '   ' })).toEqual([]);
  });
});
