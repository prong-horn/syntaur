import { isAbsolute } from 'node:path';
import { access, constants as fsConstants } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { getAgents, type AgentConfig } from '../../config.js';
import type { Check, CheckResult } from '../types.js';

const CATEGORY = 'agents';

const agentsResolvable: Check = {
  id: 'agents.commands-resolvable',
  category: CATEGORY,
  title: 'All configured agent commands resolve',
  async run(ctx) {
    const agents = getAgents(ctx.config);
    if (agents.length === 0) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'warn',
        detail: 'No agents configured and no built-in defaults available',
        remediation: {
          kind: 'manual',
          suggestion: 'Run `syntaur agents add --id <id> --label <label> --command <path>`',
          command: null,
        },
        autoFixable: false,
      };
    }

    const results: CheckResult[] = [];
    for (const agent of agents) {
      results.push(await checkAgent(agent));
    }
    return results;
  },
};

async function checkAgent(agent: AgentConfig): Promise<CheckResult> {
  const base = {
    id: `agents.resolvable.${agent.id}`,
    category: CATEGORY,
    title: `Agent "${agent.id}" command resolves`,
  };
  if (agent.resolveFromShellAliases) {
    return {
      ...base,
      status: 'pass',
      detail: `shell-alias resolution enabled for "${agent.command}" — will run via $SHELL -i -c`,
      autoFixable: false,
    };
  }

  if (isAbsolute(agent.command)) {
    try {
      await access(agent.command, fsConstants.X_OK);
      return { ...base, status: 'pass', autoFixable: false };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const detail =
        code === 'ENOENT'
          ? `absolute path "${agent.command}" does not exist`
          : code === 'EACCES'
            ? `absolute path "${agent.command}" exists but is not executable (chmod +x?)`
            : `absolute path "${agent.command}" failed access check (${code ?? 'unknown'})`;
      return {
        ...base,
        status: 'warn',
        detail,
        remediation: {
          kind: 'manual',
          suggestion: `Update with \`syntaur agents set ${agent.id} --command <path>\` or fix the file permissions`,
          command: null,
        },
        autoFixable: false,
      };
    }
  }

  // Bare name — try `which`.
  const result = spawnSync('which', [agent.command], { encoding: 'utf-8' });
  if (result.status === 0 && result.stdout.trim().length > 0) {
    return {
      ...base,
      status: 'pass',
      detail: `resolved "${agent.command}" → ${result.stdout.trim()}`,
      autoFixable: false,
    };
  }

  return {
    ...base,
    status: 'warn',
    detail: `bare command "${agent.command}" not found on PATH`,
    remediation: {
      kind: 'manual',
      suggestion:
        `Install the binary, point at an absolute path with \`syntaur agents set ${agent.id} --command <abs-path>\`, ` +
        `or enable shell-alias resolution with \`syntaur agents set ${agent.id} --resolve-from-shell-aliases\``,
      command: null,
    },
    autoFixable: false,
  };
}

export const agentChecks: Check[] = [agentsResolvable];
