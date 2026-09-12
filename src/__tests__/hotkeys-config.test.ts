import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  readConfig,
  writeHotkeyBindingsConfig,
  deleteHotkeyBindingsConfig,
  writeThemeConfig,
} from '../utils/config.js';

let testDir: string;
let origSyntaurHome: string | undefined;

async function configPath(): Promise<string> {
  return resolve(testDir, 'config.md');
}

async function readConfigFile(): Promise<string> {
  return readFile(await configPath(), 'utf-8');
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-hotkeys-config-test-'));
  origSyntaurHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = testDir;
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  if (origSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = origSyntaurHome;
  await rm(testDir, { recursive: true, force: true });
});

describe('hotkeys block in config.md', () => {
  it('writeHotkeyBindingsConfig persists canonicalized combos', async () => {
    await writeHotkeyBindingsConfig({
      bindings: {
        'new-project': 'Shift+Mod+N',
        'new-ticket': 'Alt+a',
      },
    });

    const content = await readConfigFile();
    expect(content).toContain('hotkeys:');
    expect(content).toContain('bindings:');
    expect(content).toContain('new-project: "mod+shift+n"');
    expect(content).toContain('new-ticket: "alt+a"');

    const cfg = await readConfig();
    expect(cfg.hotkeys?.bindings['new-project']).toBe('mod+shift+n');
    expect(cfg.hotkeys?.bindings['new-ticket']).toBe('alt+a');
  });

  it('drops reserved combos on write', async () => {
    await writeHotkeyBindingsConfig({
      bindings: {
        // Reserved — must be dropped silently.
        'new-project': 'Mod+K',
        // Valid — must persist.
        'new-ticket': 'Shift+Alt+t',
      },
    });

    const cfg = await readConfig();
    expect(cfg.hotkeys?.bindings['new-project']).toBeUndefined();
    expect(cfg.hotkeys?.bindings['new-ticket']).toBe('alt+shift+t');
  });

  it('coexists with the theme: block', async () => {
    await writeThemeConfig({ preset: 'ocean' });
    await writeHotkeyBindingsConfig({
      bindings: { 'new-project': 'Mod+Shift+w' },
    });

    const content = await readConfigFile();
    expect(content).toContain('theme:');
    expect(content).toContain('preset: ocean');
    expect(content).toContain('hotkeys:');
    expect(content).toContain('new-project: "mod+shift+w"');

    const cfg = await readConfig();
    expect(cfg.theme?.preset).toBe('ocean');
    expect(cfg.hotkeys?.bindings['new-project']).toBe('mod+shift+w');
  });

  it('round-trips: write -> read -> write -> read', async () => {
    await writeHotkeyBindingsConfig({
      bindings: { 'new-ticket': 'Mod+Shift+t' },
    });
    await writeHotkeyBindingsConfig({
      bindings: { 'new-ticket': 'Mod+Shift+t', 'new-project': 'Alt+p' },
    });

    const cfg = await readConfig();
    expect(cfg.hotkeys?.bindings['new-ticket']).toBe('mod+shift+t');
    expect(cfg.hotkeys?.bindings['new-project']).toBe('alt+p');
  });

  it('deleteHotkeyBindingsConfig removes the block but leaves theme intact', async () => {
    await writeThemeConfig({ preset: 'sunset' });
    await writeHotkeyBindingsConfig({
      bindings: { 'new-project': 'Mod+Shift+w' },
    });

    await deleteHotkeyBindingsConfig();

    const content = await readConfigFile();
    expect(content).not.toContain('hotkeys:');
    expect(content).toContain('theme:');
    expect(content).toContain('preset: sunset');

    const cfg = await readConfig();
    expect(cfg.hotkeys).toBeNull();
    expect(cfg.theme?.preset).toBe('sunset');
  });

  it('skips unknown action kinds when parsing', async () => {
    const cfgPath = await configPath();
    await writeFile(
      cfgPath,
      `---
version: "2.0"
defaultProjectDir: ${testDir}/projects
hotkeys:
  bindings:
    new-ticket: "mod+shift+t"
    bogus-action: "alt+x"
---
`,
    );

    const cfg = await readConfig();
    expect(cfg.hotkeys?.bindings['new-ticket']).toBe('mod+shift+t');
    // @ts-expect-error — proving unknown kinds get filtered out.
    expect(cfg.hotkeys?.bindings['bogus-action']).toBeUndefined();
  });
});
