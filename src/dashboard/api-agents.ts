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
} from '../utils/agents-schema.js';

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

  return { ok: true, value: cleaned };
}

export function createAgentsRouter(): Router {
  const router = Router();

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
