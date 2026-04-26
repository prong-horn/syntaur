import { describe, expect, it } from 'vitest';
import { buildAgentArgv, shellQuote, formatFallbackCwdWarning } from '../tui/launch.js';
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
});
