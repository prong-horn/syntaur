import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getAssignmentDetail } from '../dashboard/api.js';

export type AgentType = 'claude' | 'codex';

const AGENT_COMMANDS: Record<AgentType, string> = {
  claude: 'c',
  codex: 'cx',
};

export interface LaunchOptions {
  missionsDir: string;
  missionSlug: string;
  assignmentSlug: string;
  agent: AgentType;
}

export async function launchAgent(options: LaunchOptions): Promise<void> {
  const { missionsDir, missionSlug, assignmentSlug, agent } = options;
  const command = AGENT_COMMANDS[agent];

  const detail = await getAssignmentDetail(missionsDir, missionSlug, assignmentSlug);
  if (!detail) {
    console.error(`Assignment not found: ${missionSlug}/${assignmentSlug}`);
    process.exit(1);
  }

  const workspaceDir =
    detail.workspace.worktreePath ??
    (detail.workspace.repository?.startsWith('/') ? detail.workspace.repository : null) ??
    process.cwd();

  const missionDir = resolve(missionsDir, missionSlug);
  const assignmentDir = resolve(missionDir, 'assignments', assignmentSlug);

  const contextDir = resolve(workspaceDir, '.syntaur');
  await mkdir(contextDir, { recursive: true });

  const context = {
    missionSlug,
    assignmentSlug,
    missionDir,
    assignmentDir,
    workspaceRoot: workspaceDir,
    title: detail.title,
    branch: detail.workspace.branch ?? null,
    grabbedAt: new Date().toISOString(),
  };

  await writeFile(
    resolve(contextDir, 'context.json'),
    JSON.stringify(context, null, 2) + '\n',
  );

  return new Promise<void>((resolvePromise, reject) => {
    const initialPrompt =
      `Read the current Syntaur assignment at ${assignmentDir}/assignment.md and give me a brief summary: title, status, priority, objective, and acceptance criteria.`;

    const child = spawn(command, [initialPrompt], {
      cwd: workspaceDir,
      stdio: 'inherit',
    });

    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        console.error(`${agent} CLI not found. Is \`${command}\` installed and in your PATH?`);
      } else {
        console.error(`Failed to launch ${agent}:`, err.message);
      }
      process.exit(1);
    });

    child.on('exit', (code) => {
      process.exit(code ?? 0);
    });
  });
}
