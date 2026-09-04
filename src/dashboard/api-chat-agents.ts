import { Router, type Response } from 'express';
import { resolve } from 'node:path';
import {
  AgentDefinitionError,
  AgentWriteError,
  agentsDir,
  assertWritableAgentId,
  loadAgentDefinitions,
  toAgentSummary,
} from '../chat/agents.js';
import type { ChatBroker } from '../chat/broker.js';
import { ChatSendError } from '../chat/broker.js';
import type { AgentDefinition, AgentDefinitionInput, Harness } from '../chat/types.js';
import { fileExists } from '../utils/fs.js';
import { syntaurRoot } from '../utils/paths.js';

export interface ChatAgentsRouterOptions {
  broker: ChatBroker;
  syntaurHome?: string;
}

function enrichDefinition(definition: AgentDefinition, summary: ReturnType<typeof toAgentSummary>) {
  return {
    ...definition,
    builtin: summary.builtin,
    overridesBuiltin: summary.overridesBuiltin,
  };
}

export function createChatAgentsRouter({ broker, syntaurHome }: ChatAgentsRouterOptions): Router {
  const home = syntaurHome ?? syntaurRoot();
  const router = Router();

  function fail(res: Response, err: unknown): void {
    if (
      err instanceof ChatSendError ||
      err instanceof AgentWriteError ||
      err instanceof AgentDefinitionError
    ) {
      const status = err instanceof AgentDefinitionError ? 400 : err.status;
      const message =
        err instanceof AgentDefinitionError ? err.reason : err.message;
      res.status(status).json({ error: message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }

  function parseBody(
    res: Response,
    paramId: string,
    body: Partial<AgentDefinitionInput>,
  ): AgentDefinitionInput | null {
    if (body.id !== undefined && body.id !== paramId) {
      res.status(400).json({ error: `body id must match ${JSON.stringify(paramId)}` });
      return null;
    }
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      res.status(400).json({ error: 'name is required' });
      return null;
    }
    if (typeof body.harness !== 'string') {
      res.status(400).json({ error: 'harness is required' });
      return null;
    }
    if (typeof body.respondsTo !== 'string') {
      res.status(400).json({ error: 'respondsTo is required' });
      return null;
    }
    if (typeof body.default !== 'boolean') {
      res.status(400).json({ error: 'default is required' });
      return null;
    }
    if (typeof body.systemPrompt !== 'string') {
      res.status(400).json({ error: 'systemPrompt is required' });
      return null;
    }
    if (typeof body.color !== 'string') {
      res.status(400).json({ error: 'color is required' });
      return null;
    }
    return { ...body, id: paramId } as AgentDefinitionInput;
  }

  router.get('/chat/agents/:id', async (req, res) => {
    try {
      const id = String(req.params.id);
      assertWritableAgentId(id);
      const { definitions } = await broker.listAgents();
      const definition = definitions.find((d) => d.id === id);
      if (!definition) {
        res.status(404).json({ error: `No agent definition ${JSON.stringify(id)}` });
        return;
      }
      const summary = (await broker.agentSummaries()).find((a) => a.id === id)!;
      res.json({ definition: enrichDefinition(definition, summary) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/chat/agents/:id', async (req, res) => {
    try {
      const id = String(req.params.id);
      assertWritableAgentId(id);
      const path = resolve(agentsDir(home), `${id}.md`);
      if (await fileExists(path)) {
        res.status(409).json({ error: `Agent ${JSON.stringify(id)} already exists` });
        return;
      }
      const input = parseBody(res, id, (req.body ?? {}) as Partial<AgentDefinitionInput>);
      if (!input) return;
      const definition = await broker.saveAgent(input);
      const summary = (await broker.agentSummaries()).find((a) => a.id === id)!;
      res.status(201).json({ agent: summary, definition: enrichDefinition(definition, summary) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.put('/chat/agents/:id', async (req, res) => {
    try {
      const id = String(req.params.id);
      assertWritableAgentId(id);
      const { definitions } = await broker.listAgents();
      if (!definitions.some((d) => d.id === id)) {
        res.status(404).json({ error: `No agent definition ${JSON.stringify(id)}` });
        return;
      }
      const input = parseBody(res, id, (req.body ?? {}) as Partial<AgentDefinitionInput>);
      if (!input) return;
      const definition = await broker.saveAgent(input);
      const summary = (await broker.agentSummaries()).find((a) => a.id === id)!;
      res.json({ agent: summary, definition: enrichDefinition(definition, summary) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/chat/agents/:id', async (req, res) => {
    try {
      const id = String(req.params.id);
      assertWritableAgentId(id);
      const result = await broker.deleteAgent(id);
      res.json({
        deleted: id,
        restoredBuiltin: result.restoredBuiltin,
        agents: await broker.agentSummaries(),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/chat/agents/:id/test', async (req, res) => {
    try {
      const id = String(req.params.id);
      assertWritableAgentId(id);
      res.json(await broker.testAgent(id));
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/chat/harnesses', async (_req, res) => {
    try {
      res.json({ harnesses: broker.harnesses() });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/chat/harnesses/:id/refresh', async (req, res) => {
    try {
      const id = String(req.params.id);
      const harness = await broker.refreshHarness(id as Harness);
      res.json({ harness });
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
