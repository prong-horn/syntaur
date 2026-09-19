import { createHash } from 'node:crypto';
import { readFile, writeFile, copyFile, rm, chmod, readdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { syntaurRoot } from '../utils/paths.js';
import { ensureDir, fileExists } from '../utils/fs.js';

export interface HookEntry {
  event: 'SessionStart' | 'PostToolUse' | 'UserPromptSubmit';
  script: string;
  timeout: number;
}

export const HOOK_ENTRIES: HookEntry[] = [
  { event: 'SessionStart', script: 'session-start.sh', timeout: 5 },
  { event: 'PostToolUse', script: 'session-touch.sh', timeout: 5 },
  { event: 'UserPromptSubmit', script: 'prompt-context.sh', timeout: 5 },
];

const HOOK_SCRIPT_NAMES = ['session-start.sh', 'session-touch.sh', 'prompt-context.sh', 'lib.sh'];

export interface HooksCommandOptions {
  settingsPath?: string;
  installRoot?: string;
}

type HookCommand = { type: string; command: string; timeout?: number };
type HookGroup = { matcher?: string; hooks: HookCommand[] };
type HooksSettings = Record<string, HookGroup[]>;

function getPackageHooksDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Bundled CLI: `dist/index.js` → package root is one level up.
  return resolve(here, '..', 'hooks');
}

async function readSettingsJson(settingsPath: string): Promise<Record<string, unknown>> {
  if (!(await fileExists(settingsPath))) return {};
  const raw = await readFile(settingsPath, 'utf-8');
  if (raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    throw new Error(
      `Unable to parse ${settingsPath}: ${(error as Error).message}. Fix the JSON and re-run.`,
    );
  }
}

async function writeSettingsJson(settingsPath: string, data: Record<string, unknown>): Promise<void> {
  await ensureDir(dirname(settingsPath));
  await writeFile(settingsPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

export function hooksDirForInstallRoot(installRoot: string): string {
  return resolve(installRoot, 'hooks');
}

export function isOurHookCommand(command: string, installedHooksDir: string): boolean {
  const normalized = installedHooksDir.replace(/\\/g, '/');
  if (command.includes(`${normalized}/`)) return true;
  if (command.includes('/.syntaur/hooks/')) return true;
  return HOOK_ENTRIES.some((entry) => command.includes(`/hooks/${entry.script}`));
}

function commandForScript(installedHooksDir: string, script: string): string {
  return `bash ${resolve(installedHooksDir, script)}`;
}

function buildGroup(entry: HookEntry, installedHooksDir: string): HookGroup {
  return {
    hooks: [
      {
        type: 'command',
        command: commandForScript(installedHooksDir, entry.script),
        timeout: entry.timeout,
      },
    ],
  };
}

export function mergeHookEntries(
  settings: Record<string, unknown>,
  entries: HookEntry[],
  installedHooksDir: string,
): Record<string, unknown> {
  const out = { ...settings };
  const hooks = { ...((out.hooks as HooksSettings | undefined) ?? {}) };

  for (const entry of entries) {
    const existing = Array.isArray(hooks[entry.event]) ? [...hooks[entry.event]!] : [];
    const filtered = existing.filter((group) => {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) return true;
      return !group.hooks.some(
        (h) => typeof h.command === 'string' && isOurHookCommand(h.command, installedHooksDir),
      );
    });
    filtered.push(buildGroup(entry, installedHooksDir));
    hooks[entry.event] = filtered;
  }

  out.hooks = hooks;
  return out;
}

export function removeHookEntries(
  settings: Record<string, unknown>,
  installedHooksDir: string,
): Record<string, unknown> {
  const out = { ...settings };
  const hooksRaw = out.hooks;
  if (!hooksRaw || typeof hooksRaw !== 'object') {
    delete out.hooks;
    return out;
  }

  const hooks = { ...(hooksRaw as HooksSettings) };
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const next = groups
      .map((group) => {
        if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) return group;
        const kept = group.hooks.filter(
          (h) => !(typeof h.command === 'string' && isOurHookCommand(h.command, installedHooksDir)),
        );
        if (kept.length === 0) return null;
        return { ...group, hooks: kept };
      })
      .filter((g): g is HookGroup => g !== null);
    if (next.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = next;
    }
  }

  if (Object.keys(hooks).length === 0) {
    delete out.hooks;
  } else {
    out.hooks = hooks;
  }
  return out;
}

async function sha256File(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash('sha256').update(buf).digest('hex');
}

