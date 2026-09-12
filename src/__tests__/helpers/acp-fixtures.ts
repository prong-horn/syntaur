/**
 * Turn the spike's direction-tagged NDJSON transcripts into `ChatEvent`s so the
 * normalizer can be replayed against 46 recordings of the two real adapters.
 *
 * The mapping is the one plan Task 4 fixes, and it is deterministic — the
 * outbound `session/prompt` JSON-RPC id becomes the `turnId`, so snapshots do not
 * move between runs:
 *
 *   in  session/update             → acp.update
 *   in  session/request_permission → acp.permission_request  (requestId `perm-<id>`)
 *   out response to that id        → acp.permission_response
 *   out session/prompt             → turn.start   (turnId = the request's id)
 *   in  response to that id        → turn.end
 *   out session/cancel             → turn.cancel
 *   out session/load               → session.load; its response → session.loaded
 *   out session/resume             → session.resumed
 *
 * Everything else in the transcript (initialize, session/new, set_mode,
 * set_config_option, the private `authentication/status` and `_session/steering`
 * extensions) has no chat meaning and is skipped.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { ChatEvent, ChatEventKind } from '../../chat/types.js';

export const FIXTURES_ROOT = fileURLToPath(new URL('../fixtures/acp/', import.meta.url));

export interface FixtureFrame {
  seq: number;
  ts: string;
  t: number;
  dir: 'in' | 'out';
  msg: {
    jsonrpc: string;
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: unknown;
  };
}

export interface FixtureCase {
  adapter: 'claude' | 'codex';
  file: string;
  /** `claude/07-permissions.ndjson` — the snapshot and test name. */
  name: string;
  path: string;
}

/** Every transcript under `src/__tests__/fixtures/acp/`, in a stable order. */
export function listFixtures(): FixtureCase[] {
  const out: FixtureCase[] = [];
  for (const adapter of ['claude', 'codex'] as const) {
    const dir = join(FIXTURES_ROOT, adapter);
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ndjson')).sort()) {
      out.push({ adapter, file, name: `${adapter}/${file}`, path: join(dir, file) });
    }
  }
  return out;
}

export function readFrames(path: string): FixtureFrame[] {
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as FixtureFrame);
}

export interface FixtureEventOptions {
  ticketId?: string;
  agentId?: string;
  sessionKey?: string;
}

/**
 * Replay one transcript as the `ChatEvent` sequence the broker would have
 * written. `seq` is the frame's own `seq`, so it is monotonic and matches the
 * transcript.
 */
export function fixtureEvents(path: string, options: FixtureEventOptions = {}): ChatEvent[] {
  const ticketId = options.ticketId ?? 'ticket-fixture';
  const agentId = options.agentId ?? 'claude';
  const sessionKey = options.sessionKey ?? `${ticketId}:${agentId}`;

  const frames = readFrames(path);
  /** Outbound request id → what its response means. */
  const pending = new Map<string, 'turn.end' | 'session.loaded'>();
  /** Inbound (agent→client) permission request id → our synthetic requestId. */
  const permissionIds = new Map<string, string>();
  /** turnId stack — the most recently started, unfinished turn owns the stream. */
  const openTurns: string[] = [];

  const events: ChatEvent[] = [];
  const push = (frame: FixtureFrame, kind: ChatEventKind, payload: unknown, turnId: string | null) => {
    events.push({
      seq: frame.seq,
      ts: frame.ts,
      ticketId,
      agentId,
      sessionKey,
      turnId,
      kind,
      payload,
    });
  };
  const currentTurn = (): string | null => openTurns[openTurns.length - 1] ?? null;

  for (const frame of frames) {
    const { msg, dir } = frame;

    if (dir === 'in' && msg.method === 'session/update') {
      const params = msg.params as { update: unknown };
      push(frame, 'acp.update', params.update, currentTurn());
      continue;
    }

    if (dir === 'in' && msg.method === 'session/request_permission') {
      const requestId = `perm-${String(msg.id)}`;
      permissionIds.set(String(msg.id), requestId);
      push(frame, 'acp.permission_request', { requestId, request: msg.params }, currentTurn());
      continue;
    }

    if (dir === 'out' && msg.method === 'session/prompt') {
      // The JSON-RPC id is unique per file, so the turn scope (and therefore
      // every item id inside it) is stable across runs.
      const turnId = String(msg.id);
      openTurns.push(turnId);
      pending.set(turnId, 'turn.end');
      push(frame, 'turn.start', { messageId: `fixture-msg-${turnId}`, startedAt: frame.ts }, turnId);
      continue;
    }

    if (dir === 'out' && msg.method === 'session/cancel') {
      push(frame, 'turn.cancel', {}, currentTurn());
      continue;
    }

    if (dir === 'out' && msg.method === 'session/load') {
      pending.set(String(msg.id), 'session.loaded');
      push(frame, 'session.load', { sessionId: (msg.params as { sessionId?: string })?.sessionId }, null);
      continue;
    }

    if (dir === 'out' && msg.method === 'session/resume') {
      push(frame, 'session.resumed', {
        acpSessionId: (msg.params as { sessionId?: string })?.sessionId,
      }, null);
      continue;
    }

    // A client→agent frame with no method is our answer to a permission request.
    if (dir === 'out' && !msg.method && msg.id !== undefined) {
      const requestId = permissionIds.get(String(msg.id));
      if (requestId) {
        const outcome = (msg.result as { outcome?: { outcome?: string; optionId?: string } } | undefined)
          ?.outcome;
        push(
          frame,
          'acp.permission_response',
          {
            requestId,
            ...(outcome?.optionId ? { optionId: outcome.optionId } : {}),
            ...(outcome?.outcome === 'cancelled' ? { cancelled: true } : {}),
          },
          currentTurn(),
        );
      }
      continue;
    }

    // An agent→client response to one of our requests.
    if (dir === 'in' && !msg.method && msg.id !== undefined) {
      const what = pending.get(String(msg.id));
      if (what === 'turn.end') {
        const turnId = String(msg.id);
        pending.delete(turnId);
        const at = openTurns.indexOf(turnId);
        if (at >= 0) openTurns.splice(at, 1);
        const result = msg.result as { stopReason?: string; usage?: unknown } | undefined;
        push(
          frame,
          'turn.end',
          {
            stopReason: msg.error ? 'error' : (result?.stopReason ?? 'end_turn'),
            endedAt: frame.ts,
            ...(result?.usage ? { usage: result.usage } : {}),
          },
          turnId,
        );
      } else if (what === 'session.loaded') {
        pending.delete(String(msg.id));
        push(frame, 'session.loaded', {}, null);
      }
      continue;
    }
  }

  return events;
}
