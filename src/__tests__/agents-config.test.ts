import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  readConfig,
  writeAgentsConfig,
  updateAgentsConfig,
  getAgents,
  parseAgentCommand,
  validateAgentList,
  AgentConfigError,
  BUILTIN_AGENTS,
  type AgentConfig,
} from '../utils/config.js';

describe('agents config', () => {
  const originalHome = process.env.HOME;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'syntaur-agents-'));
    process.env.HOME = homeDir;
    await mkdir(resolve(homeDir, '.syntaur'), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  describe('parseAgentCommand', () => {
    it('accepts absolute paths', () => {
      expect(parseAgentCommand('/usr/local/bin/claude')).toBe('/usr/local/bin/claude');
    });

    it('accepts bare names for PATH lookup', () => {
      expect(parseAgentCommand('claude')).toBe('claude');
      expect(parseAgentCommand('codex')).toBe('codex');
    });

    it('rejects relative paths with slashes', () => {
      expect(() => parseAgentCommand('./foo')).toThrow(/relative path/);
      expect(() => parseAgentCommand('subdir/foo')).toThrow(/relative path/);
      expect(() => parseAgentCommand('../foo')).toThrow(/relative path/);
    });

    it('rejects empty values', () => {
      expect(() => parseAgentCommand('')).toThrow(/empty command/);
      expect(() => parseAgentCommand('   ')).toThrow(/empty command/);
    });

    it('expands ~ in absolute paths', () => {
      const expanded = parseAgentCommand('~/bin/claude');
      expect(expanded).toMatch(/^\/.+\/bin\/claude$/);
    });
  });

  describe('validateAgentList', () => {
    it('accepts a valid single-agent list', () => {
      expect(() =>
        validateAgentList([{ id: 'claude', label: 'Claude', command: 'claude' }]),
      ).not.toThrow();
    });

    it('rejects duplicate ids', () => {
      expect(() =>
        validateAgentList([
          { id: 'a', label: 'A', command: 'a' },
          { id: 'a', label: 'A2', command: 'a2' },
        ]),
      ).toThrow(AgentConfigError);
    });

    it('rejects invalid id patterns', () => {
      expect(() =>
        validateAgentList([{ id: 'Bad Id!', label: 'x', command: 'x' }]),
      ).toThrow(/invalid/);
    });

    it('rejects more than one default: true', () => {
      expect(() =>
        validateAgentList([
          { id: 'a', label: 'A', command: 'a', default: true },
          { id: 'b', label: 'B', command: 'b', default: true },
        ]),
      ).toThrow(/more than one/);
    });

    it('rejects invalid promptArgPosition', () => {
      expect(() =>
        validateAgentList([
          { id: 'a', label: 'A', command: 'a', promptArgPosition: 'middle' as never },
        ]),
      ).toThrow(/promptArgPosition/);
    });
  });

  describe('round-trip', () => {
    it('writes and reads back an agents block', async () => {
      const agents: AgentConfig[] = [
        {
          id: 'claude',
          label: 'Claude',
          command: '/usr/local/bin/claude',
          default: true,
        },
        {
          id: 'c',
          label: 'Claude (alias)',
          command: 'c',
          resolveFromShellAliases: true,
          args: ['--dangerously-skip-permissions'],
        },
        {
          id: 'echoer',
          label: 'Echoer',
          command: 'echo',
          promptArgPosition: 'none',
        },
      ];
      await writeAgentsConfig(agents);
      const config = await readConfig();
      expect(config.agents).toHaveLength(3);
      expect(config.agents?.[0]).toMatchObject({
        id: 'claude',
        label: 'Claude',
        command: '/usr/local/bin/claude',
        default: true,
      });
      expect(config.agents?.[1]).toMatchObject({
        id: 'c',
        command: 'c',
        resolveFromShellAliases: true,
        args: ['--dangerously-skip-permissions'],
      });
      expect(config.agents?.[2]).toMatchObject({
        id: 'echoer',
        promptArgPosition: 'none',
      });
    });

    it('getAgents returns built-in defaults when block absent', async () => {
      const config = await readConfig();
      expect(config.agents).toBeNull();
      const defaults = getAgents(config);
      expect(defaults).toEqual(BUILTIN_AGENTS);
      expect(defaults.map((a) => a.command)).toEqual([
        'claude',
        'codex',
        'pi',
        'openclaw',
        'hermes',
      ]);
    });

    it('round-trips double-quoted scalars containing escapes', async () => {
      const agents: AgentConfig[] = [
        {
          id: 'tricky',
          label: 'Tricky',
          command: '/bin/true',
          args: ['a "quoted" arg', 'with\\backslash', 'tab\there'],
        },
      ];
      await writeAgentsConfig(agents);
      const config = await readConfig();
      expect(config.agents?.[0].args).toEqual([
        'a "quoted" arg',
        'with\\backslash',
        'tab\there',
      ]);
    });

    it('rejects values containing newlines at write time', async () => {
      await expect(
        writeAgentsConfig([
          { id: 'bad', label: 'Bad', command: '/bin/true', args: ['has\nnewline'] },
        ]),
      ).rejects.toThrow(/newlines/);
    });

    it('falls back to defaults and warns when config has invalid agents', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const configPath = resolve(homeDir, '.syntaur', 'config.md');
      await writeFile(
        configPath,
        `---\nversion: "2.0"\ndefaultProjectDir: ${homeDir}/.syntaur/projects\nagents:\n  - id: bad\n    label: Bad\n    command: ./relative/path\n---\n`,
      );
      const config = await readConfig();
      expect(config.agents).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
      const msg = (warnSpy.mock.calls[0]?.[0] as string) ?? '';
      expect(msg).toMatch(/agents block is invalid/);
      warnSpy.mockRestore();
    });

    it('falls back to defaults when config has duplicate ids', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const configPath = resolve(homeDir, '.syntaur', 'config.md');
      await writeFile(
        configPath,
        `---\nversion: "2.0"\ndefaultProjectDir: ${homeDir}/.syntaur/projects\nagents:\n  - id: a\n    label: A\n    command: a\n  - id: a\n    label: A2\n    command: b\n---\n`,
      );
      const config = await readConfig();
      expect(config.agents).toBeNull();
      warnSpy.mockRestore();
    });

    it('round-trips resume + fork session invocations', async () => {
      const agents: AgentConfig[] = [
        {
          id: 'claude',
          label: 'Claude',
          command: 'claude',
          default: true,
          resume: { args: ['--resume', '{id}'] },
          fork: { args: ['--resume', '{id}', '--fork-session'] },
        },
        {
          id: 'codex',
          label: 'Codex',
          command: 'codex',
          resume: { args: ['resume', '{id}'] },
          fork: { args: ['fork', '{id}'] },
        },
      ];
      await writeAgentsConfig(agents);
      const config = await readConfig();
      expect(config.agents?.[0]).toMatchObject({
        id: 'claude',
        resume: { args: ['--resume', '{id}'] },
        fork: { args: ['--resume', '{id}', '--fork-session'] },
      });
      expect(config.agents?.[1]).toMatchObject({
        id: 'codex',
        resume: { args: ['resume', '{id}'] },
        fork: { args: ['fork', '{id}'] },
      });
    });

    it('round-trips a resume invocation with a command override', async () => {
      const agents: AgentConfig[] = [
        {
          id: 'custom',
          label: 'Custom',
          command: 'custom',
          resume: { command: 'custom-resume', args: ['--id', '{id}'] },
        },
      ];
      await writeAgentsConfig(agents);
      const config = await readConfig();
      expect(config.agents?.[0].resume).toEqual({
        command: 'custom-resume',
        args: ['--id', '{id}'],
      });
    });

    it('rejects resume.args containing a non-string entry', () => {
      expect(() =>
        validateAgentList([
          {
            id: 'bad',
            label: 'Bad',
            command: 'bad',
            resume: { args: ['ok', 42 as unknown as string] },
          },
        ]),
      ).toThrow(/resume\.args must contain only strings/);
    });

    it('rejects resume.command when non-string', () => {
      expect(() =>
        validateAgentList([
          {
            id: 'bad',
            label: 'Bad',
            command: 'bad',
            resume: { command: '' as unknown as string, args: ['{id}'] },
          },
        ]),
      ).toThrow(/resume\.command must be a non-empty string/);
    });

    it('forward-compat: parser gracefully skips unknown nested blocks on a known agent', async () => {
      // Simulates a config written by a future syntaur version that adds a
      // new nested block (here: `extra:`) under an agent. The current parser
      // must skip the unknown block without corrupting the known fields.
      const configPath = resolve(homeDir, '.syntaur', 'config.md');
      await writeFile(
        configPath,
        [
          '---',
          'version: "2.0"',
          `defaultProjectDir: ${homeDir}/.syntaur/projects`,
          'agents:',
          '  - id: claude',
          '    label: Claude',
          '    command: claude',
          '    extra:',
          '      future-key: future-value',
          '      future-list:',
          '        - a',
          '        - b',
          '    resume:',
          '      args:',
          '        - "--resume"',
          '        - "{id}"',
          '---',
          '',
        ].join('\n'),
      );
      const config = await readConfig();
      expect(config.agents?.[0]).toMatchObject({
        id: 'claude',
        label: 'Claude',
        command: 'claude',
        resume: { args: ['--resume', '{id}'] },
      });
    });

    it('writeAgentsConfig preserves other frontmatter sections', async () => {
      const configPath = resolve(homeDir, '.syntaur', 'config.md');
      await writeFile(
        configPath,
        `---\nversion: "2.0"\ndefaultProjectDir: ${homeDir}/.syntaur/projects\nintegrations:\n  claudePluginDir: ${homeDir}/.claude/plugins/syntaur\n---\n\nBody content here.\n`,
      );
      await writeAgentsConfig([
        { id: 'claude', label: 'Claude', command: 'claude' },
      ]);
      const content = await readFile(configPath, 'utf-8');
      expect(content).toContain('integrations:');
      expect(content).toContain('agents:');
      expect(content).toContain('Body content here.');
    });
  });

  describe('getAgents builtin resume/fork merge', () => {
    it('inherits builtin resume/fork for a claude agent that omits them', async () => {
      await writeAgentsConfig([
        { id: 'claude', label: 'My Claude', command: 'claude', default: true },
      ]);
      const config = await readConfig();
      // The stored config genuinely lacks resume/fork (e.g. saved via the
      // dashboard editor, which drops those fields).
      expect(config.agents?.[0].resume).toBeUndefined();
      expect(config.agents?.[0].fork).toBeUndefined();
      const [claude] = getAgents(config);
      expect(claude.resume).toEqual({ args: ['--resume', '{id}'] });
      expect(claude.fork).toEqual({ args: ['--resume', '{id}', '--fork-session'] });
      expect(claude).toMatchObject({ id: 'claude', label: 'My Claude', command: 'claude' });
    });

    it('inherits builtin resume/fork for a codex agent that omits them', async () => {
      await writeAgentsConfig([{ id: 'codex', label: 'My Codex', command: 'codex' }]);
      const config = await readConfig();
      const [codex] = getAgents(config);
      expect(codex.resume).toEqual({ args: ['resume', '{id}'] });
      expect(codex.fork).toEqual({ args: ['fork', '{id}'] });
    });

    it('preserves user-provided resume/fork (does not overwrite with builtin)', async () => {
      await writeAgentsConfig([
        {
          id: 'claude',
          label: 'Claude',
          command: 'claude',
          resume: { args: ['--continue', '{id}'] },
          fork: { args: ['--branch', '{id}'] },
        },
      ]);
      const config = await readConfig();
      const [claude] = getAgents(config);
      expect(claude.resume).toEqual({ args: ['--continue', '{id}'] });
      expect(claude.fork).toEqual({ args: ['--branch', '{id}'] });
    });

    it('fills only the omitted side when one of resume/fork is provided', async () => {
      await writeAgentsConfig([
        {
          id: 'claude',
          label: 'Claude',
          command: 'claude',
          resume: { args: ['--continue', '{id}'] },
        },
      ]);
      const config = await readConfig();
      const [claude] = getAgents(config);
      expect(claude.resume).toEqual({ args: ['--continue', '{id}'] }); // user wins
      expect(claude.fork).toEqual({ args: ['--resume', '{id}', '--fork-session'] }); // inherited
    });

    it('leaves non-builtin agents untouched (no resume/fork injected)', async () => {
      await writeAgentsConfig([{ id: 'mytool', label: 'My Tool', command: 'mytool' }]);
      const config = await readConfig();
      const [mytool] = getAgents(config);
      expect(mytool.resume).toBeUndefined();
      expect(mytool.fork).toBeUndefined();
      expect(mytool).toMatchObject({ id: 'mytool', label: 'My Tool', command: 'mytool' });
    });
  });

  describe('updateAgentsConfig', () => {
    it('dry-run does not write', async () => {
      const result = await updateAgentsConfig(
        {
          kind: 'add',
          apply: (current) => [
            ...current,
            { id: 'new', label: 'New', command: 'new' },
          ],
        },
        { dryRun: true },
      );
      expect(result.written).toBe(false);
      expect(result.next.some((a) => a.id === 'new')).toBe(true);
      const config = await readConfig();
      expect(config.agents).toBeNull();
    });

    it('dry-run still validates and throws on invalid mutations', async () => {
      await writeAgentsConfig([
        { id: 'a', label: 'A', command: 'a' },
        { id: 'b', label: 'B', command: 'b' },
      ]);
      await expect(
        updateAgentsConfig(
          {
            kind: 'add',
            apply: (current) => [
              ...current,
              { id: 'a', label: 'dup', command: 'a' },
            ],
          },
          { dryRun: true },
        ),
      ).rejects.toThrow(AgentConfigError);
    });

    it('setting default: true clears other defaults atomically via helper logic', () => {
      // Mirrors the mergeOptionsIntoAgent behavior: caller clears previous defaults.
      const prev: AgentConfig[] = [
        { id: 'a', label: 'A', command: 'a', default: true },
        { id: 'b', label: 'B', command: 'b' },
      ];
      const next = prev.map((agent) => {
        if (agent.id === 'b') return { ...agent, default: true };
        return { ...agent, default: false };
      });
      const normalized = next.map((a) => (a.default ? a : { ...a, default: undefined as never }));
      // Strip undefined so validation matches the real write path
      const cleaned = normalized.map((a) => {
        const out: AgentConfig = { id: a.id, label: a.label, command: a.command };
        if (a.default) out.default = true;
        return out;
      });
      expect(() => validateAgentList(cleaned)).not.toThrow();
      expect(cleaned.filter((a) => a.default)).toHaveLength(1);
      expect(cleaned.find((a) => a.default)?.id).toBe('b');
    });

    it('reorder requires a covering list', async () => {
      await writeAgentsConfig([
        { id: 'a', label: 'A', command: 'a' },
        { id: 'b', label: 'B', command: 'b' },
      ]);
      await expect(
        updateAgentsConfig(
          {
            kind: 'reorder',
            apply: () => {
              throw new AgentConfigError('reorder list does not match current agents');
            },
          },
          {},
        ),
      ).rejects.toThrow(/reorder list/);
    });
  });
});

