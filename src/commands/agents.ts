import { Command } from 'commander';
import {
  readConfig,
  getAgents,
  writeAgentsConfig,
  updateAgentsConfig,
  validateAgentList,
  parseAgentCommand,
  BUILTIN_AGENTS,
  AgentConfigError,
  type AgentConfig,
  type PromptArgPosition,
} from '../utils/config.js';

export const agentsCommand = new Command('agents').description(
  'Manage configurable agents used by `syntaur browse` and future launch flows',
);

agentsCommand
  .command('list')
  .description('List configured agents (or built-in defaults if none are configured)')
  .action(async () => {
    try {
      const config = await readConfig();
      const agents = getAgents(config);
      const source = config.agents ? 'config' : 'built-in defaults';
      console.log(`Agents (${source}):`);
      for (const agent of agents) {
        const flags: string[] = [];
        if (agent.default) flags.push('default');
        if (agent.resolveFromShellAliases) flags.push('shell-alias');
        if (agent.promptArgPosition) flags.push(`prompt=${agent.promptArgPosition}`);
        const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
        const args = agent.args && agent.args.length > 0 ? ` ${agent.args.join(' ')}` : '';
        console.log(`  ${agent.id.padEnd(12)} ${agent.label.padEnd(20)} ${agent.command}${args}${flagStr}`);
      }
    } catch (error) {
      reportAndExit(error);
    }
  });

interface AddOptions {
  id: string;
  label: string;
  command: string;
  args?: string;
  promptArgPosition?: string;
  default?: boolean;
  resolveFromShellAliases?: boolean;
  dryRun?: boolean;
}

agentsCommand
  .command('add')
  .description('Add a new agent to ~/.syntaur/config.md')
  .requiredOption('--id <id>', 'Agent id (slug)')
  .requiredOption('--label <label>', 'Display label')
  .requiredOption('--command <command>', 'Absolute path or bare binary name')
  .option('--args <csv>', 'Comma-separated default args')
  .option('--prompt-arg-position <position>', 'first | last | none')
  .option('--default', 'Mark this agent as the default launch target')
  .option('--resolve-from-shell-aliases', 'Run via $SHELL -i -c (for shell aliases)')
  .option('--dry-run', 'Validate and print the proposed config without writing')
  .action(async (options: AddOptions) => {
    try {
      const agent: AgentConfig = buildAgentFromOptions(options, null);
      const mutation = {
        kind: 'add' as const,
        apply: (current: AgentConfig[]): AgentConfig[] => {
          if (current.some((a) => a.id === agent.id)) {
            throw new AgentConfigError(`agent "${agent.id}" already exists`);
          }
          const next = agent.default
            ? current.map((a) => ({ ...a, default: false }))
            : [...current];
          return [...next, agent];
        },
      };
      const result = await updateAgentsConfig(mutation, {
        dryRun: Boolean(options.dryRun),
      });
      reportMutation('add', result);
    } catch (error) {
      reportAndExit(error);
    }
  });

interface RemoveOptions {
  dryRun?: boolean;
}

agentsCommand
  .command('remove <id>')
  .description('Remove an agent from ~/.syntaur/config.md')
  .option('--dry-run', 'Validate and print the proposed config without writing')
  .action(async (id: string, options: RemoveOptions) => {
    try {
      const mutation = {
        kind: 'remove' as const,
        apply: (current: AgentConfig[]): AgentConfig[] => {
          if (!current.some((a) => a.id === id)) {
            throw new AgentConfigError(`unknown agent id "${id}"`);
          }
          return current.filter((a) => a.id !== id);
        },
      };
      const result = await updateAgentsConfig(mutation, {
        dryRun: Boolean(options.dryRun),
      });
      reportMutation('remove', result);
    } catch (error) {
      reportAndExit(error);
    }
  });

interface SetOptions {
  label?: string;
  command?: string;
  args?: string;
  promptArgPosition?: string;
  default?: boolean;
  resolveFromShellAliases?: boolean;
  dryRun?: boolean;
}

agentsCommand
  .command('set <id>')
  .description('Update one or more fields on an existing agent')
  .option('--label <label>', 'Display label')
  .option('--command <command>', 'Absolute path or bare binary name')
  .option('--args <csv>', 'Comma-separated default args')
  .option('--prompt-arg-position <position>', 'first | last | none')
  .option('--default', 'Mark this agent as the default (clears any prior default)')
  .option('--no-default', 'Unset the default flag on this agent')
  .option('--resolve-from-shell-aliases', 'Run via $SHELL -i -c (for shell aliases)')
  .option('--no-resolve-from-shell-aliases', 'Disable shell-alias resolution for this agent')
  .option('--dry-run', 'Validate and print the proposed config without writing')
  .action(async (id: string, options: SetOptions) => {
    try {
      const mutation = {
        kind: 'set' as const,
        apply: (current: AgentConfig[]): AgentConfig[] => {
          const existing = current.find((a) => a.id === id);
          if (!existing) {
            throw new AgentConfigError(`unknown agent id "${id}"`);
          }
          const merged: AgentConfig = mergeOptionsIntoAgent(existing, options);
          const defaultFlip = options.default === true;
          return current.map((a) => {
            if (a.id === id) return merged;
            if (defaultFlip) return { ...a, default: false };
            return a;
          });
        },
      };
      const result = await updateAgentsConfig(mutation, {
        dryRun: Boolean(options.dryRun),
      });
      reportMutation('set', result);
    } catch (error) {
      reportAndExit(error);
    }
  });

