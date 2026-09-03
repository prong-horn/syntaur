/**
 * Dispatching a scheduled job into an assignment's chat (Decision 3, phase 4).
 *
 * A schedule used to open a terminal and then poll a runtime marker for proof
 * the agent had actually come up ("wrapper spawned ≠ agent running"). There is
 * no wrapper any more: the tick posts the job's `message` into the assignment's
 * chat and the accepted `messageId` IS the ack. What varies is only WHERE the
 * chat lives relative to the tick:
 *
 *   - **in-process** — the tick runs inside the dashboard server (the watcher's
 *     accelerator), so it holds the broker and calls it directly;
 *   - **REST** — the tick runs as the launchd `schedule tick` CLI, so it talks
 *     to the running dashboard on the port in `~/.syntaur/dashboard-port`. With
 *     no dashboard up there is nothing to dispatch into, and the job records an
 *     error rather than falling back to a terminal.
 *
 * Both are one `ChatDispatcher`, so the tick, `reapStale` and `schedule kill`
 * are written once.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { syntaurRoot } from '../utils/paths.js';
import { messageTurnState, type MessageTurnState } from '../chat/message-state.js';
import type { ChatBroker } from '../chat/broker.js';
import type { ResolvedAssignment } from '../utils/assignment-resolver.js';

export class DispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatchError';
  }
}

export interface ChatDispatcher {
  /** Agent ids attached to the assignment's chat. Throws when unreachable. */
  attachedAgents(assignmentId: string): Promise<string[]>;
  /** Post the message; resolves with the accepted `messageId` (the ack). */
  send(assignmentId: string, agentId: string | null, text: string): Promise<string>;
  /** Withdraw a still-queued message. False when it has already been sent. */
  withdraw(assignmentId: string, messageId: string): Promise<boolean>;
  /** Cancel the running turn for an agent (null = every agent on the chat). */
  cancel(assignmentId: string, agentId: string | null): Promise<boolean>;
  /** Where a dispatched message stands; null when the chat has never seen it. */
  messageState(assignmentId: string, messageId: string): Promise<MessageTurnState | null>;
}

/**
 * Refuse before anything is sent when the job names an agent the chat has not
 * attached, or names none and the chat has nobody. "Records an error instead of
 * launching anything" is the contract; a message posted into an empty room
 * would otherwise sit in the log with nobody to answer it.
 */
export async function assertAgentAttached(
  dispatcher: ChatDispatcher,
  assignmentId: string,
  agentId: string | null,
): Promise<void> {
  const attached = await dispatcher.attachedAgents(assignmentId);
  if (agentId === null) {
    if (attached.length === 0) {
      throw new DispatchError(
        `no agent is attached to assignment ${assignmentId} — attach one from the Chat tab’s “Manage agents”`,
      );
    }
    return;
  }
  if (!attached.includes(agentId)) {
    throw new DispatchError(
      `agent ${JSON.stringify(agentId)} is not attached to assignment ${assignmentId} (attached: ${
        attached.length > 0 ? attached.join(', ') : 'none'
      })`,
    );
  }
}

// --- in-process (inside the dashboard server) --------------------------------

export interface InProcessDeps {
  broker: ChatBroker;
  /** Resolve an assignment id/slug the way the chat routes do. */
  resolveAssignment: (assignmentId: string) => Promise<ResolvedAssignment | null>;
}

export function inProcessDispatcher(deps: InProcessDeps): ChatDispatcher {
  async function need(assignmentId: string): Promise<ResolvedAssignment> {
    const assignment = await deps.resolveAssignment(assignmentId);
    if (!assignment) throw new DispatchError(`no assignment with id ${JSON.stringify(assignmentId)}`);
    return assignment;
  }
  return {
    async attachedAgents(assignmentId) {
      const { participants } = await deps.broker.getParticipants(await need(assignmentId));
      return participants.agents;
    },
    async send(assignmentId, agentId, text) {
      const { messageId } = await deps.broker.send({
        assignment: await need(assignmentId),
        agentId,
        text,
      });
      return messageId;
    },
    async withdraw(assignmentId, messageId) {
      return deps.broker.withdraw(await need(assignmentId), messageId);
    },
    async cancel(assignmentId, agentId) {
      return deps.broker.cancel(await need(assignmentId), agentId);
    },
    async messageState(assignmentId, messageId) {
      const assignment = await need(assignmentId);
      return messageTurnState(assignment.id, messageId);
    },
  };
}

// --- REST (the launchd `schedule tick` CLI) ----------------------------------

/** The dashboard's listening port, or null when it is not running. */
export async function readDashboardPort(root = syntaurRoot()): Promise<number | null> {
  try {
    const raw = (await readFile(resolve(root, 'dashboard-port'), 'utf-8')).trim();
    const port = Number.parseInt(raw, 10);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

export interface RestDeps {
  port: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

export function restDispatcher(deps: RestDeps): ChatDispatcher {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const base = `http://127.0.0.1:${deps.port}/api`;

  async function call(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await doFetch(`${base}${path}`, init);
    } catch (err) {
      throw new DispatchError(
        `the dashboard on port ${deps.port} is not reachable (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  async function bodyError(res: Response): Promise<string> {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return body?.error ?? `HTTP ${res.status}`;
  }

  return {
    async attachedAgents(assignmentId) {
      const res = await call(`/assignments/${encodeURIComponent(assignmentId)}/chat/participants`);
      if (!res.ok) throw new DispatchError(await bodyError(res));
      const body = (await res.json()) as { participants?: { agents?: string[] } };
      return body.participants?.agents ?? [];
    },
    async send(assignmentId, agentId, text) {
      const res = await call(`/assignments/${encodeURIComponent(assignmentId)}/chat/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, ...(agentId ? { agentId } : {}) }),
      });
      if (res.status !== 202) throw new DispatchError(await bodyError(res));
      const body = (await res.json()) as { messageId?: string };
      if (!body.messageId) throw new DispatchError('the dashboard accepted the message without a messageId');
      return body.messageId;
    },
    async withdraw(assignmentId, messageId) {
      const res = await call(
        `/assignments/${encodeURIComponent(assignmentId)}/chat/messages/${encodeURIComponent(messageId)}`,
        { method: 'DELETE' },
      );
      return res.ok;
    },
    async cancel(assignmentId, agentId) {
      const res = await call(`/assignments/${encodeURIComponent(assignmentId)}/chat/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(agentId ? { agentId } : {}),
      });
      if (!res.ok) throw new DispatchError(await bodyError(res));
      const body = (await res.json()) as { cancelled?: boolean };
      return body.cancelled === true;
    },
    async messageState(assignmentId, messageId) {
      const res = await call(
        `/assignments/${encodeURIComponent(assignmentId)}/chat/messages/${encodeURIComponent(messageId)}`,
      );
      if (res.status === 404) return null;
      if (!res.ok) throw new DispatchError(await bodyError(res));
      return (await res.json()) as MessageTurnState;
    },
  };
}
