import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { canonicalPath } from '../utils/path-canon.js';
import { readConfig } from '../utils/config.js';
import { syntaurRoot } from '../utils/paths.js';
import type { DispatchResult, StageDispatchCallback } from '../lifecycle/stage-entry.js';
import type { ChatBroker } from './broker.js';
import { resolveTicketById } from '../utils/ticket-resolver.js';
import { verifyHomeOwnerRuntime } from './broker-owner.js';

const DEFAULT_TIMEOUT_MS = 5_000;

export interface ChatRuntimeIdentity {
  protocol: number;
  root: string;
  projectsDir: string;
  pid: number;
  processStartedAt: string | null;
  ownerToken: string;
  port: number;
}

export type DispatchReceiptState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'superseded'
  | 'offline'
  | 'unknown';

function parseStrictPort(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const port = Number.parseInt(trimmed, 10);
  if (port < 1 || port > 65535) return null;
  return port;
}

export function parseChatRuntimeIdentity(body: unknown): ChatRuntimeIdentity | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  if (o.protocol !== 1) return null;
  if (typeof o.root !== 'string' || o.root.trim() === '') return null;
  if (typeof o.projectsDir !== 'string' || o.projectsDir.trim() === '') return null;
  if (typeof o.pid !== 'number' || !Number.isInteger(o.pid) || o.pid <= 0) return null;
  if (o.processStartedAt !== null && typeof o.processStartedAt !== 'string') return null;
  if (typeof o.ownerToken !== 'string' || o.ownerToken.trim() === '') return null;
  if (typeof o.port !== 'number' || !Number.isInteger(o.port) || o.port < 1 || o.port > 65535) {
    return null;
  }
  return {
    protocol: 1,
    root: o.root,
    projectsDir: o.projectsDir,
    pid: o.pid,
    processStartedAt: o.processStartedAt,
    ownerToken: o.ownerToken.trim(),
    port: o.port,
  };
}

export async function readDashboardPort(root?: string): Promise<number | null> {
  const home = root ?? syntaurRoot();
  try {
    const raw = await readFile(resolve(home, 'dashboard-port'), 'utf-8');
    return parseStrictPort(raw);
  } catch {
    return null;
  }
}

export async function fetchChatRuntime(
  port: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ChatRuntimeIdentity | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat/runtime`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    const parsed = parseChatRuntimeIdentity(body);
    if (!parsed || parsed.port !== port) return null;
    return parsed;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyChatRuntime(root?: string): Promise<{
  port: number;
  runtime: ChatRuntimeIdentity;
} | null> {
  const home = root ?? syntaurRoot();
  const port = await readDashboardPort(home);
  if (!port) return null;
  const runtime = await fetchChatRuntime(port);
  if (!runtime) return null;
  const config = await readConfig();
  const expectedRoot = canonicalPath(home);
  const expectedProjects = canonicalPath(config.defaultProjectDir);
  const actualRoot = canonicalPath(runtime.root);
  const actualProjects = canonicalPath(runtime.projectsDir);
  if (expectedRoot !== actualRoot || expectedProjects !== actualProjects) {
    return null;
  }
  if (!(await verifyHomeOwnerRuntime(runtime, home))) {
    return null;
  }
  return { port, runtime };
}

export interface DispatchPostInput {
  ticketId: string;
  entryId: string;
  requestId: string;
  source: 'automatic' | 'manual';
  agentId?: string;
}

export interface DispatchPostResult {
  state: DispatchReceiptState;
  requestId?: string;
  error?: string;
  warning?: string;
  agentId?: string;
}

function mapDispatchResponse(
  status: number,
  body: Record<string, unknown>,
  requestId: string,
): DispatchPostResult {
  const receiptState = typeof body.state === 'string' ? body.state : undefined;
  const agentId = typeof body.agentId === 'string' ? body.agentId : undefined;
  const error = typeof body.error === 'string' ? body.error : undefined;
  if (status === 202 || status === 200) {
    const state = (receiptState ?? 'queued') as DispatchReceiptState;
    return { state, requestId: (body.requestId as string) ?? requestId, agentId };
  }
  if (status === 409 || status === 400) {
    return {
      state: 'failed',
      requestId,
      error: error ?? `dispatch refused (${status})`,
    };
  }
  if (status === 503) {
    return {
      state: 'offline',
      requestId,
      warning: error ?? 'broker unavailable',
    };
  }
  return {
    state: 'failed',
    requestId,
    error: error ?? `unexpected status ${status}`,
  };
}

export async function postTicketDispatch(
  input: DispatchPostInput,
  root?: string,
): Promise<DispatchPostResult> {
  const verified = await verifyChatRuntime(root);
  if (!verified) {
    return {
      state: 'offline',
      requestId: input.requestId,
      warning: 'Dashboard broker unavailable or identity mismatch',
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(
      `http://127.0.0.1:${verified.port}/api/tickets/${encodeURIComponent(input.ticketId)}/dispatch`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          entryId: input.entryId,
          requestId: input.requestId,
          source: input.source,
          ...(input.agentId ? { agentId: input.agentId } : {}),
        }),
        signal: controller.signal,
      },
    );
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return mapDispatchResponse(res.status, body, input.requestId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('abort')) {
      return {
        state: 'unknown',
        requestId: input.requestId,
        warning: 'Dispatch acceptance timed out; retry with the same request id',
      };
    }
    return {
      state: 'offline',
      requestId: input.requestId,
      warning: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface StageEntryNotifyInput {
  ticketId: string;
  ticketDir: string;
  projectSlug: string | null;
  entryId: string;
}

export async function postStageEntryNotify(
  input: StageEntryNotifyInput,
  root?: string,
): Promise<void> {
  const verified = await verifyChatRuntime(root);
  if (!verified) {
    throw new Error('Dashboard broker unavailable or identity mismatch');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(
      `http://127.0.0.1:${verified.port}/api/tickets/${encodeURIComponent(input.ticketId)}/stage-entry`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entryId: input.entryId }),
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `stage-entry notify failed (${res.status})`);
    }
  } finally {
    clearTimeout(timer);
  }
}

