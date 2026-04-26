import { spawnSync } from 'node:child_process';
import { resolve, isAbsolute } from 'node:path';
import { readFile } from 'node:fs/promises';
import { select, confirm, input } from '@inquirer/prompts';
import {
  readConfig,
  getAgents,
  type AgentConfig,
} from '../utils/config.js';
import { expandHome, syntaurRoot } from '../utils/paths.js';
import { fileExists } from '../utils/fs.js';
import { isInteractiveTerminal } from '../utils/prompt.js';

export interface BrowseOptions {
  agent?: string;
  worktreePrompt?: boolean;
}

export async function browseCommand(options: BrowseOptions): Promise<void> {
  const config = await readConfig();
  const projectsDir = config.defaultProjectDir;
  const agents = getAgents(config);

  if (agents.length === 0) {
    console.error(
      'No agents configured. Add one with `syntaur agents add --id <id> --label <label> --command <path>`.',
    );
    process.exit(1);
  }

  const preSelectedAgent = options.agent
    ? agents.find((a) => a.id === options.agent)
    : undefined;
  if (options.agent && !preSelectedAgent) {
    console.error(
      `Unknown agent id "${options.agent}". Configured: ${agents.map((a) => a.id).join(', ')}`,
    );
    process.exit(1);
  }

  const { render } = await import('ink');
  const React = await import('react');
  const { App } = await import('../tui/App.js');
  const { launchAgent } = await import('../tui/launch.js');

  let unmount: (() => void) | null = null;

  const onLaunch = async (launchOpts: {
    projectsDir: string;
    projectSlug: string;
    assignmentSlug: string;
  }) => {
    if (unmount) {
      unmount();
      unmount = null;
    }

    const agent = preSelectedAgent ?? (await pickAgent(agents));
    const cwdOverride = await ensureWorktree({
      projectsDir: launchOpts.projectsDir,
      projectSlug: launchOpts.projectSlug,
      assignmentSlug: launchOpts.assignmentSlug,
      worktreePromptEnabled: options.worktreePrompt !== false,
      autoCreateWorktree: config.agentDefaults.autoCreateWorktree,
    });

    await launchAgent({
      ...launchOpts,
      agent,
      ...(cwdOverride ? { cwdOverride } : {}),
    });
  };

  const instance = render(
    React.createElement(App, { projectsDir, onLaunch }),
  );
  unmount = instance.unmount;

  await instance.waitUntilExit();
}

async function pickAgent(agents: AgentConfig[]): Promise<AgentConfig> {
  if (agents.length === 1) return agents[0];

  if (!isInteractiveTerminal()) {
    const fallback = agents.find((a) => a.default) ?? agents[0];
    console.warn(
      `syntaur: multiple agents configured but no TTY — using "${fallback.id}".`,
    );
    return fallback;
  }

  const defaultAgent = agents.find((a) => a.default) ?? agents[0];
  const id = (await select({
    message: 'Launch which agent?',
    choices: agents.map((a) => ({ name: a.label, value: a.id, description: a.command })),
    default: defaultAgent.id,
  })) as string;
  const picked = agents.find((a) => a.id === id);
  if (!picked) throw new Error(`Internal error: picker returned unknown agent id "${id}"`);
  return picked;
}

interface EnsureWorktreeOpts {
  projectsDir: string;
  projectSlug: string;
  assignmentSlug: string;
  worktreePromptEnabled: boolean;
  autoCreateWorktree: 'skip' | 'ask' | 'always';
}

/**
 * Precedence (first match wins):
 * 1. `--no-worktree-prompt` set → fall back, no prompt, no create.
 * 2. Worktree + branch already populated → return undefined (launcher uses them).
 * 3. `autoCreateWorktree === 'skip'` → fall back.
 * 4. `autoCreateWorktree === 'always'` → create with defaults (no prompt).
 * 5. Default / 'ask' → prompt.
 */
