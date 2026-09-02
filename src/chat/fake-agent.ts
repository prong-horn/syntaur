/**
 * In-process fake ACP agent for tests (Decision 7).
 *
 * The SDK's `ClientApp.connect(agent: AgentApp)` overload wires a client
 * straight to an agent app with no transport, so the broker's whole lifecycle
 * (spawn → initialize → session/new → prompt → cancel → permissions → exit) is
 * exercised deterministically without paying ~$1 per claude turn.
 *
 * A script is a list of steps replayed in order for each `session/prompt`; the
 * last script is reused once the list runs out, so a test that only cares about
 * the first turn needs one entry.
 */

import * as acp from '@agentclientprotocol/sdk';

/** One scripted step inside a turn. */
export type FakeStep =
  | { kind: 'update'; update: acp.SessionUpdate }
  | { kind: 'permission'; request: Omit<acp.RequestPermissionRequest, 'sessionId'> }
  /** Wait for the client to `session/cancel`; resolves the turn `cancelled`. */
  | { kind: 'awaitCancel' }
  /** Fail the prompt with a JSON-RPC error. */
  | { kind: 'error'; message: string }
  /** Resolve a deferred the test controls, so a turn can be held open. */
  | { kind: 'gate'; gate: Promise<void> };

export interface FakeTurn {
  steps: FakeStep[];
  stopReason?: acp.StopReason;
  usage?: acp.Usage;
}

export interface FakeAgentOptions {
  turns?: FakeTurn[];
  agentInfo?: { name: string; version: string };
  modes?: acp.NewSessionResponse['modes'];
  configOptions?: acp.NewSessionResponse['configOptions'];
  /** Session ids handed out by `session/new`, in order. Defaults to `fake-session-<n>`. */
  sessionIds?: string[];
  /** When set, `session/resume` rejects with this message. */
  resumeError?: string;
  /** Replayed as `session/update`s before the `session/load` response. */
  loadReplay?: acp.SessionUpdate[];
}

export interface FakeAgent {
  app: acp.AgentApp;
  /** Every request the fake received, in order — `['initialize', 'session/new', …]`. */
  readonly calls: string[];
  /** `session/new` request params, in order. */
  readonly newSessionRequests: acp.NewSessionRequest[];
  /** `session/prompt` request params, in order. */
  readonly prompts: acp.PromptRequest[];
  /** `session/set_mode` and `session/set_config_option` params, in order. */
  readonly configCalls: Array<{ method: string; params: Record<string, unknown> }>;
  /** Permission responses the client returned, in order. */
  readonly permissionAnswers: acp.RequestPermissionResponse[];
  /** Append more turns after construction. */
  push(turn: FakeTurn): void;
}