agentsCommand
  .command('reorder <ids>')
  .description('Reorder agents (comma-separated ids, must cover every configured agent exactly once)')
  .option('--dry-run', 'Validate and print the proposed config without writing')
  .action(async (ids: string, options: { dryRun?: boolean }) => {
    try {
      const newOrder = ids.split(',').map((s) => s.trim()).filter(Boolean);
      const mutation = {
        kind: 'reorder' as const,
        apply: (current: AgentConfig[]): AgentConfig[] => {
          const seen = new Set<string>();
          for (const id of newOrder) {
            if (seen.has(id)) {
              throw new AgentConfigError(`duplicate id "${id}" in reorder list`);
            }
            seen.add(id);
          }
          const currentIds = new Set(current.map((a) => a.id));
          const missing = current.filter((a) => !seen.has(a.id)).map((a) => a.id);
          const extra = newOrder.filter((id) => !currentIds.has(id));
          if (missing.length > 0 || extra.length > 0) {
            const parts: string[] = [];
            if (missing.length) parts.push(`missing: ${missing.join(', ')}`);
            if (extra.length) parts.push(`unknown: ${extra.join(', ')}`);
            throw new AgentConfigError(
              `reorder list does not match current agents (${parts.join('; ')})`,
            );
          }
          return newOrder.map((id) => current.find((a) => a.id === id)!);
        },
      };
      const result = await updateAgentsConfig(mutation, {
        dryRun: Boolean(options.dryRun),
      });
      reportMutation('reorder', result);
    } catch (error) {
      reportAndExit(error);
    }
  });

// ---------- helpers ----------

function buildAgentFromOptions(options: AddOptions, existing: AgentConfig | null): AgentConfig {
  const agent: AgentConfig = {
    id: options.id,
    label: options.label,
    command: parseAgentCommand(options.command, options.id),
  };
  const args = parseArgsCsv(options.args);
  if (args) agent.args = args;
  if (options.promptArgPosition) {
    agent.promptArgPosition = options.promptArgPosition as PromptArgPosition;
  }
  if (options.default) agent.default = true;
  if (options.resolveFromShellAliases) agent.resolveFromShellAliases = true;
  validateAgentList([...(existing ? [] : []), agent]); // field-level sanity
  return agent;
}

function mergeOptionsIntoAgent(existing: AgentConfig, options: SetOptions): AgentConfig {
  const merged: AgentConfig = { ...existing };
  if (options.label !== undefined) merged.label = options.label;
  if (options.command !== undefined) {
    merged.command = parseAgentCommand(options.command, existing.id);
  }
  if (options.args !== undefined) {
    const parsed = parseArgsCsv(options.args);
    if (parsed) merged.args = parsed;
    else delete merged.args;
  }
  if (options.promptArgPosition !== undefined) {
    merged.promptArgPosition = options.promptArgPosition as PromptArgPosition;
  }
  if (options.default === true) merged.default = true;
  if (options.default === false) delete merged.default;
  if (options.resolveFromShellAliases === true) merged.resolveFromShellAliases = true;
  if (options.resolveFromShellAliases === false) delete merged.resolveFromShellAliases;
  return merged;
}

function parseArgsCsv(csv: string | undefined): string[] | null {
  if (csv === undefined) return null;
  const parts = csv.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return parts.length > 0 ? parts : null;
}

function reportMutation(
  action: 'add' | 'remove' | 'set' | 'reorder',
  result: { previous: AgentConfig[]; next: AgentConfig[]; written: boolean },
) {
  const diff = renderDiff(result.previous, result.next);
  if (result.written) {
    console.log(`Agents updated (${action}):`);
    console.log(diff);
  } else {
    console.log(`Dry run (${action}) — no changes written:`);
    console.log(diff);
  }
}

function renderDiff(prev: AgentConfig[], next: AgentConfig[]): string {
  const prevLines = prev.map(formatAgentLine);
  const nextLines = next.map(formatAgentLine);
  const prevSet = new Set(prevLines);
  const nextSet = new Set(nextLines);
  const out: string[] = [];
  for (const line of prevLines) {
    if (!nextSet.has(line)) out.push(`  - ${line}`);
  }
  for (const line of nextLines) {
    if (!prevSet.has(line)) out.push(`  + ${line}`);
  }
  if (out.length === 0) out.push('  (no changes)');
  return out.join('\n');
}

function formatAgentLine(a: AgentConfig): string {
  const flags: string[] = [];
  if (a.default) flags.push('default');
  if (a.resolveFromShellAliases) flags.push('shell-alias');
  if (a.promptArgPosition) flags.push(`prompt=${a.promptArgPosition}`);
  if (a.args && a.args.length > 0) flags.push(`args=[${a.args.join(', ')}]`);
  const suffix = flags.length > 0 ? ` (${flags.join(', ')})` : '';
  return `${a.id}: ${a.label} → ${a.command}${suffix}`;
}

function reportAndExit(error: unknown): never {
  console.error('Error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
}

// Re-export builtin list so callers can inspect it without circular imports.
export { BUILTIN_AGENTS, writeAgentsConfig };
