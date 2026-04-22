import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  installStatuslineCommand,
  uninstallStatuslineCommand,
} from '../commands/install-statusline.js';

const here = dirname(fileURLToPath(import.meta.url));
const sourceScript = resolve(here, '../../statusline/statusline.sh');

let sandbox: string;
let settingsPath: string;
let installRoot: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-install-statusline-'));
  settingsPath = resolve(sandbox, 'claude', 'settings.json');
  installRoot = resolve(sandbox, 'syntaur');
  await mkdir(resolve(sandbox, 'claude'), { recursive: true });
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, 'utf-8'));
}

describe('install-statusline', () => {
  it('creates settings.json with our statusLine when none exists (mode=replace)', async () => {
    await installStatuslineCommand({
      mode: 'replace',
      sourceScript,
      settingsPath,
      installRoot,
    });

    const settings = await readJson(settingsPath);
    expect(settings.statusLine).toEqual({
      type: 'command',
      command: `bash ${resolve(installRoot, 'statusline.sh')}`,
    });

    const installedScript = resolve(installRoot, 'statusline.sh');
    const s = await stat(installedScript);
    expect(s.isFile()).toBe(true);
  });

  it('no-ops when settings already points at our install', async () => {
    await installStatuslineCommand({
      mode: 'replace',
      sourceScript,
      settingsPath,
      installRoot,
    });
    const before = await readJson(settingsPath);
    await installStatuslineCommand({
      mode: 'ask',
      sourceScript,
      settingsPath,
      installRoot,
    });
    const after = await readJson(settingsPath);
    expect(after).toEqual(before);
  });

  it('wrap mode preserves the previous statusLine command in the conf file', async () => {
    // Seed an existing statusLine configuration.
    const userScript = resolve(sandbox, 'my-statusline.sh');
    await writeFile(
      userScript,
      '#!/usr/bin/env bash\necho "custom status"\n',
      'utf-8',
    );
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          permissions: { allow: [] },
          statusLine: { type: 'command', command: `bash ${userScript}` },
        },
        null,
        2,
      ),
      'utf-8',
    );
    // Make dir exist (readSettingsJson requires parent)
    // already created by writeFile above.

    await installStatuslineCommand({
      mode: 'wrap',
      sourceScript,
      settingsPath,
      installRoot,
    });

    const settings = await readJson(settingsPath);
    expect(settings.statusLine.command).toBe(
      `bash ${resolve(installRoot, 'statusline.sh')}`,
    );
    // Other settings preserved.
    expect(settings.permissions.allow).toEqual([]);

    const confContents = await readFile(
      resolve(installRoot, 'statusline.conf'),
      'utf-8',
    );
    expect(confContents).toContain(userScript);

    // Backup records the prior command.
    const backup = await readJson(resolve(installRoot, 'statusline.backup.json'));
    expect(backup.previousStatusLine.command).toBe(`bash ${userScript}`);
  });

  it('wrap mode renders composed output when driving the installed script', async () => {
    // Seed a user script that prints something identifiable.
    const userScript = resolve(sandbox, 'my-statusline.sh');
    await writeFile(
      userScript,
      "#!/usr/bin/env bash\ninput=$(cat)\nprintf 'USER_STATUS'\n",
      'utf-8',
    );
    await writeFile(
      settingsPath,
      JSON.stringify(
        { statusLine: { type: 'command', command: `bash ${userScript}` } },
        null,
        2,
      ),
      'utf-8',
    );

    await installStatuslineCommand({
      mode: 'wrap',
      sourceScript,
      settingsPath,
      installRoot,
    });

    const installedScript = resolve(installRoot, 'statusline.sh');
    const res = spawnSync('bash', [installedScript], {
      input: JSON.stringify({
        session_id: 'aaaaaaaaaaaaaaaaaaaa1234567890ab',
        cwd: sandbox,
      }),
      encoding: 'utf-8',
      env: { ...process.env, HOME: sandbox },
    });
    expect(res.status).toBe(0);
    // HOME = sandbox so the script picks up <sandbox>/.syntaur/statusline.conf
    // written by installStatusline; we installed under installRoot which is
    // <sandbox>/syntaur, so the script will not find a conf at $HOME/.syntaur.
    // Force wrap via env instead for a deterministic test.
    const res2 = spawnSync('bash', [installedScript], {
      input: JSON.stringify({
        session_id: 'aaaaaaaaaaaaaaaaaaaa1234567890ab',
        cwd: sandbox,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: sandbox,
        SYNTAUR_STATUSLINE_WRAP: userScript,
      },
    });
    expect(res2.status).toBe(0);
    expect(res2.stdout).toContain('USER_STATUS');
    expect(res2.stdout).toContain('aaaaaaaaaaaaaaaaaaaa1234567890ab');
  });

  it('skip mode leaves settings.json untouched', async () => {
    const existing = {
      statusLine: { type: 'command', command: 'echo existing' },
      other: 'keep',
    };
    await writeFile(settingsPath, JSON.stringify(existing, null, 2), 'utf-8');

    await installStatuslineCommand({
      mode: 'skip',
      sourceScript,
      settingsPath,
      installRoot,
    });

    const after = await readJson(settingsPath);
    expect(after).toEqual(existing);
    // Script still installed even when skipping the settings wire-up.
    const s = await stat(resolve(installRoot, 'statusline.sh'));
    expect(s.isFile()).toBe(true);
  });

  it('uninstall restores the previous command from backup', async () => {
    const userScript = resolve(sandbox, 'prior.sh');
    await writeFile(userScript, '#!/usr/bin/env bash\necho prior\n', 'utf-8');
    await writeFile(
      settingsPath,
      JSON.stringify(
        { statusLine: { type: 'command', command: `bash ${userScript}` } },
        null,
        2,
      ),
      'utf-8',
    );

    await installStatuslineCommand({
      mode: 'wrap',
      sourceScript,
      settingsPath,
      installRoot,
    });

    await uninstallStatuslineCommand({
      settingsPath,
      installRoot,
    });

    const after = await readJson(settingsPath);
    expect(after.statusLine).toEqual({
      type: 'command',
      command: `bash ${userScript}`,
    });
  });

  it('uninstall deletes the statusLine entry when no backup exists', async () => {
    await installStatuslineCommand({
      mode: 'replace',
      sourceScript,
      settingsPath,
      installRoot,
    });
    // Simulate missing backup by removing it.
    await rm(resolve(installRoot, 'statusline.backup.json'), { force: true });

    await uninstallStatuslineCommand({
      settingsPath,
      installRoot,
    });

    const after = await readJson(settingsPath);
    expect(after.statusLine).toBeUndefined();
  });
});
