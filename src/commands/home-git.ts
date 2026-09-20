import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { homedir } from 'node:os';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileExists } from '../utils/fs.js';

export type HomeGitRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv },
) => SpawnSyncReturns<string>;

export interface HomeGitDeps {
  platform: NodeJS.Platform;
  runner: HomeGitRunner;
  launchAgentsDir: string;
  uid: number;
}

export const HOME_COMMIT_SCRIPT = 'home-commit.sh';
export const HOME_COMMIT_LAUNCH_LABEL = 'com.syntaur.home-commit';
export const HOME_COMMIT_CRON_MARKER = 'syntaur-home-commit';

export const HOME_GITIGNORE_CONTENT = `# syntaur: operational state is not history
syntaur.db
syntaur.db-*
*.bak
*.log
runtime/
dashboard-port
view-prefs*.json
inbox-snoozes.json
npx-install.json
npx-handler-nudge
worktrees/
`;

function defaultRunner(
  command: string,
  args: string[],
  options?: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv },
): SpawnSyncReturns<string> {
  return spawnSync(command, args, {
    encoding: 'utf-8',
    cwd: options?.cwd,
    input: options?.input,
    env: options?.env ?? process.env,
  });
}

export function defaultHomeGitDeps(): HomeGitDeps {
  return {
    platform: process.platform,
    runner: defaultRunner,
    launchAgentsDir: resolve(homedir(), 'Library/LaunchAgents'),
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
  };
}

export function renderHomeCommitScript(home: string): string {
  return `#!/bin/sh
# Written by \`syntaur init\`. Commits the Syntaur home once a day.
set -u
PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:\${PATH:-}"; export PATH
cd "${home}" || exit 0
[ -d .git ] || exit 0
git add -A >/dev/null 2>&1 || exit 0
git diff --cached --quiet && exit 0
git commit -q -m "syntaur auto-commit $(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null 2>&1
`;
}

export function renderLaunchAgentPlist(
  label: string,
  scriptPath: string,
  logPath: string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${scriptPath}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>17</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>
`;
}

export function renderCronLine(scriptPath: string): string {
  return `17 3 * * * /bin/sh ${scriptPath} # ${HOME_COMMIT_CRON_MARKER}`;
}

function gitAvailable(deps: HomeGitDeps): boolean {
  const r = deps.runner('git', ['--version']);
  return r.status === 0;
}

function gitConfigEmpty(home: string, key: string, deps: HomeGitDeps): boolean {
  const r = deps.runner('git', ['-C', home, 'config', key]);
  return r.status !== 0 || (r.stdout ?? '').trim() === '';
}

export async function ensureHomeRepo(home: string, deps: HomeGitDeps = defaultHomeGitDeps()): Promise<void> {
  if (!gitAvailable(deps)) {
    console.log('Git: not found; skipping repository setup');
    return;
  }

  const gitDir = resolve(home, '.git');
  if (await fileExists(gitDir)) {
    console.log(`Git: ${home} is already a repository`);
    return;
  }

  deps.runner('git', ['-C', home, 'init', '-q']);

  const gitignorePath = resolve(home, '.gitignore');
  if (!(await fileExists(gitignorePath))) {
    await writeFile(gitignorePath, HOME_GITIGNORE_CONTENT, 'utf-8');
  }

  if (gitConfigEmpty(home, 'user.name', deps)) {
    deps.runner('git', ['-C', home, 'config', 'user.name', 'Syntaur']);
    deps.runner('git', ['-C', home, 'config', 'user.email', 'syntaur@localhost']);
  }

  deps.runner('git', ['-C', home, 'add', '-A']);
  deps.runner('git', ['-C', home, 'commit', '-q', '-m', 'syntaur: initial commit']);

  const sha = deps.runner('git', ['-C', home, 'rev-parse', '--short', 'HEAD']).stdout?.trim() ?? '???????';
  console.log(`Git: initialised ${home} (initial commit ${sha})`);
}

export async function writeHomeCommitScript(home: string): Promise<string> {
  const scriptPath = resolve(home, HOME_COMMIT_SCRIPT);
  await writeFile(scriptPath, renderHomeCommitScript(home), 'utf-8');
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

export interface InstallAutoCommitOptions {
  /** When false, only write home-commit.sh (no launchd/cron). */
  scheduler?: boolean;
}

export async function installAutoCommit(
  home: string,
  deps: HomeGitDeps = defaultHomeGitDeps(),
  options: InstallAutoCommitOptions = {},
): Promise<void> {
  const scheduler = options.scheduler ?? true;
  const scriptPath = await writeHomeCommitScript(home);

  if (!scheduler) {
    console.log('Auto-commit: scheduler skipped (--no-auto-commit)');
    return;
  }

  if (deps.platform === 'darwin') {
    const plistPath = resolve(deps.launchAgentsDir, `${HOME_COMMIT_LAUNCH_LABEL}.plist`);
    const logPath = resolve(home, 'runtime', 'home-commit.log');
    await mkdir(resolve(home, 'runtime'), { recursive: true });
    await mkdir(deps.launchAgentsDir, { recursive: true });
    await writeFile(
      plistPath,
      renderLaunchAgentPlist(HOME_COMMIT_LAUNCH_LABEL, scriptPath, logPath),
      'utf-8',
    );

    deps.runner('launchctl', ['bootout', `gui/${deps.uid}/${HOME_COMMIT_LAUNCH_LABEL}`]);
    const bootstrap = deps.runner('launchctl', ['bootstrap', `gui/${deps.uid}`, plistPath]);
    if (bootstrap.status !== 0) {
      console.log(
        `Auto-commit: launchctl bootstrap failed — load manually: launchctl bootstrap gui/${deps.uid} ${plistPath}`,
      );
    } else {
      console.log(`Auto-commit: installed LaunchAgent ${plistPath}`);
    }
    return;
  }

  if (deps.platform === 'linux') {
    const line = renderCronLine(scriptPath);
    const existing = deps.runner('crontab', ['-l']);
    const prior =
      existing.status === 0 ? (existing.stdout ?? '').trimEnd() : '';
    if (prior.includes(HOME_COMMIT_CRON_MARKER)) {
      console.log('Auto-commit: cron entry already present');
      return;
    }
    const next = prior.length > 0 ? `${prior}\n${line}\n` : `${line}\n`;
    const apply = deps.runner('crontab', ['-'], { input: next });
    if (apply.status === 0) {
      console.log('Auto-commit: installed cron entry');
    } else {
      console.log('Auto-commit: crontab update failed');
    }
    return;
  }

  console.log(
    `Auto-commit: no scheduler support on ${deps.platform}; run ${scriptPath} from your own scheduler`,
  );
}

export async function readLatestCommitAt(
  home: string,
  deps: HomeGitDeps = defaultHomeGitDeps(),
): Promise<string | null> {
  if (!(await fileExists(resolve(home, '.git')))) return null;
  const r = deps.runner('git', ['-C', home, 'log', '-1', '--format=%aI']);
  if (r.status !== 0) return null;
  const at = (r.stdout ?? '').trim();
  return at.length > 0 ? at : null;
}

export function launchAgentPlistPath(deps: HomeGitDeps): string {
  return resolve(deps.launchAgentsDir, `${HOME_COMMIT_LAUNCH_LABEL}.plist`);
}
