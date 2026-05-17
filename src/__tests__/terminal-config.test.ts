import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  readConfig,
  parseTerminalConfig,
  getTerminal,
  TerminalConfigError,
  TERMINAL_CHOICES,
} from '../utils/config.js';
import { renderConfig } from '../templates/config.js';
import { terminalChecks } from '../utils/doctor/checks/terminal.js';
import type { CheckContext, CheckResult } from '../utils/doctor/types.js';

describe('terminal config', () => {
  describe('parseTerminalConfig', () => {
    it('returns null for absent or empty values', () => {
      expect(parseTerminalConfig(undefined)).toBeNull();
      expect(parseTerminalConfig(null)).toBeNull();
      expect(parseTerminalConfig('')).toBeNull();
      expect(parseTerminalConfig('   ')).toBeNull();
    });

    it('accepts every known choice', () => {
      for (const choice of TERMINAL_CHOICES) {
        expect(parseTerminalConfig(choice)).toBe(choice);
      }
    });

    it('trims whitespace around the value', () => {
      expect(parseTerminalConfig('  ghostty  ')).toBe('ghostty');
    });

    it('rejects unknown values', () => {
      expect(() => parseTerminalConfig('xterm')).toThrow(TerminalConfigError);
      expect(() => parseTerminalConfig('xterm')).toThrow(/not a known choice/);
    });

    it('rejects non-string types', () => {
      expect(() => parseTerminalConfig(42)).toThrow(/must be a string/);
      expect(() => parseTerminalConfig(true)).toThrow(/must be a string/);
    });
  });

  describe('getTerminal', () => {
    it('returns the configured value when set', () => {
      const config = makeConfig({ terminal: 'ghostty' });
      expect(getTerminal(config)).toBe('ghostty');
    });

    it('falls back to terminal-app when unset', () => {
      const config = makeConfig({ terminal: null });
      expect(getTerminal(config)).toBe('terminal-app');
    });
  });

  describe('readConfig round-trip', () => {
    const originalHome = process.env.HOME;
    let homeDir: string;

    beforeEach(async () => {
      homeDir = await mkdtemp(join(tmpdir(), 'syntaur-terminal-'));
      process.env.HOME = homeDir;
      await mkdir(resolve(homeDir, '.syntaur'), { recursive: true });
    });

    afterEach(async () => {
      process.env.HOME = originalHome;
      await rm(homeDir, { recursive: true, force: true });
    });

    it('round-trips terminal: ghostty through renderConfig + readConfig', async () => {
      const rendered = renderConfig({ defaultProjectDir: homeDir }).replace(
        'terminal: terminal-app',
        'terminal: ghostty',
      );
      await writeFile(resolve(homeDir, '.syntaur/config.md'), rendered);
      const config = await readConfig();
      expect(config.terminal).toBe('ghostty');
      expect(getTerminal(config)).toBe('ghostty');
    });

    it('returns null when terminal: is omitted from config.md', async () => {
      const rendered = renderConfig({ defaultProjectDir: homeDir }).replace(
        /\nterminal: .*\n/,
        '\n',
      );
      await writeFile(resolve(homeDir, '.syntaur/config.md'), rendered);
      const config = await readConfig();
      expect(config.terminal).toBeNull();
      expect(getTerminal(config)).toBe('terminal-app');
    });

    it('warns and falls back to null when terminal: value is invalid', async () => {
      const rendered = renderConfig({ defaultProjectDir: homeDir }).replace(
        'terminal: terminal-app',
        'terminal: notarealterminal',
      );
      await writeFile(resolve(homeDir, '.syntaur/config.md'), rendered);
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (msg: string) => warnings.push(msg);
      try {
        const config = await readConfig();
        expect(config.terminal).toBeNull();
        expect(warnings.some((w) => /not a known choice/.test(w))).toBe(true);
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  describe('doctor terminal.value-valid', () => {
    const originalHome = process.env.HOME;
    const originalSyntaurHome = process.env.SYNTAUR_HOME;
    let homeDir: string;

    beforeEach(async () => {
      homeDir = await mkdtemp(join(tmpdir(), 'syntaur-doctor-term-'));
      process.env.HOME = homeDir;
      process.env.SYNTAUR_HOME = resolve(homeDir, '.syntaur');
      await mkdir(resolve(homeDir, '.syntaur'), { recursive: true });
    });

    afterEach(async () => {
      process.env.HOME = originalHome;
      if (originalSyntaurHome === undefined) {
        delete process.env.SYNTAUR_HOME;
      } else {
        process.env.SYNTAUR_HOME = originalSyntaurHome;
      }
      await rm(homeDir, { recursive: true, force: true });
    });

    async function runValueValidCheck(rawConfigBody: string): Promise<CheckResult> {
      await writeFile(resolve(homeDir, '.syntaur/config.md'), rawConfigBody);
      const config = await readConfig();
      const check = terminalChecks.find((c) => c.id === 'terminal.value-valid');
      if (!check) throw new Error('terminal.value-valid check not found');
      const ctx = {
        config,
        syntaurRoot: resolve(homeDir, '.syntaur'),
        db: null,
        dbError: null,
        cwd: process.cwd(),
        now: new Date(),
      } satisfies CheckContext;
      const result = await check.run(ctx);
      return Array.isArray(result) ? result[0] : result;
    }

    it('warns when raw config.md has an invalid terminal: value', async () => {
      // Quiet the readConfig warning so test output is clean.
      const originalWarn = console.warn;
      console.warn = () => {};
      try {
        const result = await runValueValidCheck(
          renderConfig({ defaultProjectDir: homeDir }).replace(
            'terminal: terminal-app',
            'terminal: bogus-terminal',
          ),
        );
        expect(result.status).toBe('warn');
        expect(result.detail).toContain('bogus-terminal');
        expect(result.remediation?.suggestion).toContain('config.md');
      } finally {
        console.warn = originalWarn;
      }
    });

    it('passes when raw config.md has a valid terminal: value', async () => {
      const result = await runValueValidCheck(
        renderConfig({ defaultProjectDir: homeDir }).replace(
          'terminal: terminal-app',
          'terminal: ghostty',
        ),
      );
      expect(result.status).toBe('pass');
      expect(result.detail).toContain('ghostty');
    });

    it('passes for a quoted valid value (terminal: "ghostty")', async () => {
      const result = await runValueValidCheck(
        renderConfig({ defaultProjectDir: homeDir }).replace(
          'terminal: terminal-app',
          'terminal: "ghostty"',
        ),
      );
      expect(result.status).toBe('pass');
      expect(result.detail).toContain('ghostty');
    });

    it("passes for a single-quoted valid value (terminal: 'iterm')", async () => {
      const result = await runValueValidCheck(
        renderConfig({ defaultProjectDir: homeDir }).replace(
          'terminal: terminal-app',
          "terminal: 'iterm'",
        ),
      );
      expect(result.status).toBe('pass');
      expect(result.detail).toContain('iterm');
    });

    it('passes when terminal: is absent from config.md', async () => {
      const result = await runValueValidCheck(
        renderConfig({ defaultProjectDir: homeDir }).replace(
          /\nterminal: .*\n/,
          '\n',
        ),
      );
      expect(result.status).toBe('pass');
      expect(result.detail).toContain('not set');
    });
  });
});

function makeConfig(overrides: { terminal: 'ghostty' | null }) {
  return {
    version: '1.0',
    defaultProjectDir: '/tmp',
    onboarding: { completed: false },
    agentDefaults: {
      trustLevel: 'medium' as const,
      autoApprove: false,
      autoCreateWorktree: 'ask' as const,
    },
    integrations: {
      claudePluginDir: null,
      codexPluginDir: null,
      codexMarketplacePath: null,
    },
    backup: null,
    statuses: null,
    types: null,
    agents: null,
    playbooks: { disabled: [] },
    theme: null,
    hotkeys: null,
    terminal: overrides.terminal,
  };
}
