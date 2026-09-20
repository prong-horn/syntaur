import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readConfig } from '../utils/config.js';
import { buildCheckContext, closeCheckContext } from '../utils/doctor/context.js';
import { gitChecks } from '../utils/doctor/checks/git.js';
import {
  HOME_COMMIT_CRON_MARKER,
  renderLaunchAgentPlist,
  type HomeGitDeps,
} from '../commands/home-git.js';
import type { CheckContext } from '../utils/doctor/types.js';

let home: string;
let syntaurDir: string;
const originalHome = process.env.HOME;
const originalSyntaurHome = process.env.SYNTAUR_HOME;

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    SYNTAUR_HOME: syntaurDir,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

function realGitRunner(): HomeGitDeps['runner'] {
  return (command, args, options) =>
    spawnSync(command, args, {
      encoding: 'utf-8',
      cwd: options?.cwd,
      input: options?.input,
      env: command === 'git' ? { ...gitEnv(), ...options?.env } : (options?.env ?? process.env),
    });
}

async function baseContext(deps: HomeGitDeps): Promise<CheckContext> {
  const config = await readConfig();
  return {
    config,
    syntaurRoot: syntaurDir,
    db: null,
    dbError: 'test',
    cwd: syntaurDir,
    now: new Date(),
    homeGitDeps: deps,
  };
}

async function initHomeLayout(): Promise<void> {
  await mkdir(join(syntaurDir, 'projects'), { recursive: true });
  await writeFile(
    join(syntaurDir, 'config.md'),
    `---\nversion: "1.0"\ndefaultProjectDir: ${join(syntaurDir, 'projects')}\n---\n`,
  );
}

function checkById(id: string) {
  return gitChecks.find((c) => c.id === id)!;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'syntaur-doctor-git-'));
  syntaurDir = join(home, '.syntaur');
  process.env.HOME = home;
  process.env.SYNTAUR_HOME = syntaurDir;
  await mkdir(syntaurDir, { recursive: true });
});

