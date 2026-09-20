import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ensureHomeRepo,
  HOME_GITIGNORE_CONTENT,
  installAutoCommit,
  renderCronLine,
  renderHomeCommitScript,
  renderLaunchAgentPlist,
  type HomeGitDeps,
  type HomeGitRunner,
} from '../commands/home-git.js';
import { initCommand } from '../commands/init.js';

let home: string;
const originalHome = process.env.HOME;
const originalSyntaurHome = process.env.SYNTAUR_HOME;

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    SYNTAUR_HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

function makeRunner(record: { calls: Array<{ command: string; args: string[] }> }): HomeGitRunner {
  return (command, args, options) => {
    record.calls.push({ command, args });
    if (command === 'git') {
      return spawnSync(command, args, {
        encoding: 'utf-8',
        cwd: options?.cwd,
        input: options?.input,
        env: { ...gitEnv(), ...options?.env },
      });
    }
    return spawnSync(command, args, {
      encoding: 'utf-8',
      cwd: options?.cwd,
      input: options?.input,
      env: options?.env ?? process.env,
    });
  };
}

function realGitRunner(): HomeGitRunner {
  return (command, args, options) =>
    spawnSync(command, args, {
      encoding: 'utf-8',
      cwd: options?.cwd,
      input: options?.input,
      env: command === 'git' ? { ...gitEnv(), ...options?.env } : (options?.env ?? process.env),
    });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'syntaur-home-git-'));
  process.env.HOME = home;
  process.env.SYNTAUR_HOME = home;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  if (originalSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = originalSyntaurHome;
  await rm(home, { recursive: true, force: true });
});

describe('home-git render helpers', () => {
  it('renderHomeCommitScript passes bash -n', async () => {
    const scriptPath = join(home, 'check-script.sh');
    await writeFile(scriptPath, renderHomeCommitScript('/tmp/syntaur-home'), 'utf-8');
    const r = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
  });

  it('renderLaunchAgentPlist matches the expected shape', () => {
    const xml = renderLaunchAgentPlist(
      'com.syntaur.home-commit',
      '/home/.syntaur/home-commit.sh',
      '/home/.syntaur/runtime/home-commit.log',
    );
    expect(xml).toContain('<key>Hour</key>');
    expect(xml).toContain('<integer>3</integer>');
    expect(xml).toContain('<integer>17</integer>');
    expect(xml).toContain('/bin/sh');
    expect(xml).toContain('/home/.syntaur/home-commit.sh');
  });

  it('renderCronLine includes the marker comment', () => {
    expect(renderCronLine('/x/home-commit.sh')).toBe(
      '17 3 * * * /bin/sh /x/home-commit.sh # syntaur-home-commit',
    );
  });
});

describe('ensureHomeRepo', () => {
  it('initialises a repo with gitignore, identity, and an initial commit', async () => {
    await mkdir(join(home, 'projects'), { recursive: true });
    await writeFile(join(home, 'projects', '.keep'), '\n', 'utf-8');
    await writeFile(join(home, 'syntaur.db'), 'db', 'utf-8');
    const deps: HomeGitDeps = {
      platform: 'darwin',
      runner: realGitRunner(),
      launchAgentsDir: join(home, 'LaunchAgents'),
      uid: 501,
    };
    await ensureHomeRepo(home, deps);

    const gitignore = await readFile(join(home, '.gitignore'), 'utf-8');
    expect(gitignore).toBe(HOME_GITIGNORE_CONTENT);

    const name = spawnSync('git', ['-C', home, 'config', 'user.name'], {
      encoding: 'utf-8',
      env: gitEnv(),
    }).stdout?.trim();
    expect(name).toBe('Syntaur');

    const tracked = spawnSync('git', ['-C', home, 'ls-files'], {
      encoding: 'utf-8',
      env: gitEnv(),
    }).stdout ?? '';
    expect(tracked).toContain('projects/');
    expect(tracked).not.toContain('syntaur.db');
  });

  it('is a no-op when .git already exists', async () => {
    const deps: HomeGitDeps = {
      platform: 'darwin',
      runner: realGitRunner(),
      launchAgentsDir: join(home, 'LaunchAgents'),
      uid: 501,
    };
    await ensureHomeRepo(home, deps);
    const before = await readFile(join(home, '.gitignore'), 'utf-8');
    await ensureHomeRepo(home, deps);
    const after = await readFile(join(home, '.gitignore'), 'utf-8');
    expect(after).toBe(before);
  });

  it('does not overwrite an existing .gitignore', async () => {
    await writeFile(join(home, '.gitignore'), 'custom\n', 'utf-8');
    const deps: HomeGitDeps = {
      platform: 'darwin',
      runner: realGitRunner(),
      launchAgentsDir: join(home, 'LaunchAgents'),
      uid: 501,
    };
    await ensureHomeRepo(home, deps);
    expect(await readFile(join(home, '.gitignore'), 'utf-8')).toBe('custom\n');
  });

  it('prints a warning when git is missing', async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    try {
      const deps: HomeGitDeps = {
        platform: 'darwin',
        runner: () => ({ status: 1, stdout: '', stderr: '', pid: 0, output: [null, '', ''], signal: null }),
        launchAgentsDir: join(home, 'LaunchAgents'),
        uid: 501,
      };
      await ensureHomeRepo(home, deps);
    } finally {
      console.log = orig;
    }
    expect(logs.some((l) => l.includes('Git: not found'))).toBe(true);
  });
});

