import { readFile, writeFile, copyFile, rm, stat, mkdir, symlink, unlink, lstat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { syntaurRoot } from '../utils/paths.js';
import { ensureDir, fileExists } from '../utils/fs.js';
import { confirmPrompt, isInteractiveTerminal, textPrompt } from '../utils/prompt.js';
import { writeDefaultConfigIfMissing } from './configure-statusline.js';

export type StatuslineMode = 'replace' | 'wrap' | 'skip' | 'ask';

export interface InstallStatuslineOptions {
  mode?: StatuslineMode;
  /** Override the source statusline.sh path (package root is auto-resolved otherwise). */
  sourceScript?: string;
  /** Override ~/.claude/settings.json path. */
  settingsPath?: string;
  /** Override ~/.syntaur installation root. */
  installRoot?: string;
  /** Symlink the installed script to the source instead of copying. */
  link?: boolean;
}

interface StatuslineConfigSnapshot {
  settingsPath: string;
  existingStatusLine: { type?: string; command?: string } | undefined;
  existingCommand: string | undefined;
}

function getPackageStatuslineSource(): string {
  // Locate statusline/statusline.sh relative to this built module at dist/index.js.
  // Layout: <pkg>/dist/index.js and <pkg>/statusline/statusline.sh.
  const here = dirname(fileURLToPath(import.meta.url));
  // `dist/index.js` -> parent is `dist`, grandparent is the package root.
  // `dist/commands/install-statusline.js` during build bundles everything into
  // a single dist/index.js, so __dirname here is `<pkg>/dist`. We walk up once.
  return resolve(here, '..', 'statusline', 'statusline.sh');
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

async function resolveMode(
  mode: StatuslineMode,
  existingCommand: string | undefined,
  ourCommand: string,
): Promise<Exclude<StatuslineMode, 'ask'>> {
  if (mode !== 'ask') return mode;
  if (!existingCommand || existingCommand === ourCommand) return 'replace';

  if (!isInteractiveTerminal()) {
    // Non-interactive + existing different command: safest default is to wrap.
    return 'wrap';
  }

  console.log(
    `A Claude Code statusLine is already configured:\n  ${existingCommand}\n`,
  );
  const wantWrap = await confirmPrompt(
    'Compose (wrap) your existing statusline with syntaur segments? [Y to wrap / n to replace]',
    true,
  );
  if (wantWrap) return 'wrap';
  const confirmReplace = await confirmPrompt(
    'Replace your existing statusline with syntaur only?',
    false,
  );
  return confirmReplace ? 'replace' : 'skip';
}

function extractExistingCommand(
  settings: Record<string, unknown>,
): { type?: string; command?: string } | undefined {
  const sl = (settings as { statusLine?: unknown }).statusLine;
  if (!sl || typeof sl !== 'object') return undefined;
  const obj = sl as { type?: unknown; command?: unknown };
  return {
    type: typeof obj.type === 'string' ? obj.type : undefined,
    command: typeof obj.command === 'string' ? obj.command : undefined,
  };
}

async function backupSettings(
  settingsSnapshot: StatuslineConfigSnapshot,
  backupPath: string,
): Promise<void> {
  await ensureDir(dirname(backupPath));
  await writeFile(
    backupPath,
    JSON.stringify(
      {
        version: 1,
        takenAt: new Date().toISOString(),
        settingsPath: settingsSnapshot.settingsPath,
        previousStatusLine: settingsSnapshot.existingStatusLine ?? null,
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
}

async function installScript(
  sourceScript: string,
  destScript: string,
  link: boolean,
): Promise<void> {
  await ensureDir(dirname(destScript));

  // Clear any existing install first.
  try {
    const s = await lstat(destScript);
    if (s.isSymbolicLink() || s.isFile()) {
      await unlink(destScript);
    }
  } catch {
    // No prior install — fine.
  }

  if (link) {
    await symlink(sourceScript, destScript);
  } else {
    await copyFile(sourceScript, destScript);
  }
}

export async function installStatuslineCommand(
  options: InstallStatuslineOptions = {},
): Promise<void> {
  const mode: StatuslineMode = options.mode ?? 'ask';
  const settingsPath = options.settingsPath ?? resolve(homedir(), '.claude', 'settings.json');
  const installRoot = options.installRoot ?? syntaurRoot();
  const sourceScript = options.sourceScript ?? getPackageStatuslineSource();
  const destScript = resolve(installRoot, 'statusline.sh');
  const confPath = resolve(installRoot, 'statusline.conf');
  const backupPath = resolve(installRoot, 'statusline.backup.json');

  if (!(await fileExists(sourceScript))) {
    throw new Error(
      `Statusline source script not found at ${sourceScript}. ` +
        `Try re-installing syntaur (npm install -g syntaur) or pass --source-script explicitly.`,
    );
  }

  // Copy/symlink the script into ~/.syntaur/statusline.sh.
  await installScript(sourceScript, destScript, Boolean(options.link));

  // Seed a default segment config so the line renders immediately. Users can
  // customize later via `syntaur configure-statusline`. If a config already
  // exists (e.g. from a prior install) we preserve it.
  await writeDefaultConfigIfMissing(installRoot);

  // Read existing settings.json.
  const settings = await readSettingsJson(settingsPath);
  const existingStatusLine = extractExistingCommand(settings);
  const existingCommand = existingStatusLine?.command;

  const ourCommand = `bash ${destScript}`;

  const resolvedMode = await resolveMode(mode, existingCommand, ourCommand);

  if (resolvedMode === 'skip') {
    console.log('Installed statusline script only:');
    console.log(`  script: ${destScript}`);
    console.log(`  source: ${sourceScript}`);
    console.log(
      '  (settings.json left unchanged — run with --mode=replace or --mode=wrap to wire it up)',
    );
    return;
  }

  // Back up the existing settings before mutating.
  await backupSettings(
    {
      settingsPath,
      existingStatusLine,
      existingCommand,
    },
    backupPath,
  );

  // Configure the conf file with wrap target (if any).
  let wrapTarget = '';
  if (resolvedMode === 'wrap' && existingCommand && existingCommand !== ourCommand) {
    // Extract the script path out of the existing command string. We accept
    // commands of the form "bash /path/to/script" or "/path/to/script". If we
    // can't parse it safely, fall back to storing the full command and letting
    // the user edit the conf.
    const parsed = parseWrapCommand(existingCommand);
    if (parsed) {
      wrapTarget = parsed;
    } else {
      // Store a wrapper shell line as the wrap target by saving a tiny script
      // at ~/.syntaur/statusline-wrapped.sh that execs the original command.
      const wrapperPath = resolve(installRoot, 'statusline-wrapped.sh');
      const wrapperBody = `#!/usr/bin/env bash\n# Auto-generated by syntaur install-statusline.\n# Executes the previously configured statusLine command.\nexec ${existingCommand}\n`;
      await writeFile(wrapperPath, wrapperBody, 'utf-8');
      await chmodExec(wrapperPath);
      wrapTarget = wrapperPath;
    }
  }
  await ensureDir(dirname(confPath));
  await writeFile(
    confPath,
    wrapTarget
      ? `# Wrap target — the command below is invoked with the same stdin; its\n` +
          `# stdout becomes the leading segment of the statusline. Remove this\n` +
          `# line or comment it out to disable wrapping.\n${wrapTarget}\n`
      : `# syntaur statusline config. Add a single path on a non-comment line to\n` +
          `# wrap another statusline script with syntaur segments appended.\n`,
    'utf-8',
  );

  // Update settings.json.
  (settings as { statusLine?: unknown }).statusLine = {
    type: 'command',
    command: ourCommand,
  };
  await writeSettingsJson(settingsPath, settings);

  console.log('Installed syntaur statusline:');
  console.log(`  script:       ${destScript}`);
  console.log(`  source:       ${sourceScript}`);
  console.log(`  mode:         ${resolvedMode}`);
  console.log(`  settings.json:${settingsPath}`);
  console.log(`  backup:       ${backupPath}`);
  if (wrapTarget) {
    console.log(`  wrap target:  ${wrapTarget}`);
    console.log(`  (edit ${confPath} to change or disable wrapping)`);
  }
}

function parseWrapCommand(command: string): string | null {
  const trimmed = command.trim();
  // "bash /abs/path.sh" (no args after) → /abs/path.sh
  const bashMatch = trimmed.match(/^bash\s+(\S+)$/);
  if (bashMatch) return bashMatch[1];
  // "/abs/path.sh" → /abs/path.sh
  if (/^\S+\.(sh|bash)$/.test(trimmed)) return trimmed;
  return null;
}

async function chmodExec(path: string): Promise<void> {
  const fs = await import('node:fs/promises');
  try {
    const s = await stat(path);
    await fs.chmod(path, s.mode | 0o111);
  } catch {
    // best effort
  }
}

// --- Uninstall ---

export interface UninstallStatuslineOptions {
  settingsPath?: string;
  installRoot?: string;
  /** Keep the installed script file on disk (only remove the settings.json entry). */
  keepScript?: boolean;
}

export async function uninstallStatuslineCommand(
  options: UninstallStatuslineOptions = {},
): Promise<void> {
  const settingsPath = options.settingsPath ?? resolve(homedir(), '.claude', 'settings.json');
  const installRoot = options.installRoot ?? syntaurRoot();
  const destScript = resolve(installRoot, 'statusline.sh');
  const confPath = resolve(installRoot, 'statusline.conf');
  const backupPath = resolve(installRoot, 'statusline.backup.json');
  const wrapperPath = resolve(installRoot, 'statusline-wrapped.sh');

  const settings = await readSettingsJson(settingsPath);
  const existing = extractExistingCommand(settings);
  const ourCommand = `bash ${destScript}`;

  let restored: { command?: string } | null = null;
  if (await fileExists(backupPath)) {
    try {
      const raw = await readFile(backupPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const prev = parsed?.previousStatusLine;
      if (prev && typeof prev === 'object' && typeof prev.command === 'string') {
        restored = { command: prev.command };
      }
    } catch {
      // Treat as no backup.
    }
  }

  if (existing?.command === ourCommand) {
    if (restored) {
      (settings as { statusLine?: unknown }).statusLine = {
        type: 'command',
        command: restored.command,
      };
    } else {
      delete (settings as { statusLine?: unknown }).statusLine;
    }
    await writeSettingsJson(settingsPath, settings);
  }

  if (!options.keepScript) {
    const configPath = resolve(installRoot, 'statusline.config.json');
    for (const path of [destScript, confPath, backupPath, wrapperPath, configPath]) {
      try {
        await rm(path, { force: true });
      } catch {
        // best effort
      }
    }
  }

  console.log('Uninstalled syntaur statusline.');
  if (restored) {
    console.log(`  Restored previous command: ${restored.command}`);
  } else {
    console.log('  Removed statusLine entry from settings.json.');
  }
  console.log(`  settings.json: ${settingsPath}`);
}