afterEach(async () => {
  process.env.HOME = originalHome;
  if (originalSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = originalSyntaurHome;
  await rm(home, { recursive: true, force: true });
});

describe('git.home-repo', () => {
  it('skips when git is missing', async () => {
    await initHomeLayout();
    const deps: HomeGitDeps = {
      platform: 'darwin',
      runner: () => ({ status: 1, stdout: '', stderr: '', pid: 0, output: [null, '', ''], signal: null }),
      launchAgentsDir: join(home, 'LaunchAgents'),
      uid: 501,
    };
    const ctx = await baseContext(deps);
    const result = await checkById('git.home-repo').run(ctx);
    expect(result).toMatchObject({ status: 'skipped' });
  });

  it('warns when the home is not a repository', async () => {
    await initHomeLayout();
    const deps: HomeGitDeps = {
      platform: 'darwin',
      runner: realGitRunner(),
      launchAgentsDir: join(home, 'LaunchAgents'),
      uid: 501,
    };
    const ctx = await baseContext(deps);
    const result = await checkById('git.home-repo').run(ctx);
    expect(result).toMatchObject({ status: 'warn' });
    expect((result as { remediation?: { command: string | null } }).remediation?.command).toBe(
      'syntaur init',
    );
  });

  it('passes when .git exists', async () => {
    await initHomeLayout();
    const deps: HomeGitDeps = {
      platform: 'darwin',
      runner: realGitRunner(),
      launchAgentsDir: join(home, 'LaunchAgents'),
      uid: 501,
    };
    spawnSync('git', ['-C', syntaurDir, 'init', '-q'], { env: gitEnv() });
    const ctx = await baseContext(deps);
    const result = await checkById('git.home-repo').run(ctx);
    expect(result).toMatchObject({ status: 'pass' });
  });
});

describe('git.auto-commit', () => {
  it('warns when there is no repository', async () => {
    await initHomeLayout();
    const deps: HomeGitDeps = {
      platform: 'darwin',
      runner: realGitRunner(),
      launchAgentsDir: join(home, 'LaunchAgents'),
      uid: 501,
    };
    const ctx = await baseContext(deps);
    const result = await checkById('git.auto-commit').run(ctx);
    expect(result).toMatchObject({ status: 'warn' });
  });

  it('passes when scheduler is installed (darwin plist)', async () => {
    await initHomeLayout();
    const agents = join(home, 'LaunchAgents');
    await mkdir(agents, { recursive: true });
    const script = join(syntaurDir, 'home-commit.sh');
    await writeFile(script, '#!/bin/sh\n', 'utf-8');
    await writeFile(
      join(agents, 'com.syntaur.home-commit.plist'),
      renderLaunchAgentPlist('com.syntaur.home-commit', script, join(syntaurDir, 'runtime', 'log')),
      'utf-8',
    );
    const deps: HomeGitDeps = {
      platform: 'darwin',
      runner: realGitRunner(),
      launchAgentsDir: agents,
      uid: 501,
    };
    spawnSync('git', ['-C', syntaurDir, 'init', '-q'], { env: gitEnv() });
    spawnSync('git', ['-C', syntaurDir, 'config', 'user.name', 'Syntaur'], { env: gitEnv() });
    spawnSync('git', ['-C', syntaurDir, 'config', 'user.email', 'syntaur@localhost'], {
      env: gitEnv(),
    });
    spawnSync('git', ['-C', syntaurDir, 'add', '-A'], { env: gitEnv() });
    spawnSync('git', ['-C', syntaurDir, 'commit', '-q', '-m', 'test'], { env: gitEnv() });
    const ctx = await baseContext(deps);
    const result = await checkById('git.auto-commit').run(ctx);
    expect(result).toMatchObject({ status: 'pass' });
    expect((result as { detail?: string }).detail).toMatch(/last commit/);
  });

  it('passes when cron carries the marker (linux)', async () => {
    await initHomeLayout();
    let crontab = `17 3 * * * /bin/sh ${join(syntaurDir, 'home-commit.sh')} # ${HOME_COMMIT_CRON_MARKER}\n`;
    const deps: HomeGitDeps = {
      platform: 'linux',
      runner: (command, args, options) => {
        if (command === 'crontab' && args[0] === '-l') {
          return { status: 0, stdout: crontab, stderr: '', pid: 0, output: [null, crontab, ''], signal: null };
        }
        return realGitRunner()(command, args, options);
      },
      launchAgentsDir: join(home, 'LaunchAgents'),
      uid: 501,
    };
    spawnSync('git', ['-C', syntaurDir, 'init', '-q'], { env: gitEnv() });
    spawnSync('git', ['-C', syntaurDir, 'config', 'user.name', 'Syntaur'], { env: gitEnv() });
    spawnSync('git', ['-C', syntaurDir, 'config', 'user.email', 'syntaur@localhost'], {
      env: gitEnv(),
    });
    spawnSync('git', ['-C', syntaurDir, 'add', '-A'], { env: gitEnv() });
    spawnSync('git', ['-C', syntaurDir, 'commit', '-q', '-m', 'test'], { env: gitEnv() });
    const ctx = await baseContext(deps);
    const result = await checkById('git.auto-commit').run(ctx);
    expect(result).toMatchObject({ status: 'pass' });
  });

  it('uses distinct remediation when the scheduler is missing but the repo exists', async () => {
    await initHomeLayout();
    const deps: HomeGitDeps = {
      platform: 'darwin',
      runner: realGitRunner(),
      launchAgentsDir: join(home, 'LaunchAgents'),
      uid: 501,
    };
    spawnSync('git', ['-C', syntaurDir, 'init', '-q'], { env: gitEnv() });
    spawnSync('git', ['-C', syntaurDir, 'config', 'user.name', 'Syntaur'], { env: gitEnv() });
    spawnSync('git', ['-C', syntaurDir, 'config', 'user.email', 'syntaur@localhost'], {
      env: gitEnv(),
    });
    spawnSync('git', ['-C', syntaurDir, 'add', '-A'], { env: gitEnv() });
    spawnSync('git', ['-C', syntaurDir, 'commit', '-q', '-m', 'test'], { env: gitEnv() });
    const ctx = await baseContext(deps);
    const noRepo = await checkById('git.auto-commit').run({
      ...ctx,
      syntaurRoot: join(home, 'empty-syntaur'),
    });
    const noScheduler = await checkById('git.auto-commit').run(ctx);
    const repoRemediation = (noRepo as { remediation?: { suggestion: string } }).remediation
      ?.suggestion;
    const schedRemediation = (noScheduler as { remediation?: { suggestion: string } }).remediation
      ?.suggestion;
    expect(repoRemediation).toContain('git repository');
    expect(schedRemediation).toContain('--no-auto-commit');
    expect(schedRemediation).not.toBe(repoRemediation);
  });

  it('warns when the newest commit is older than 48h', async () => {
    await initHomeLayout();
    const deps: HomeGitDeps = {
      platform: 'darwin',
      runner: realGitRunner(),
      launchAgentsDir: join(home, 'LaunchAgents'),
      uid: 501,
    };
    spawnSync('git', ['-C', syntaurDir, 'init', '-q'], { env: gitEnv() });
    spawnSync('git', ['-C', syntaurDir, 'config', 'user.name', 'Syntaur'], { env: gitEnv() });
    spawnSync('git', ['-C', syntaurDir, 'config', 'user.email', 'syntaur@localhost'], {
      env: gitEnv(),
    });
    spawnSync('git', ['-C', syntaurDir, 'add', '-A'], { env: gitEnv() });
    const old = '2020-01-01T00:00:00Z';
    spawnSync(
      'git',
      ['-C', syntaurDir, 'commit', '-q', '-m', 'old', '--date', old],
      { env: { ...gitEnv(), GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old } },
    );
    const ctx = await baseContext(deps);
    const result = await checkById('git.auto-commit').run(ctx);
    expect(result).toMatchObject({ status: 'warn' });
    expect((result as { detail?: string }).detail).toMatch(/48h/);
  });
});

describe('buildCheckContext git isolation', () => {
  it('defaults homeGitDeps under the syntaur root and never calls crontab or launchctl', async () => {
    await initHomeLayout();
    spawnSync('git', ['-C', syntaurDir, 'init', '-q'], { env: gitEnv() });
    spawnSync('git', ['-C', syntaurDir, 'config', 'user.name', 'Syntaur'], { env: gitEnv() });
    spawnSync('git', ['-C', syntaurDir, 'config', 'user.email', 'syntaur@localhost'], {
      env: gitEnv(),
    });
    spawnSync('git', ['-C', syntaurDir, 'add', '-A'], { env: gitEnv() });
    spawnSync('git', ['-C', syntaurDir, 'commit', '-q', '-m', 'test'], { env: gitEnv() });

    const ctx = await buildCheckContext(syntaurDir);
    expect(ctx.homeGitDeps?.launchAgentsDir).toBe(
      resolve(syntaurDir, 'runtime', 'launch-agents-unused'),
    );
    const calls: string[] = [];
    const prior = ctx.homeGitDeps!.runner;
    ctx.homeGitDeps!.runner = (command, args, options) => {
      calls.push(command);
      return prior(command, args, options);
    };
    await checkById('git.auto-commit').run(ctx);
    expect(calls).not.toContain('crontab');
    expect(calls).not.toContain('launchctl');
    closeCheckContext(ctx);
  });
});
