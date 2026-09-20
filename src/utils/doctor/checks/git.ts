import { resolve } from 'node:path';
import { fileExists } from '../../fs.js';
import {
  HOME_COMMIT_CRON_MARKER,
  launchAgentPlistPath,
  readLatestCommitAt,
  type HomeGitDeps,
} from '../../../commands/home-git.js';
import type { Check, CheckContext, CheckResult } from '../types.js';

const CATEGORY = 'git';

function skip(
  check: { id: string; category: string; title: string },
  reason: string,
): CheckResult {
  return {
    id: check.id,
    category: check.category,
    title: check.title,
    status: 'skipped',
    detail: reason,
    autoFixable: false,
  };
}

function initRemediation(): CheckResult['remediation'] {
  return {
    kind: 'manual',
    suggestion: 'Run `syntaur init` to initialise a git repository in the Syntaur home',
    command: 'syntaur init',
  };
}

function resolveDeps(ctx: CheckContext): HomeGitDeps {
  if (!ctx.homeGitDeps) {
    throw new Error('CheckContext.homeGitDeps is required for git checks');
  }
  return ctx.homeGitDeps;
}

function schedulerRemediation(): CheckResult['remediation'] {
  return {
    kind: 'manual',
    suggestion:
      'Re-run `syntaur init` (without `--no-auto-commit`) to install the daily auto-commit, or run `~/.syntaur/home-commit.sh` from your own scheduler',
    command: 'syntaur init',
  };
}

function gitAvailable(deps: HomeGitDeps): boolean {
  return deps.runner('git', ['--version']).status === 0;
}

async function schedulerInstalled(deps: HomeGitDeps): Promise<boolean> {
  if (deps.platform === 'darwin') {
    return fileExists(launchAgentPlistPath(deps));
  }
  if (deps.platform === 'linux') {
    const r = deps.runner('crontab', ['-l']);
    const text = r.status === 0 ? (r.stdout ?? '') : '';
    return text.includes(HOME_COMMIT_CRON_MARKER);
  }
  return false;
}

function commitAgeWarn(
  check: { id: string; category: string; title: string },
  detail: string,
): CheckResult {
  return {
    id: check.id,
    category: check.category,
    title: check.title,
    status: 'warn',
    detail,
    remediation: initRemediation(),
    autoFixable: false,
  };
}

const homeRepoCheck: Check = {
  id: 'git.home-repo',
  category: CATEGORY,
  title: 'Syntaur home is a git repository',
  async run(ctx) {
    const deps = resolveDeps(ctx);
    if (!gitAvailable(deps)) {
      return skip(this, 'git executable not found');
    }
    const gitDir = resolve(ctx.syntaurRoot, '.git');
    if (await fileExists(gitDir)) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'pass',
        autoFixable: false,
      };
    }
    return {
      id: this.id,
      category: this.category,
      title: this.title,
      status: 'warn',
      detail: `${ctx.syntaurRoot} is not a git repository`,
      remediation: initRemediation(),
      autoFixable: false,
    };
  },
};

const autoCommitCheck: Check = {
  id: 'git.auto-commit',
  category: CATEGORY,
  title: 'Daily home auto-commit scheduler is installed',
  async run(ctx) {
    const deps = resolveDeps(ctx);

    if (!gitAvailable(deps)) {
      return skip(this, 'git executable not found');
    }

    const gitDir = resolve(ctx.syntaurRoot, '.git');
    if (!(await fileExists(gitDir))) {
      return commitAgeWarn(this, 'home is not a git repository');
    }

    const lastAt = await readLatestCommitAt(ctx.syntaurRoot, deps);
    const lastDetail = lastAt ? `last commit ${lastAt}` : 'no commits yet';

    const staleMs = 48 * 60 * 60 * 1000;
    if (!lastAt) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'warn',
        detail: lastDetail,
        remediation: initRemediation(),
        autoFixable: false,
      };
    }
    const age = Date.now() - Date.parse(lastAt);
    if (Number.isFinite(age) && age > staleMs) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'warn',
        detail: `${lastDetail} (older than 48h)`,
        remediation: initRemediation(),
        autoFixable: false,
      };
    }

    if (deps.platform === 'darwin' || deps.platform === 'linux') {
      if (await schedulerInstalled(deps)) {
        return {
          id: this.id,
          category: this.category,
          title: this.title,
          status: 'pass',
          detail: lastDetail,
          autoFixable: false,
        };
      }
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'warn',
        detail: `${lastDetail}; scheduler not installed`,
        remediation: schedulerRemediation(),
        autoFixable: false,
      };
    }

    return skip(this, `no scheduler support on ${deps.platform}`);
  },
};

export const gitChecks: Check[] = [homeRepoCheck, autoCommitCheck];
