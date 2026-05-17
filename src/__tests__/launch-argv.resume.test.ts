import { describe, expect, it } from 'vitest';
import { buildResumeArgv } from '../launch/argv.js';
import type { AgentConfig } from '../utils/config.js';

const claude: AgentConfig = { id: 'claude', label: 'Claude', command: 'claude' };
const codex: AgentConfig = {
  id: 'codex',
  label: 'Codex',
  command: 'codex',
  args: ['--profile', 'work'],
};

describe('buildResumeArgv', () => {
  it('returns the same shape as buildAgentArgv', () => {
    const result = buildResumeArgv(claude, 'sess-1');
    expect(result).toHaveProperty('argv.command');
    expect(result).toHaveProperty('argv.args');
    expect(result).toHaveProperty('shellFallbackWarning');
  });

  it('appends --resume <id> with no prompt injection', () => {
    const { argv, shellFallbackWarning } = buildResumeArgv(claude, 'sess-1');
    expect(argv.command).toBe('claude');
    expect(argv.args).toEqual(['--resume', 'sess-1']);
    expect(shellFallbackWarning).toBeNull();
  });

  it('preserves existing agent args before --resume', () => {
    const { argv } = buildResumeArgv(codex, 'sess-2');
    expect(argv.command).toBe('codex');
    expect(argv.args).toEqual(['--profile', 'work', '--resume', 'sess-2']);
  });

  it('rewrites command to $SHELL with -i -c when resolveFromShellAliases is set', () => {
    const agent: AgentConfig = {
      ...claude,
      resolveFromShellAliases: true,
    };
    const { argv, shellFallbackWarning } = buildResumeArgv(agent, 'sess-3', {
      SHELL: '/bin/zsh',
    });
    expect(argv.command).toBe('/bin/zsh');
    expect(argv.args[0]).toBe('-i');
    expect(argv.args[1]).toBe('-c');
    expect(argv.args[2]).toContain("'claude'");
    expect(argv.args[2]).toContain("'--resume'");
    expect(argv.args[2]).toContain("'sess-3'");
    expect(shellFallbackWarning).toBeNull();
  });

  it('falls back to /bin/sh and emits a warning when $SHELL is unset', () => {
    const agent: AgentConfig = {
      ...claude,
      resolveFromShellAliases: true,
    };
    const { argv, shellFallbackWarning } = buildResumeArgv(agent, 'sess-4', {});
    expect(argv.command).toBe('/bin/sh');
    expect(shellFallbackWarning).toMatch(/\$SHELL is unset/);
  });

  it('falls back to /bin/sh when $SHELL is not absolute', () => {
    const agent: AgentConfig = {
      ...claude,
      resolveFromShellAliases: true,
    };
    const { argv, shellFallbackWarning } = buildResumeArgv(agent, 'sess-5', {
      SHELL: 'zsh',
    });
    expect(argv.command).toBe('/bin/sh');
    expect(shellFallbackWarning).toMatch(/is not absolute/);
  });

  it('escapes single quotes in agent command for shell wrapping', () => {
    const weird: AgentConfig = {
      id: 'weird',
      label: 'Weird',
      command: "say'hi",
      resolveFromShellAliases: true,
    };
    const { argv } = buildResumeArgv(weird, 'sess-6', { SHELL: '/bin/zsh' });
    expect(argv.args[2]).toContain(`'say'\\''hi'`);
  });
});