export function createFakeAgent(options: FakeAgentOptions = {}): FakeAgent {
  const turns: FakeTurn[] = [...(options.turns ?? [])];
  const calls: string[] = [];
  const newSessionRequests: acp.NewSessionRequest[] = [];
  const prompts: acp.PromptRequest[] = [];
  const configCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const permissionAnswers: acp.RequestPermissionResponse[] = [];
  const cancelled = new Map<string, Array<() => void>>();
  let turnIndex = 0;
  let sessionCount = 0;

  const nextSessionId = (): string => {
    const explicit = options.sessionIds?.[sessionCount];
    sessionCount += 1;
    return explicit ?? `fake-session-${sessionCount}`;
  };

  const waitForCancel = (sessionId: string): Promise<void> =>
    new Promise<void>((resolve) => {
      const list = cancelled.get(sessionId) ?? [];
      list.push(resolve);
      cancelled.set(sessionId, list);
    });

  const app = acp
    .agent({ name: 'fake-acp-agent' })
    .onRequest(acp.methods.agent.initialize, () => {
      calls.push('initialize');
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true },
        agentInfo: options.agentInfo ?? { name: 'fake-acp-agent', version: '0.0.1' },
        authMethods: [],
      } satisfies acp.InitializeResponse;
    })
    .onRequest(acp.methods.agent.session.new, (ctx) => {
      calls.push('session/new');
      newSessionRequests.push(ctx.params);
      return {
        sessionId: nextSessionId(),
        ...(options.modes ? { modes: options.modes } : {}),
        ...(options.configOptions ? { configOptions: options.configOptions } : {}),
      } as acp.NewSessionResponse;
    })
    .onRequest(acp.methods.agent.session.resume, (ctx) => {
      calls.push('session/resume');
      // A RequestError carries its message across the wire; a plain Error is
      // flattened to "Internal error" by the connection layer.
      if (options.resumeError) throw new acp.RequestError(-32002, options.resumeError);
      return { sessionId: ctx.params.sessionId } as unknown as acp.ResumeSessionResponse;
    })
    .onRequest(acp.methods.agent.session.load, async (ctx) => {
      calls.push('session/load');
      for (const update of options.loadReplay ?? []) {
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update,
        });
      }
      return {} as acp.LoadSessionResponse;
    })
    .onRequest(acp.methods.agent.session.setMode, (ctx) => {
      calls.push('session/set_mode');
      configCalls.push({ method: 'session/set_mode', params: ctx.params as unknown as Record<string, unknown> });
      return {} as acp.SetSessionModeResponse;
    })
    .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => {
      calls.push('session/set_config_option');
      configCalls.push({
        method: 'session/set_config_option',
        params: ctx.params as unknown as Record<string, unknown>,
      });
      return { configOptions: [] } as unknown as acp.SetSessionConfigOptionResponse;
    })
    .onNotification(acp.methods.agent.session.cancel, (ctx) => {
      calls.push('session/cancel');
      const waiters = cancelled.get(ctx.params.sessionId) ?? [];
      cancelled.set(ctx.params.sessionId, []);
      for (const w of waiters) w();
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      calls.push('session/prompt');
      prompts.push(ctx.params);
      const turn = turns[Math.min(turnIndex, turns.length - 1)] ?? { steps: [] };
      turnIndex += 1;
      const sessionId = ctx.params.sessionId;

      for (const step of turn.steps) {
        switch (step.kind) {
          case 'update':
            await ctx.client.notify(acp.methods.client.session.update, {
              sessionId,
              update: step.update,
            });
            break;
          case 'permission': {
            const answer = await ctx.client.request(acp.methods.client.session.requestPermission, {
              sessionId,
              ...step.request,
            } as acp.RequestPermissionRequest);
            permissionAnswers.push(answer);
            break;
          }
          case 'awaitCancel':
            await waitForCancel(sessionId);
            return { stopReason: 'cancelled' } as acp.PromptResponse;
          case 'gate':
            await step.gate;
            break;
          case 'error':
            throw new Error(step.message);
        }
      }

      return {
        stopReason: turn.stopReason ?? 'end_turn',
        ...(turn.usage ? { usage: turn.usage } : {}),
      } as acp.PromptResponse;
    });

  return {
    app,
    calls,
    newSessionRequests,
    prompts,
    configCalls,
    permissionAnswers,
    push(turn) {
      turns.push(turn);
    },
  };
}

// --- update builders (keep the scripts readable) ---------------------------

export function textChunk(text: string, messageId?: string): acp.SessionUpdate {
  return {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
    ...(messageId ? { messageId } : {}),
  } as acp.SessionUpdate;
}

export function thoughtChunk(text: string, messageId?: string): acp.SessionUpdate {
  return {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text },
    ...(messageId ? { messageId } : {}),
  } as acp.SessionUpdate;
}

export function toolCall(
  toolCallId: string,
  fields: Partial<acp.ToolCall> = {},
): acp.SessionUpdate {
  return {
    sessionUpdate: 'tool_call',
    toolCallId,
    title: fields.title ?? `Tool ${toolCallId}`,
    kind: fields.kind ?? 'read',
    status: fields.status ?? 'pending',
    ...fields,
  } as acp.SessionUpdate;
}

export function toolCallUpdate(
  toolCallId: string,
  fields: Partial<acp.ToolCallUpdate> = {},
): acp.SessionUpdate {
  return { sessionUpdate: 'tool_call_update', toolCallId, ...fields } as acp.SessionUpdate;
}

export function planUpdate(entries: acp.PlanEntry[]): acp.SessionUpdate {
  return { sessionUpdate: 'plan', entries } as acp.SessionUpdate;
}

export function usageUpdate(used: number, size: number, cost?: number): acp.SessionUpdate {
  return {
    sessionUpdate: 'usage_update',
    used,
    size,
    ...(cost === undefined ? {} : { cost: { amount: cost, currency: 'USD' } }),
  } as acp.SessionUpdate;
}
