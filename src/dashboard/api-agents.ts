import { Router } from 'express';
import {
  readConfig,
  writeAgentsConfig,
  deleteAgentsConfig,
  AgentConfigError,
} from '../utils/config.js';
import {
  BUILTIN_AGENTS,
  PROMPT_ARG_POSITIONS,
  type AgentConfig,
  type PromptArgPosition,
  type RunnerKind,
  type AgentSourceKind,
} from '../utils/agents-schema.js';
import { access } from 'node:fs/promises';
import { discoverClaudeAgents } from '../targets/agent-definitions.js';
import { discoverAgents } from '../targets/agent-discovery.js';
import {
  authorAgentDef,
  buildRegisteredAgent,
  inferManualAdd,
  requireAbsolutePath,
} from '../targets/agent-authoring.js';

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const RUNNER_KINDS_SET = new Set<string>(['claude', 'pi', 'codex']);
const SOURCE_KINDS_SET = new Set<string>(['claude-global', 'claude-project', 'directory']);

export interface AgentFieldError {
  id?: string;
  index?: number;
  field: string;
  message: string;
}

export function mapAgentErrorToFieldErrors(
  err: AgentConfigError,
): { error: string; fieldErrors?: AgentFieldError[] } {
  const message = err.message;

  let match = message.match(/^agent id "([^"]*)" is invalid/);
  if (match) {
    return {
      error: message,
      fieldErrors: [
        { id: match[1], field: 'id', message: 'must match /^[a-z0-9][a-z0-9_-]*$/' },
      ],
    };
  }

  match = message.match(/^duplicate agent id "([^"]+)"/);
  if (match) {
    return {
      error: message,
      fieldErrors: [{ id: match[1], field: 'id', message: 'duplicate id' }],
    };
  }

  match = message.match(/^agent "([^"]+)" has empty label/);
  if (match) {
    return {
      error: message,
      fieldErrors: [{ id: match[1], field: 'label', message: 'label is required' }],
    };
  }

  match = message.match(/^agent(?: "([^"]+)")? has empty command/);
  if (match) {
    return {
      error: message,
      fieldErrors: [{ id: match[1], field: 'command', message: 'command is required' }],
    };
  }

  match = message.match(/^agent(?: "([^"]+)")? command "[^"]*" is a relative path/);
  if (match) {
    return {
      error: message,
      fieldErrors: [
        { id: match[1], field: 'command', message: 'use absolute path or bare name' },
      ],
    };
  }

  match = message.match(/^agent "([^"]+)" has invalid promptArgPosition/);
  if (match) {
    return {
      error: message,
      fieldErrors: [
        {
          id: match[1],
          field: 'promptArgPosition',
          message: 'must be first|last|none',
        },
      ],
    };
  }

  if (/^more than one agent is marked default/.test(message)) {
    return {
      error: message,
      fieldErrors: [{ field: 'default', message: 'only one agent may be default' }],
    };
  }

  match = message.match(/^agent "([^"]+)" has invalid playbook/);
  if (match) {
    return {
      error: message,
      fieldErrors: [
        { id: match[1], field: 'playbook', message: 'must be a valid playbook slug' },
      ],
    };
  }

  match = message.match(/^agent "([^"]+)" has invalid model/);
  if (match) {
    return {
      error: message,
      fieldErrors: [
        { id: match[1], field: 'model', message: 'must be a single line' },
      ],
    };
  }

  match = message.match(/^agent "([^"]+)" has invalid launchPrompt/);
  if (match) {
    return {
      error: message,
      fieldErrors: [
        { id: match[1], field: 'launchPrompt', message: 'must be a single line' },
      ],
    };
  }

  match = message.match(/^agent "([^"]+)" has invalid agentName/);
  if (match) {
    return {
      error: message,
      fieldErrors: [{ id: match[1], field: 'agentName', message: 'must be a single line' }],
    };
  }

  match = message.match(/^agent "([^"]+)" has invalid workdir/);
  if (match) {
    return {
      error: message,
      fieldErrors: [{ id: match[1], field: 'workdir', message: 'must be a single line' }],
    };
  }

  match = message.match(/^agent "([^"]+)" sets both agentName and workdir/);
  if (match) {
    return {
      error: message,
      fieldErrors: [
        { id: match[1], field: 'workdir', message: 'agentName and workdir are mutually exclusive' },
      ],
    };
  }

  match = message.match(/^agent "([^"]+)" sets both agentName and model/);
  if (match) {
    return {
      error: message,
      fieldErrors: [
        { id: match[1], field: 'model', message: 'remove the profile model; the agent defines its own' },
      ],
    };
  }

  return { error: message };
}