async function ensureWorktree(opts: EnsureWorktreeOpts): Promise<string | undefined> {
  const assignmentPath = resolve(
    opts.projectsDir,
    opts.projectSlug,
    'assignments',
    opts.assignmentSlug,
    'assignment.md',
  );
  if (!(await fileExists(assignmentPath))) {
    return undefined;
  }
  const content = await readFile(assignmentPath, 'utf-8');
  const { parseAssignmentFrontmatter } = await import('../lifecycle/frontmatter.js');
  const fm = parseAssignmentFrontmatter(content);
  const { workspace } = fm;

  if (workspace.worktreePath && workspace.branch) {
    return undefined; // launcher will use them
  }

  // (1) flag beats everything
  if (!opts.worktreePromptEnabled) {
    return undefined;
  }

  // (3) explicit skip
  if (opts.autoCreateWorktree === 'skip') {
    return undefined;
  }

  const defaults = computeWorktreeDefaults({
    projectSlug: opts.projectSlug,
    assignmentSlug: opts.assignmentSlug,
    existing: workspace,
  });
  if (!defaults.repository) {
    console.warn(
      `syntaur: cannot infer repository for ${opts.assignmentSlug} — skipping worktree prompt`,
    );
    return undefined;
  }

  // (4) always
  if (opts.autoCreateWorktree === 'always') {
    return await runCreate({
      assignmentPath,
      repository: defaults.repository!,
      branch: defaults.branch!,
      parentBranch: defaults.parentBranch!,
      worktreePath: defaults.worktreePath!,
    });
  }

  // (5) ask
  if (!isInteractiveTerminal()) {
    return undefined; // can't prompt without a TTY
  }

  const proceed = await confirm({
    message: `This assignment has no git worktree/branch configured. Create one?`,
    default: true,
  });
  if (!proceed) {
    return undefined;
  }

  const repository = await input({
    message: 'Repository path:',
    default: defaults.repository!,
  });
  const branch = await input({
    message: 'Branch name:',
    default: defaults.branch!,
  });
  const parentBranch = await input({
    message: 'Parent branch:',
    default: defaults.parentBranch!,
  });
  const worktreePath = await input({
    message: 'Worktree path:',
    default: defaults.worktreePath!,
  });

  return await runCreate({
    assignmentPath,
    repository,
    branch,
    parentBranch,
    worktreePath,
  });
}

interface WorktreeDefaults {
  repository: string;
  branch: string;
  parentBranch: string;
  worktreePath: string;
}

function computeWorktreeDefaults(opts: {
  projectSlug: string;
  assignmentSlug: string;
  existing: { repository: string | null; branch: string | null; parentBranch: string | null };
}): Partial<WorktreeDefaults> & { repository?: string } {
  const repository = opts.existing.repository ?? detectCurrentGitRoot();
  const branch = opts.projectSlug
    ? `syntaur/${opts.projectSlug}/${opts.assignmentSlug}`
    : `syntaur/${opts.assignmentSlug}`;
  const parentBranch = opts.existing.parentBranch ?? detectCurrentBranch() ?? 'main';
  const worktreeBase = resolve(
    syntaurRoot(),
    'worktrees',
    opts.projectSlug || 'standalone',
    opts.assignmentSlug,
  );
  return {
    ...(repository ? { repository } : {}),
    branch,
    parentBranch,
    worktreePath: worktreeBase,
  };
}

function detectCurrentGitRoot(): string | undefined {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf-8',
  });
  if (result.status !== 0) return undefined;
  const out = result.stdout.trim();
  return out.length > 0 ? out : undefined;
}

function detectCurrentBranch(): string | undefined {
  const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf-8',
  });
  if (result.status !== 0) return undefined;
  const out = result.stdout.trim();
  if (!out || out === 'HEAD') return undefined;
  return out;
}

async function runCreate(
  opts: { assignmentPath: string } & WorktreeDefaults,
): Promise<string> {
  const { createWorktreeAndRecord, GitWorktreeError } = await import('../utils/git-worktree.js');
  const expandedWorktree = expandHome(opts.worktreePath);
  const absWorktree = isAbsolute(expandedWorktree)
    ? expandedWorktree
    : resolve(expandedWorktree);
  try {
    await createWorktreeAndRecord({
      assignmentPath: opts.assignmentPath,
      repository: opts.repository,
      branch: opts.branch,
      worktreePath: absWorktree,
      parentBranch: opts.parentBranch,
    });
    console.log(`syntaur: created worktree at ${absWorktree} on branch ${opts.branch}`);
    return absWorktree;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof GitWorktreeError) {
      console.error(`syntaur: ${msg}`);
    } else {
      console.error(`syntaur: ${msg}`);
    }
    process.exit(1);
  }
}
