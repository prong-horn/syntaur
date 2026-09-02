/**
 * Assignment-chat runtime operations.
 *
 * Everything runs on the session-db connection (`getSessionDb()`), the same
 * handle `engagement-db.ts` uses, so a turn's chat write and its engagement write
 * share one file and one open path (Decision 8). The DDL and version constant
 * live in `chat-schema.ts` (zero-import) to avoid a `session-db ↔ chat-db` cycle.
 *
 * `chat_items` is a rebuildable index: `upsertChatItem` is INSERT-OR-REPLACE by
 * `item_id`, and `deleteChatItem` serves the normalizer's `retract` patch (the
 * fold rule). Neither is a source of truth — `chat/events.jsonl` is.
 */

import { getSessionDb } from '../dashboard/session-db.js';
import type { ChatItem, ChatItemRow, ChatSessionRow, ItemPatch } from '../chat/types.js';

// --- sessions --------------------------------------------------------------

export interface UpsertChatSessionInput {
  sessionKey: string;
  assignmentId: string;
  projectSlug: string | null;
  assignmentSlug: string | null;
  agentId: string;
  harness: string;
  acpSessionId?: string | null;
  adapterVersion?: string | null;
  cwd?: string | null;
  pid?: number | null;
  profileJson?: string | null;
  usageSnapshotJson?: string | null;
  state: string;
  lastTurnAt?: string | null;
}

/**
 * Upsert the chat session row. Nullable payload fields are write-if-present:
 * a state transition must not erase the ACP session id the next `session/resume`
 * needs.
 */
export function upsertChatSession(input: UpsertChatSessionInput): void {
  getSessionDb()
    .prepare(
      `INSERT INTO chat_sessions (
         session_key, assignment_id, project_slug, assignment_slug, agent_id, harness,
         acp_session_id, adapter_version, cwd, pid, profile_json, usage_snapshot_json,
         state, created_at, last_turn_at
       ) VALUES (
         @sessionKey, @assignmentId, @projectSlug, @assignmentSlug, @agentId, @harness,
         @acpSessionId, @adapterVersion, @cwd, @pid, @profileJson, @usageSnapshotJson,
         @state, @now, @lastTurnAt
       )
       ON CONFLICT(session_key) DO UPDATE SET
         assignment_id       = excluded.assignment_id,
         project_slug        = COALESCE(excluded.project_slug,        chat_sessions.project_slug),
         assignment_slug     = COALESCE(excluded.assignment_slug,     chat_sessions.assignment_slug),
         agent_id            = excluded.agent_id,
         harness             = excluded.harness,
         acp_session_id      = COALESCE(excluded.acp_session_id,      chat_sessions.acp_session_id),
         adapter_version     = COALESCE(excluded.adapter_version,     chat_sessions.adapter_version),
         cwd                 = COALESCE(excluded.cwd,                 chat_sessions.cwd),
         pid                 = COALESCE(excluded.pid,                 chat_sessions.pid),
         profile_json        = COALESCE(excluded.profile_json,        chat_sessions.profile_json),
         usage_snapshot_json = COALESCE(excluded.usage_snapshot_json, chat_sessions.usage_snapshot_json),
         state               = excluded.state,
         last_turn_at        = COALESCE(excluded.last_turn_at,        chat_sessions.last_turn_at)`,
    )
    .run({
      sessionKey: input.sessionKey,
      assignmentId: input.assignmentId,
      projectSlug: input.projectSlug,
      assignmentSlug: input.assignmentSlug,
      agentId: input.agentId,
      harness: input.harness,
      acpSessionId: input.acpSessionId ?? null,
      adapterVersion: input.adapterVersion ?? null,
      cwd: input.cwd ?? null,
      pid: input.pid ?? null,
      profileJson: input.profileJson ?? null,
      usageSnapshotJson: input.usageSnapshotJson ?? null,
      state: input.state,
      now: new Date().toISOString(),
      lastTurnAt: input.lastTurnAt ?? null,
    });
}

/** Clear the adapter pid — the process is gone; the ACP session id survives. */
export function clearChatSessionPid(sessionKey: string): void {
  getSessionDb().prepare('UPDATE chat_sessions SET pid = NULL WHERE session_key = ?').run(sessionKey);
}

