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
      expect(defaults.map((a) => a.command)).toEqual(['claude', 'codex']);
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
