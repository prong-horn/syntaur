import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile, readFile, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOOK_ENTRIES,
  installHooksCommand,
  uninstallHooksCommand,
  mergeHookEntries,
  removeHookEntries,
} from '../commands/hooks.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageHooksDir = resolve(here, '../../hooks');

let sandbox: string;
let settingsPath: string;
let installRoot: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-hooks-install-'));
  settingsPath = resolve(sandbox, 'claude', 'settings.json');
  installRoot = resolve(sandbox, 'syntaur');
  await mkdir(resolve(sandbox, 'claude'), { recursive: true });
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf-8'));
}

describe('hooks install', () => {
  it('writes nested hook groups for all three events', async () => {
    await installHooksCommand({ settingsPath, installRoot });
    const settings = await readJson(settingsPath);
    const hooks = settings.hooks as Record<string, unknown[]>;
    for (const entry of HOOK_ENTRIES) {
      const groups = hooks[entry.event];
      expect(Array.isArray(groups)).toBe(true);
      expect(groups).toHaveLength(1);
      const group = groups[0] as { hooks: Array<{ type: string; command: string; timeout: number }> };
      expect(group.hooks).toHaveLength(1);
      expect(group.hooks[0].type).toBe('command');
      expect(group.hooks[0].timeout).toBe(5);
      expect(group.hooks[0].command).toBe(
        `bash ${resolve(installRoot, 'hooks', entry.script)}`,
      );
    }
  });

  it('preserves foreign PreToolUse and statusLine byte-for-byte outside hooks', async () => {
    const foreign = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo foreign' }],
          },
        ],
      },
      statusLine: { type: 'command', command: 'echo sl' },
    };
    const raw = JSON.stringify(foreign, null, 2) + '\n';
    await writeFile(settingsPath, raw, 'utf-8');

    await installHooksCommand({ settingsPath, installRoot });
    const after = await readFile(settingsPath, 'utf-8');
    const parsed = JSON.parse(after);
    expect(parsed.statusLine).toEqual(foreign.statusLine);
    expect(parsed.hooks.PreToolUse).toEqual(foreign.hooks.PreToolUse);
  });

  it('is idempotent on a second install', async () => {
    await installHooksCommand({ settingsPath, installRoot });
    const first = await readFile(settingsPath, 'utf-8');
    await installHooksCommand({ settingsPath, installRoot });
    const second = await readFile(settingsPath, 'utf-8');
    expect(second).toBe(first);
  });

  it('replaces stale hook commands under the current install root', async () => {
    await installHooksCommand({ settingsPath, installRoot });
    const settings = await readJson(settingsPath);
    const hooks = settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    const legacyCmd = `bash ${resolve(installRoot, 'hooks', 'legacy', 'session-start.sh')}`;
    hooks.SessionStart[0].hooks[0].command = legacyCmd;
    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');

    await installHooksCommand({ settingsPath, installRoot });
    const after = await readJson(settingsPath);
    const afterHooks = after.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    const sessionStartCmd = afterHooks.SessionStart[0].hooks[0].command;
    expect(sessionStartCmd).toBe(`bash ${resolve(installRoot, 'hooks', 'session-start.sh')}`);
  });

  it('replaces hook commands under ~/.syntaur/hooks when install root moves', async () => {
    const legacyDir = resolve(installRoot, '.syntaur', 'hooks');
    const legacyCmd = `bash ${resolve(legacyDir, 'session-start.sh')}`;
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: legacyCmd, timeout: 5 }] }],
          },
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );
    await installHooksCommand({ settingsPath, installRoot });
    const settings = await readJson(settingsPath);
    const hooks = settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    const cmd = hooks.SessionStart[0].hooks[0].command;
    expect(cmd).toBe(`bash ${resolve(installRoot, 'hooks', 'session-start.sh')}`);
    expect(cmd).not.toBe(legacyCmd);
  });

  it('throws on unparseable settings without mutating settings.json or creating hooks dir', async () => {
    const bad = '{ not json';
    await writeFile(settingsPath, bad, 'utf-8');
    await expect(installHooksCommand({ settingsPath, installRoot })).rejects.toThrow(/Unable to parse/);
    expect(await readFile(settingsPath, 'utf-8')).toBe(bad);
    expect(existsSync(resolve(installRoot, 'hooks'))).toBe(false);
  });

  it('throws on unparseable settings without overwriting an existing hooks dir', async () => {
    const hooksDir = resolve(installRoot, 'hooks');
    await mkdir(hooksDir, { recursive: true });
    const marker = resolve(hooksDir, 'marker.txt');
    await writeFile(marker, 'keep-me', 'utf-8');
    const bad = '{ not json';
    await writeFile(settingsPath, bad, 'utf-8');
    await expect(installHooksCommand({ settingsPath, installRoot })).rejects.toThrow(/Unable to parse/);
    expect(await readFile(marker, 'utf-8')).toBe('keep-me');
  });

  it('preserves foreign SessionStart hooks that share script basenames', async () => {
    const foreignCmd = 'bash /opt/tool/hooks/session-start.sh';
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: foreignCmd }] }],
          },
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );
    await installHooksCommand({ settingsPath, installRoot });
    const settings = await readJson(settingsPath);
    const groups = settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    const sessionStart = groups.SessionStart;
    expect(sessionStart).toHaveLength(2);
    expect(sessionStart.some((g) => g.hooks.some((h) => h.command === foreignCmd))).toBe(true);
    expect(
      sessionStart.some((g) =>
        g.hooks.some((h) => h.command === `bash ${resolve(installRoot, 'hooks', 'session-start.sh')}`),
      ),
    ).toBe(true);

    await uninstallHooksCommand({ settingsPath, installRoot });
    const after = await readJson(settingsPath);
    const afterGroups = after.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(afterGroups.SessionStart).toHaveLength(1);
    expect(afterGroups.SessionStart[0].hooks[0].command).toBe(foreignCmd);
  });

  it('writes hooks.backup.json with previous hooks value', async () => {
    await writeFile(
      settingsPath,
      JSON.stringify({ hooks: { SessionEnd: [] } }, null, 2) + '\n',
      'utf-8',
    );
    await installHooksCommand({ settingsPath, installRoot });
    const backup = await readJson(resolve(installRoot, 'hooks.backup.json'));
    expect(backup.version).toBe(1);
    expect(backup.settingsPath).toBe(settingsPath);
    expect(backup.previousHooks).toEqual({ SessionEnd: [] });
  });

  it('copies hook scripts as executable and byte-identical to the package', async () => {
    await installHooksCommand({ settingsPath, installRoot });
    for (const name of ['session-start.sh', 'session-touch.sh', 'prompt-context.sh', 'lib.sh']) {
      const installed = resolve(installRoot, 'hooks', name);
      const pkg = resolve(packageHooksDir, name);
      const [a, b] = await Promise.all([readFile(installed, 'utf-8'), readFile(pkg, 'utf-8')]);
      expect(a).toBe(b);
      const s = await stat(installed);
      expect(s.mode & 0o111).not.toBe(0);
    }
  });

  it('uninstall removes our entries and leaves foreign hooks', async () => {
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [{ hooks: [{ type: 'command', command: 'echo keep' }] }],
          },
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );
    await installHooksCommand({ settingsPath, installRoot });
    await uninstallHooksCommand({ settingsPath, installRoot });
    const settings = await readJson(settingsPath);
    expect(settings.hooks).toEqual({
      PreToolUse: [{ hooks: [{ type: 'command', command: 'echo keep' }] }],
    });
  });
});

describe('mergeHookEntries / removeHookEntries', () => {
  it('mergeHookEntries nests commands per event', () => {
    const dir = '/tmp/syntaur/hooks';
    const merged = mergeHookEntries({}, HOOK_ENTRIES, dir);
    const hooks = merged.hooks as Record<string, unknown[]>;
    expect(Object.keys(hooks).sort()).toEqual(['PostToolUse', 'SessionStart', 'UserPromptSubmit']);
  });

  it('removeHookEntries drops emptied hook keys', () => {
    const dir = resolve(installRoot, 'hooks');
    const settings = mergeHookEntries({}, HOOK_ENTRIES, dir);
    const stripped = removeHookEntries(settings, dir);
    expect(stripped.hooks).toBeUndefined();
  });
});