async function copyHookScripts(sourceDir: string, destDir: string): Promise<void> {
  await ensureDir(destDir);
  for (const name of HOOK_SCRIPT_NAMES) {
    const src = resolve(sourceDir, name);
    const dest = resolve(destDir, name);
    if (!(await fileExists(src))) {
      throw new Error(`Hook script missing in package: ${src}`);
    }
    await copyFile(src, dest);
    await chmod(dest, 0o755);
  }
}

function settingsAlreadyHasOurEntries(
  settings: Record<string, unknown>,
  entries: HookEntry[],
  installedHooksDir: string,
): boolean {
  const hooks = settings.hooks as HooksSettings | undefined;
  if (!hooks) return false;
  for (const entry of entries) {
    const groups = hooks[entry.event];
    if (!Array.isArray(groups) || groups.length === 0) return false;
    const expected = commandForScript(installedHooksDir, entry.script);
    const found = groups.some(
      (g) =>
        Array.isArray(g.hooks) &&
        g.hooks.some((h) => h.type === 'command' && h.command === expected && h.timeout === entry.timeout),
    );
    if (!found) return false;
  }
  return true;
}

async function backupHooksSettings(
  settingsPath: string,
  installRoot: string,
  previousHooks: unknown,
): Promise<string> {
  const backupPath = resolve(installRoot, 'hooks.backup.json');
  await ensureDir(dirname(backupPath));
  await writeFile(
    backupPath,
    JSON.stringify(
      {
        version: 1,
        takenAt: new Date().toISOString(),
        settingsPath,
        previousHooks: previousHooks ?? null,
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  return backupPath;
}

export async function installHooksCommand(options: HooksCommandOptions = {}): Promise<void> {
  const settingsPath = options.settingsPath ?? resolve(homedir(), '.claude', 'settings.json');
  const installRoot = options.installRoot ?? syntaurRoot();
  const sourceDir = getPackageHooksDir();
  const installedHooksDir = hooksDirForInstallRoot(installRoot);
  const backupPath = resolve(installRoot, 'hooks.backup.json');

  await copyHookScripts(sourceDir, installedHooksDir);

  const settings = await readSettingsJson(settingsPath);
  const previousHooks = settings.hooks;

  if (settingsAlreadyHasOurEntries(settings, HOOK_ENTRIES, installedHooksDir)) {
    console.log('Syntaur hooks already installed (settings unchanged).');
    console.log(`  settings.json: ${settingsPath}`);
    for (const entry of HOOK_ENTRIES) {
      console.log(`  ${entry.event}: ${commandForScript(installedHooksDir, entry.script)}`);
    }
    return;
  }

  await backupHooksSettings(settingsPath, installRoot, previousHooks);

  const stripped = removeHookEntries(settings, installedHooksDir);
  const merged = mergeHookEntries(stripped, HOOK_ENTRIES, installedHooksDir);
  await writeSettingsJson(settingsPath, merged);

  console.log('Installed Syntaur hooks:');
  console.log(`  hooks dir:     ${installedHooksDir}`);
  console.log(`  settings.json: ${settingsPath}`);
  console.log(`  backup:        ${backupPath}`);
  for (const entry of HOOK_ENTRIES) {
    console.log(`  ${entry.event}: ${commandForScript(installedHooksDir, entry.script)}`);
  }
}

export async function uninstallHooksCommand(options: HooksCommandOptions = {}): Promise<void> {
  const settingsPath = options.settingsPath ?? resolve(homedir(), '.claude', 'settings.json');
  const installRoot = options.installRoot ?? syntaurRoot();
  const installedHooksDir = hooksDirForInstallRoot(installRoot);

  const settings = await readSettingsJson(settingsPath);
  const next = removeHookEntries(settings, installedHooksDir);
  await writeSettingsJson(settingsPath, next);

  try {
    await rm(installedHooksDir, { recursive: true, force: true });
  } catch {
    // best effort
  }

  console.log('Uninstalled Syntaur hooks.');
  console.log(`  settings.json: ${settingsPath}`);
  console.log(`  removed dir:   ${installedHooksDir}`);
}

/** Package hook script paths for doctor drift checks. */
export async function listPackageHookScripts(): Promise<string[]> {
  const dir = getPackageHooksDir();
  const names = await readdir(dir);
  return names.filter((n) => n.endsWith('.sh')).map((n) => join(dir, n));
}

export async function fileSha256(path: string): Promise<string> {
  return sha256File(path);
}