type StageNotifyBroker = ChatBroker & {
  notifyStageEntry?(ticket: import('../utils/ticket-resolver.js').ResolvedTicket): Promise<void>;
};

const dispatchFn: StageDispatchCallback = async (input) => {
  const result = await postTicketDispatch({
    ticketId: input.ticketId,
    entryId: input.entryId,
    requestId: input.requestId,
    source: input.source,
    agentId: input.agentId,
  });
  return result as DispatchResult;
};

export const postCliStageDispatch = Object.assign(dispatchFn, {
  notifyStageEntry: postStageEntryNotify,
}) as StageDispatchCallback & {
  notifyStageEntry: (input: StageEntryNotifyInput) => Promise<void>;
};

export function createInProcessStageDispatch(
  broker: ChatBroker,
  projectsDir: string,
): StageDispatchCallback & {
  notifyStageEntry: (input: StageEntryNotifyInput) => Promise<void>;
} {
  const notifyBroker = broker as StageNotifyBroker;
  const fn: StageDispatchCallback = async (input) => {
    try {
      const config = await readConfig();
      const resolved = await resolveTicketById(
        projectsDir ?? config.defaultProjectDir,
        input.ticketId,
      );
      if (!resolved) {
        return { state: 'failed', error: `ticket ${input.ticketId} not found` };
      }
      const result = await broker.dispatchStage({
        ticket: resolved,
        entryId: input.entryId,
        requestId: input.requestId,
        source: input.source,
        agentId: input.agentId,
      });
      const receipt = await broker.getStageDispatch(resolved, result.requestId);
      if (receipt) {
        return {
          state: receipt.state,
          requestId: receipt.requestId,
        } as DispatchResult;
      }
      return { state: 'queued', requestId: result.requestId };
    } catch (err) {
      return {
        state: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
  return Object.assign(fn, {
    notifyStageEntry: async (input: StageEntryNotifyInput) => {
      const config = await readConfig();
      const resolved = await resolveTicketById(
        projectsDir ?? config.defaultProjectDir,
        input.ticketId,
      );
      if (!resolved) {
        throw new Error(`ticket ${input.ticketId} not found`);
      }
      if (!notifyBroker.notifyStageEntry) {
        throw new Error('broker does not support stage-entry notification');
      }
      await notifyBroker.notifyStageEntry(resolved);
    },
  });
}