describe('installAutoCommit', () => {
  it('writes home-commit.sh mode 0755', async () => {
    const record = { calls: [] as Array<{ command: string; args: string[] }> };
    const deps: HomeGitDeps = {
      platform: 'win32',
      runner: makeRunner(record),
      launchAgentsDir: join(home, 'LaunchAgents'),
      uid: 501,
    };
    await installAutoCommit(home, deps, { scheduler: false });
    const st = await stat(join(home, 'home-commit.sh'));
    expect(st.mode & 0o777).toBe(0o755);
    const script = await readFile(join(home, 'home-commit.sh'), 'utf-8');
    const checkPath = join(home, 'written-commit.sh');
    await writeFile(checkPath, script, 'utf-8');
    expect(spawnSync('bash', ['-n', checkPath], { encoding: 'utf-8' }).status).toBe(0);
  });

  it('installs launchd on darwin', async () => {
    const record = { calls: [] as Array<{ command: string; args: string[] }> };
    const agents = join(home, 'LaunchAgents');
    const deps: HomeGitDeps = {
      platform: 'darwin',
      runner: (command, args, options) => {
        record.calls.push({ command, args });
        if (command === 'launchctl') return { status: 0, stdout: '', stderr: '', pid: 0, output: [null, '', ''], signal: null };
        return makeRunner(record)(command, args, options);
      },
      launchAgentsDir: agents,
      uid: 42,
    };
    await installAutoCommit(home, deps);
    const plist = await readFile(join(agents, 'com.syntaur.home-commit.plist'), 'utf-8');
    expect(plist).toContain('com.syntaur.home-commit');
    expect(record.calls.filter((c) => c.command === 'launchctl').map((c) => c.args)).toEqual([
      ['bootout', 'gui/42/com.syntaur.home-commit'],
      ['bootstrap', 'gui/42', join(agents, 'com.syntaur.home-commit.plist')],
    ]);
  });

  it('appends cron once on linux', async () => {
    let crontab = '';
    const deps: HomeGitDeps = {
      platform: 'linux',
      runner: (command, args, options) => {
        if (command === 'crontab' && args[0] === '-l') {
          if (!crontab) {
            return { status: 1, stdout: '', stderr: '', pid: 0, output: [null, '', ''], signal: null };
          }
          return { status: 0, stdout: crontab, stderr: '', pid: 0, output: [null, crontab, ''], signal: null };
        }
        if (command === 'crontab' && args[0] === '-') {
          crontab = options?.input ?? '';
          return { status: 0, stdout: '', stderr: '', pid: 0, output: [null, '', ''], signal: null };
        }
        return makeRunner({ calls: [] })(command, args, options);
      },
      launchAgentsDir: join(home, 'LaunchAgents'),
      uid: 501,
    };
    await installAutoCommit(home, deps);
    await installAutoCommit(home, deps);
    expect(crontab.split('syntaur-home-commit').length - 1).toBe(1);
    expect(crontab).toContain('home-commit.sh');
  });

  it('prints skip line on unsupported platforms', async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    try {
      const deps: HomeGitDeps = {
        platform: 'win32',
        runner: makeRunner({ calls: [] }),
        launchAgentsDir: join(home, 'LaunchAgents'),
        uid: 501,
      };
      await installAutoCommit(home, deps);
    } finally {
      console.log = orig;
    }
    expect(logs.some((l) => l.includes('no scheduler support'))).toBe(true);
  });
});

describe('init --no-auto-commit', () => {
  it('writes the script without calling launchctl', async () => {
    const record = { calls: [] as Array<{ command: string; args: string[] }> };
    const origRunner = realGitRunner();
    const deps: HomeGitDeps = {
      platform: 'darwin',
      runner: (command, args, options) => {
        record.calls.push({ command, args });
        if (command === 'launchctl') {
          return { status: 0, stdout: '', stderr: '', pid: 0, output: [null, '', ''], signal: null };
        }
        return origRunner(command, args, options);
      },
      launchAgentsDir: join(home, 'LaunchAgents'),
      uid: 501,
    };
    await initCommand({ autoCommit: false }, deps);
    expect(await readFile(join(home, 'home-commit.sh'), 'utf-8')).toContain('syntaur auto-commit');
    expect(record.calls.some((c) => c.command === 'launchctl')).toBe(false);
  });
});
