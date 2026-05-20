import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  readConfig,
  parseTerminalConfig,
  getTerminal,
  TerminalConfigError,
  TERMINAL_CHOICES,
  writeTerminalConfig,
  deleteTerminalConfig,
} from '../utils/config.js';
import { renderConfig } from '../templates/config.js';
import { terminalChecks } from '../utils/doctor/checks/terminal.js';
import type { CheckContext, CheckResult } from '../utils/doctor/types.js';

/**
 * Inject a `terminal: <value>` line into a rendered template's frontmatter.
 * Necessary because the template no longer ships `terminal: terminal-app`
 * out of the box — the OS-aware default decides at read time.
 */
function renderConfigWithTerminal(
  defaultProjectDir: string,
  terminalLine: string,
): string {
  return renderConfig({ defaultProjectDir }).replace(
    /\n---\n/,
    `\n${terminalLine}\n---\n`,
  );
}

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
      const rendered = renderConfigWithTerminal(homeDir, 'terminal: ghostty');
      await writeFile(resolve(homeDir, '.syntaur/config.md'), rendered);
      const config = await readConfig();
      expect(config.terminal).toBe('ghostty');
      expect(getTerminal(config)).toBe('ghostty');
    });

    it('returns null when terminal: is omitted from config.md', async () => {
      const rendered = renderConfig({ defaultProjectDir: homeDir });
      await writeFile(resolve(homeDir, '.syntaur/config.md'), rendered);
      const config = await readConfig();
      expect(config.terminal).toBeNull();
      // getTerminal returns OS-aware default; on darwin/linux/other it is
      // never null. We don't assert the exact value here — that's covered by
      // the dedicated OS-aware describe block below.
    });

    it('default template no longer hardcodes terminal:', () => {
      expect(renderConfig({ defaultProjectDir: '/tmp' })).not.toMatch(
        /\nterminal:\s*\S/,
      );
    });

    it('warns and falls back to null when terminal: value is invalid', async () => {
      const rendered = renderConfigWithTerminal(
        homeDir,
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
          renderConfigWithTerminal(homeDir, 'terminal: bogus-terminal'),
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
        renderConfigWithTerminal(homeDir, 'terminal: ghostty'),
      );
      expect(result.status).toBe('pass');
      expect(result.detail).toContain('ghostty');
    });

    it('passes for a quoted valid value (terminal: "ghostty")', async () => {
      const result = await runValueValidCheck(
        renderConfigWithTerminal(homeDir, 'terminal: "ghostty"'),
      );
      expect(result.status).toBe('pass');
      expect(result.detail).toContain('ghostty');
    });

    it("passes for a single-quoted valid value (terminal: 'iterm')", async () => {
      const result = await runValueValidCheck(
        renderConfigWithTerminal(homeDir, "terminal: 'iterm'"),
      );
      expect(result.status).toBe('pass');
      expect(result.detail).toContain('iterm');
    });

    it('passes when terminal: is absent from config.md', async () => {
      const result = await runValueValidCheck(
        renderConfig({ defaultProjectDir: homeDir }),
      );
      expect(result.status).toBe('pass');
      expect(result.detail).toContain('not set');
    });
  });

  describe('writeTerminalConfig + deleteTerminalConfig', () => {
    const originalHome = process.env.HOME;
    const originalSyntaurHome = process.env.SYNTAUR_HOME;
    let homeDir: string;

    beforeEach(async () => {
      homeDir = await mkdtemp(join(tmpdir(), 'syntaur-term-write-'));
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

    it('writes terminal: into existing frontmatter with no prior key', async () => {
      const rendered = renderConfig({ defaultProjectDir: homeDir });
      const configPath = resolve(homeDir, '.syntaur/config.md');
      await writeFile(configPath, rendered);
      await writeTerminalConfig('ghostty');
      const content = await readFile(configPath, 'utf-8');
      expect(content).toMatch(/^terminal: ghostty$/m);
      const config = await readConfig();
      expect(config.terminal).toBe('ghostty');
    });

    it('replaces an existing terminal: value', async () => {
      const rendered = renderConfigWithTerminal(homeDir, 'terminal: ghostty');
      const configPath = resolve(homeDir, '.syntaur/config.md');
      await writeFile(configPath, rendered);
      await writeTerminalConfig('iterm');
      const content = await readFile(configPath, 'utf-8');
      expect(content.match(/^terminal:.*$/gm)?.length).toBe(1);
      expect(content).toMatch(/^terminal: iterm$/m);
    });

    it('deleteTerminalConfig removes the line', async () => {
      const rendered = renderConfigWithTerminal(homeDir, 'terminal: warp');
      const configPath = resolve(homeDir, '.syntaur/config.md');
      await writeFile(configPath, rendered);
      await deleteTerminalConfig();
      const content = await readFile(configPath, 'utf-8');
      expect(content).not.toMatch(/\nterminal:\s*\S/);
    });

    it('deleteTerminalConfig is a no-op when terminal is absent', async () => {
      const rendered = renderConfig({ defaultProjectDir: homeDir });
      const configPath = resolve(homeDir, '.syntaur/config.md');
      await writeFile(configPath, rendered);
      const before = await readFile(configPath, 'utf-8');
      await deleteTerminalConfig();
      const after = await readFile(configPath, 'utf-8');
      // strip-trailing-newlines normalization may differ; ensure absence is unchanged
      expect(after).not.toMatch(/\nterminal:\s*\S/);
      expect(before).not.toMatch(/\nterminal:\s*\S/);
    });
  });

  describe('getTerminal OS-aware default', () => {
    const originalPlatform = process.platform;
    const originalPath = process.env.PATH;
    let pathDir: string;

    function setPlatform(platform: NodeJS.Platform): void {
      Object.defineProperty(process, 'platform', {
        value: platform,
        configurable: true,
      });
    }

    beforeEach(async () => {
      pathDir = await mkdtemp(join(tmpdir(), 'syntaur-path-'));
    });

    afterEach(async () => {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
      process.env.PATH = originalPath;
      await rm(pathDir, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    it('returns terminal-app on darwin', () => {
      setPlatform('darwin');
      const config = makeConfig({ terminal: null });
      expect(getTerminal(config)).toBe('terminal-app');
    });

    it('returns first installed CLI terminal on linux (kitty wins probe order)', async () => {
      setPlatform('linux');
      // Stage a fake `kitty` first on PATH so it wins probe order [kitty,
      // alacritty, warp] regardless of what the host has installed. /usr/bin
      // stays on PATH so the spawned `which` itself resolves.
      const kittyPath = join(pathDir, 'kitty');
      await writeFile(kittyPath, '#!/bin/sh\nexit 0\n');
      await chmod(kittyPath, 0o755);
      process.env.PATH = `${pathDir}:/usr/bin:/bin`;
      const config = makeConfig({ terminal: null });
      expect(getTerminal(config)).toBe('kitty');
    });

    it('falls back to terminal-app on linux when no probe hits', () => {
      setPlatform('linux');
      // Point PATH at a non-existent dir so the spawned `which` itself fails
      // to resolve — no chance of accidentally hitting a host install.
      process.env.PATH = '/tmp/syntaur-test-no-such-dir';
      const config = makeConfig({ terminal: null });
      expect(getTerminal(config)).toBe('terminal-app');
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