describe('BUILTIN_AGENTS launch agents (pi/openclaw/hermes)', () => {
  const byId = (id: string) => BUILTIN_AGENTS.find((a) => a.id === id);

  it('passes validateAgentList', () => {
    expect(() => validateAgentList(BUILTIN_AGENTS)).not.toThrow();
  });

  it('keeps claude first and the sole default', () => {
    expect(BUILTIN_AGENTS[0].id).toBe('claude');
    const defaults = BUILTIN_AGENTS.filter((a) => a.default === true);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe('claude');
  });

  it('has unique ids', () => {
    const ids = BUILTIN_AGENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ships pi with verified --session/--fork recipes', () => {
    const pi = byId('pi');
    expect(pi).toBeDefined();
    expect(pi!.command).toBe('pi');
    expect(pi!.resume).toEqual({ args: ['--session', '{id}'] });
    expect(pi!.fork).toEqual({ args: ['--fork', '{id}'] });
  });

  it('ships openclaw command-only (no resume/fork recipe)', () => {
    const openclaw = byId('openclaw');
    expect(openclaw).toBeDefined();
    expect(openclaw!.command).toBe('openclaw');
    expect(openclaw!.resume).toBeUndefined();
    expect(openclaw!.fork).toBeUndefined();
  });

  it('ships hermes command-only (no resume/fork recipe)', () => {
    const hermes = byId('hermes');
    expect(hermes).toBeDefined();
    expect(hermes!.command).toBe('hermes');
    expect(hermes!.resume).toBeUndefined();
    expect(hermes!.fork).toBeUndefined();
  });
});