export function getChatSession(assignmentId: string, agentId: string): ChatSessionRow | null {
  const row = getSessionDb()
    .prepare('SELECT * FROM chat_sessions WHERE assignment_id = ? AND agent_id = ? LIMIT 1')
    .get(assignmentId, agentId) as ChatSessionRow | undefined;
  return row ?? null;
}

export function getChatSessionByKey(sessionKey: string): ChatSessionRow | null {
  const row = getSessionDb()
    .prepare('SELECT * FROM chat_sessions WHERE session_key = ? LIMIT 1')
    .get(sessionKey) as ChatSessionRow | undefined;
  return row ?? null;
}

export function listChatSessions(assignmentId: string): ChatSessionRow[] {
  return getSessionDb()
    .prepare('SELECT * FROM chat_sessions WHERE assignment_id = ? ORDER BY agent_id')
    .all(assignmentId) as ChatSessionRow[];
}

// --- items -----------------------------------------------------------------

export function upsertChatItem(sessionKey: string, item: ChatItem): void {
  getSessionDb()
    .prepare(
      `INSERT INTO chat_items (
         item_id, assignment_id, session_key, turn_id, agent_id, type, ts,
         seq_first, seq_last, sealed, json
       ) VALUES (
         @itemId, @assignmentId, @sessionKey, @turnId, @agentId, @type, @ts,
         @seqFirst, @seqLast, @sealed, @json
       )
       ON CONFLICT(item_id) DO UPDATE SET
         turn_id   = excluded.turn_id,
         type      = excluded.type,
         ts        = excluded.ts,
         seq_first = excluded.seq_first,
         seq_last  = excluded.seq_last,
         sealed    = excluded.sealed,
         json      = excluded.json`,
    )
    .run({
      itemId: item.itemId,
      assignmentId: item.assignmentId,
      sessionKey,
      turnId: item.turnId,
      agentId: item.agentId,
      type: item.type,
      ts: item.ts,
      seqFirst: item.seqFirst,
      seqLast: item.seqLast,
      sealed: item.sealed ? 1 : 0,
      json: JSON.stringify(item),
    });
}

export function deleteChatItem(itemId: string): void {
  getSessionDb().prepare('DELETE FROM chat_items WHERE item_id = ?').run(itemId);
}

/** Apply one normalizer patch to the index. */
export function applyChatPatch(sessionKey: string, patch: ItemPatch): void {
  if (patch.op === 'retract') deleteChatItem(patch.itemId);
  else upsertChatItem(sessionKey, patch.item);
}

export interface ListChatItemsOptions {
  /** Page backwards: only items strictly before this `seq_first`. */
  beforeSeq?: number;
  /** Newest-first page size; the result is returned oldest-first. */
  limit?: number;
}

const DEFAULT_PAGE = 200;

/**
 * A page of items, oldest-first. Paging runs newest-first under the hood (the
 * chat opens at the bottom), then flips, so `beforeSeq` walks history backwards.
 */
export function listChatItems(assignmentId: string, options: ListChatItemsOptions = {}): ChatItem[] {
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_PAGE, 1000));
  const clauses = ['assignment_id = ?'];
  const params: unknown[] = [assignmentId];
  if (typeof options.beforeSeq === 'number') {
    clauses.push('seq_first < ?');
    params.push(options.beforeSeq);
  }
  const rows = getSessionDb()
    .prepare(
      `SELECT json FROM chat_items
        WHERE ${clauses.join(' AND ')}
        ORDER BY seq_first DESC, item_id DESC
        LIMIT ?`,
    )
    .all(...params, limit) as Array<{ json: string }>;
  return rows.reverse().map((r) => JSON.parse(r.json) as ChatItem);
}

export function countChatItems(assignmentId: string): number {
  const row = getSessionDb()
    .prepare('SELECT COUNT(*) AS n FROM chat_items WHERE assignment_id = ?')
    .get(assignmentId) as { n: number };
  return row.n;
}

export function deleteChatItems(assignmentId: string): number {
  return getSessionDb()
    .prepare('DELETE FROM chat_items WHERE assignment_id = ?')
    .run(assignmentId).changes;
}

/** Raw rows — the reindex test's equality check compares these. */
export function listChatItemRows(assignmentId: string): ChatItemRow[] {
  return getSessionDb()
    .prepare(
      'SELECT * FROM chat_items WHERE assignment_id = ? ORDER BY seq_first, item_id',
    )
    .all(assignmentId) as ChatItemRow[];
}