function coerceAgentRow(
  raw: unknown,
  index: number,
): { ok: true; value: AgentConfig } | { ok: false; status: number; body: { error: string; fieldErrors?: AgentFieldError[] } } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `agents[${index}] must be an object`,
        fieldErrors: [{ index, field: 'row', message: `agents[${index}] must be an object` }],
      },
    };
  }
  const entry = raw as Record<string, unknown>;

  if (typeof entry.id !== 'string' || entry.id.length === 0) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `agents[${index}].id must be a non-empty string`,
        fieldErrors: [{ index, field: 'id', message: 'id must be a non-empty string' }],
      },
    };
  }
  const id = entry.id;

  if (typeof entry.label !== 'string') {
    return {
      ok: false,
      status: 400,
      body: {
        error: `agents[${index}].label must be a string`,
        fieldErrors: [{ id, field: 'label', message: 'label must be a string' }],
      },
    };
  }

  if (typeof entry.command !== 'string') {
    return {
      ok: false,
      status: 400,
      body: {
        error: `agents[${index}].command must be a string`,
        fieldErrors: [{ id, field: 'command', message: 'command must be a string' }],
      },
    };
  }

  const cleaned: AgentConfig = {
    id,
    label: entry.label,
    command: entry.command,
  };

  if (entry.args !== undefined) {
    if (!Array.isArray(entry.args) || entry.args.some((v) => typeof v !== 'string')) {
      return {
        ok: false,
        status: 400,
        body: {
          error: `agents[${index}].args must be an array of strings`,
          fieldErrors: [{ id, field: 'args', message: 'args must be an array of strings' }],
        },
      };
    }
    cleaned.args = entry.args as string[];
  }

  if (entry.promptArgPosition !== undefined) {
    if (
      typeof entry.promptArgPosition !== 'string' ||
      !PROMPT_ARG_POSITIONS.includes(entry.promptArgPosition as PromptArgPosition)
    ) {
      return {
        ok: false,
        status: 400,
        body: {
          error: `agents[${index}].promptArgPosition must be first|last|none`,
          fieldErrors: [
            { id, field: 'promptArgPosition', message: 'must be first|last|none' },
          ],
        },
      };
    }
    cleaned.promptArgPosition = entry.promptArgPosition as PromptArgPosition;
  }

  if (entry.resolveFromShellAliases !== undefined) {
    if (typeof entry.resolveFromShellAliases !== 'boolean') {
      return {
        ok: false,
        status: 400,
        body: {
          error: `agents[${index}].resolveFromShellAliases must be a boolean`,
          fieldErrors: [
            { id, field: 'resolveFromShellAliases', message: 'must be a boolean' },
          ],
        },
      };
    }
    cleaned.resolveFromShellAliases = entry.resolveFromShellAliases;
  }

  if (entry.default !== undefined) {
    if (typeof entry.default !== 'boolean') {
      return {
        ok: false,
        status: 400,
        body: {
          error: `agents[${index}].default must be a boolean`,
          fieldErrors: [{ id, field: 'default', message: 'must be a boolean' }],
        },
      };
    }
    cleaned.default = entry.default;
  }

  if (entry.model !== undefined) {
    if (typeof entry.model !== 'string') {
      return {
        ok: false,
        status: 400,
        body: {
          error: `agents[${index}].model must be a string`,
          fieldErrors: [{ id, field: 'model', message: 'model must be a string' }],
        },
      };
    }
    const model = entry.model.trim();
    if (model) cleaned.model = model;
  }

  if (entry.playbook !== undefined) {
    if (typeof entry.playbook !== 'string') {
      return {
        ok: false,
        status: 400,
        body: {
          error: `agents[${index}].playbook must be a string`,
          fieldErrors: [{ id, field: 'playbook', message: 'playbook must be a string' }],
        },
      };
    }
    const playbook = entry.playbook.trim();
    if (playbook) cleaned.playbook = playbook;
  }

  if (entry.launchPrompt !== undefined) {
    if (typeof entry.launchPrompt !== 'string') {
      return {
        ok: false,
        status: 400,
        body: {
          error: `agents[${index}].launchPrompt must be a string`,
          fieldErrors: [{ id, field: 'launchPrompt', message: 'launchPrompt must be a string' }],
        },
      };
    }
    // Store untrimmed (preserve author spacing); drop when empty-after-trim.
    if (entry.launchPrompt.trim()) cleaned.launchPrompt = entry.launchPrompt;
  }

  if (entry.agentName !== undefined) {
    if (typeof entry.agentName !== 'string') {
      return {
        ok: false,
        status: 400,
        body: {
          error: `agents[${index}].agentName must be a string`,
          fieldErrors: [{ id, field: 'agentName', message: 'agentName must be a string' }],
        },
      };
    }
    const agentName = entry.agentName.trim();
    if (agentName) cleaned.agentName = agentName;
  }

  if (entry.workdir !== undefined) {
    if (typeof entry.workdir !== 'string') {
      return {
        ok: false,
        status: 400,
        body: {
          error: `agents[${index}].workdir must be a string`,
          fieldErrors: [{ id, field: 'workdir', message: 'workdir must be a string' }],
        },
      };
    }
    const workdir = entry.workdir.trim();
    if (workdir) cleaned.workdir = workdir;
  }

  // runner + source pointer (flat scalars). Type-check here; the enum + identity
  // consistency is enforced by validateAgentList in writeAgentsConfig.
  for (const field of ['runner', 'sourceKind', 'sourcePath', 'sourceRepo'] as const) {
    const raw = entry[field];
    if (raw === undefined) continue;
    if (typeof raw !== 'string') {
      return {
        ok: false,
        status: 400,
        body: {
          error: `agents[${index}].${field} must be a string`,
          fieldErrors: [{ id, field, message: `${field} must be a string` }],
        },
      };
    }
    const v = raw.trim();
    if (v) (cleaned as unknown as Record<string, unknown>)[field] = v;
  }

  return { ok: true, value: cleaned };
}

export function createAgentsRouter(): Router {
  const router = Router();

  // Claude agent definitions discovered on disk (`~/.claude/agents/**/*.md`),
  // for the dashboard's "Run as agent" picker. Read-only; never throws (a
  // missing agents dir returns []).
  router.get('/claude-discovered', async (_req, res) => {
    try {
      const agents = await discoverClaudeAgents();
      res.json({ agents });
    } catch (err) {
      console.error('Error discovering Claude agents:', err);
      res.status(500).json({ error: 'Failed to discover Claude agents' });
    }
  });

  // Multi-source discovery for the register tray. Global config router (no
  // implicit workspace), so the current repo is passed as `?repo=<abs>` for the
  // claude-project + per-dir `.claude/agents` scans.
  router.get('/discovered', async (req, res) => {
    try {
      const config = await readConfig();
      const agents = config.agents ?? BUILTIN_AGENTS;
      const repo = typeof req.query.repo === 'string' && req.query.repo ? req.query.repo : null;
      const d = config.agentDiscovery;
      const candidates = await discoverAgents({
        claudeGlobal: d.claudeGlobal,
        claudeProject: d.claudeProject,
        directory: d.directory,
        roots: d.roots,
        repo,
        agents,
      });
      res.json({ candidates });
    } catch (err) {
      console.error('Error discovering agents:', err);
      res.status(500).json({ error: 'Failed to discover agents' });
    }
  });

  // Append a freshly-built agent and persist. Returns null after responding on
  // duplicate/validation error so the caller just returns.
  async function appendAndPersist(
    agent: AgentConfig,
    res: Parameters<Parameters<typeof router.post>[1]>[1],
  ): Promise<AgentConfig[] | null> {
    const config = await readConfig();
    const base = config.agents ?? BUILTIN_AGENTS;
    if (agent.sourcePath && base.some((a) => a.sourcePath === agent.sourcePath)) {
      res.status(409).json({ error: `already registered: ${agent.sourcePath}` });
      return null;
    }
    const next = [...base, agent];
    try {
      await writeAgentsConfig(next);
    } catch (err) {
      if (err instanceof AgentConfigError) {
        res.status(400).json(mapAgentErrorToFieldErrors(err));
        return null;
      }
      throw err;
    }
    return next;
  }

  // Register a confirmed discovered candidate into the flat list.
  router.post('/register', async (req, res) => {
    try {
      const b = (req.body ?? {}) as {
        path?: string;
        name?: string;
        runner?: string;
        sourceKind?: string;
        sourceRepo?: string;
        description?: string;
      };
      if (!b.path || !b.name || !b.runner || !b.sourceKind) {
        res.status(400).json({ error: 'register requires path, name, runner, sourceKind' });
        return;
      }
      if (!RUNNER_KINDS_SET.has(b.runner) || !SOURCE_KINDS_SET.has(b.sourceKind)) {
        res.status(400).json({ error: 'invalid runner or sourceKind' });
        return;
      }
      let regPath: string;
      let sourceRepo: string | undefined;
      try {
        regPath = requireAbsolutePath(b.path);
        sourceRepo = b.sourceRepo ? requireAbsolutePath(b.sourceRepo, 'sourceRepo') : undefined;
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'invalid path' });
        return;
      }
      if (!(await pathExists(regPath))) {
        res.status(400).json({ error: `path not found: ${regPath}` });
        return;
      }
      const config = await readConfig();
      const base = config.agents ?? BUILTIN_AGENTS;
      const agent = buildRegisteredAgent({
        name: b.name,
        runner: b.runner as RunnerKind,
        sourceKind: b.sourceKind as AgentSourceKind,
        sourcePath: regPath,
        sourceRepo,
        description: b.description,
        existingIds: base.map((a) => a.id),
      });
      const next = await appendAndPersist(agent, res);
      if (!next) return;
      res.json({ agent, agents: next, custom: true });
    } catch (err) {
      console.error('Error registering agent:', err);
      res.status(500).json({ error: 'Failed to register agent' });
    }
  });

  // Manual add: adopt an existing def by pointing at a file or folder.
  router.post('/manual-add', async (req, res) => {
    try {
      const p = (req.body ?? {}).path;
      if (typeof p !== 'string' || !p) {
        res.status(400).json({ error: 'manual-add requires a path' });
        return;
      }
      let inferred;
      try {
        inferred = await inferManualAdd(p);
      } catch {
        res.status(400).json({ error: `path not found or unreadable: ${p}` });
        return;
      }
      const config = await readConfig();
      const base = config.agents ?? BUILTIN_AGENTS;
      const agent = buildRegisteredAgent({
        name: inferred.name,
        runner: inferred.runner,
        sourceKind: inferred.sourceKind,
        sourcePath: inferred.sourcePath,
        description: inferred.description,
        existingIds: base.map((a) => a.id),
      });
      const next = await appendAndPersist(agent, res);
      if (!next) return;
      res.json({ agent, agents: next, custom: true });
    } catch (err) {
      console.error('Error manual-adding agent:', err);
      res.status(500).json({ error: 'Failed to manual-add agent' });
    }
  });

  // Create-new: author a runner-native def on disk, then auto-register it.
  router.post('/create', async (req, res) => {
    try {
      const b = (req.body ?? {}) as {
        name?: string;
        runner?: string;
        model?: string;
        description?: string;
        instructions?: string;
        location?: string;
      };
      if (!b.name || !b.runner || typeof b.instructions !== 'string') {
        res.status(400).json({ error: 'create requires name, runner, instructions' });
        return;
      }
      if (!RUNNER_KINDS_SET.has(b.runner)) {
        res.status(400).json({ error: 'invalid runner' });
        return;
      }
      let authored;
      try {
        authored = await authorAgentDef({
          name: b.name,
          runner: b.runner as RunnerKind,
          model: b.model,
          description: b.description,
          instructions: b.instructions,
          location: b.location,
        });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'failed to author def' });
        return;
      }
      const config = await readConfig();
      const base = config.agents ?? BUILTIN_AGENTS;
      const agent = buildRegisteredAgent({
        name: b.name,
        runner: b.runner as RunnerKind,
        sourceKind: authored.sourceKind,
        sourcePath: authored.path,
        sourceRepo: authored.sourceRepo,
        description: b.description,
        existingIds: base.map((a) => a.id),
      });
      const next = await appendAndPersist(agent, res);
      if (!next) return;
      res.json({ agent, path: authored.path, agents: next, custom: true });
    } catch (err) {
      console.error('Error creating agent:', err);
      res.status(500).json({ error: 'Failed to create agent' });
    }
  });

  router.get('/', async (_req, res) => {
    try {
      const config = await readConfig();
      const agents = config.agents ?? BUILTIN_AGENTS;
      res.json({ agents, custom: config.agents !== null });
    } catch (err) {
      console.error('Error getting agents config:', err);
      res.status(500).json({ error: 'Failed to get agents config' });
    }
  });

  router.put('/', async (req, res) => {
    try {
      const raw = (req.body && typeof req.body === 'object' ? req.body : {}) as {
        agents?: unknown;
      };
      if (!Array.isArray(raw.agents)) {
        res.status(400).json({ error: 'agents must be an array' });
        return;
      }

      const cleaned: AgentConfig[] = [];
      for (let i = 0; i < raw.agents.length; i++) {
        const result = coerceAgentRow(raw.agents[i], i);
        if (!result.ok) {
          res.status(result.status).json(result.body);
          return;
        }
        cleaned.push(result.value);
      }

      try {
        await writeAgentsConfig(cleaned);
      } catch (err) {
        if (err instanceof AgentConfigError) {
          res.status(400).json(mapAgentErrorToFieldErrors(err));
          return;
        }
        console.error('Error saving agents config:', err);
        res.status(500).json({ error: 'Failed to save agents config' });
        return;
      }

      res.json({ agents: cleaned, custom: true });
    } catch (err) {
      console.error('Error saving agents config:', err);
      res.status(500).json({ error: 'Failed to save agents config' });
    }
  });

  router.delete('/', async (_req, res) => {
    try {
      await deleteAgentsConfig();
      res.json({ agents: BUILTIN_AGENTS, custom: false });
    } catch (err) {
      console.error('Error resetting agents config:', err);
      res.status(500).json({ error: 'Failed to reset agents config' });
    }
  });

  return router;
}
