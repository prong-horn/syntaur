/**
 * Assignment-chat schema — DDL + schema-version constant.
 *
 * Zero imports on purpose, exactly like `engagement-schema.ts`: both
 * `dashboard/session-db.ts` (which creates the tables inside `initSessionDb`)
 * and `db/chat-db.ts` (the runtime ops, which import `getSessionDb` from
 * `session-db.ts`) need the DDL, so keeping it here breaks the otherwise-circular
 * dependency. Decision 8.
 *
 * Both tables are a MATERIALISED INDEX, never a source of truth:
 * `<assignmentDir>/chat/events.jsonl` is (Decision 2), and `rebuildChatIndex`
 * replays it through a fresh normalizer to reproduce `chat_items` exactly.
 *
 * `chat_items.json` holds the serialised `ChatItem`; the columns beside it exist
 * only for paging and filtering. `chat_sessions.usage_snapshot_json` is the
 * cumulative `TokenSnapshot` the broker feeds to `openEngagement` /
 * `closeEngagementById`, persisted so a dashboard restart does not reset the
 * per-turn cost delta to zero (Decision 10).
 *
 * Its own `chat_schema_version` row in the shared `meta` table — distinct from
 * the `sessions` table's `schema_version` and from `engagement_schema_version`.
 *
 * v2 adds `chat_sessions.last_delivered_seq`: the highest chat-level `seq` an
 * agent session has been shown, so a restart neither re-sends nor skips the
 * history delta (Decision 4). It is declared here for a FRESH database and
 * added by the 1→2 step in `session-db.ts` for an existing one.
 *
 * v4 adds `chat_harness_options` (migration in `session-db.ts`) and
 * `chat_sessions.standing_fingerprint`: a sha256 of the roster lines and this
 * agent's system prompt as `buildStanding` would produce them, so a restart can
 * tell when the standing block needs to be re-sent.
 */

export const CHAT_SCHEMA_VERSION = '4';

export const CHAT_DDL = `
CREATE TABLE IF NOT EXISTS chat_sessions (
  session_key         TEXT PRIMARY KEY,
  assignment_id       TEXT NOT NULL,
  project_slug        TEXT,
  assignment_slug     TEXT,
  agent_id            TEXT NOT NULL,
  harness             TEXT NOT NULL,
  acp_session_id      TEXT,
  adapter_version     TEXT,
  cwd                 TEXT,
  pid                 INTEGER,
  profile_json        TEXT,
  usage_snapshot_json TEXT,
  state               TEXT NOT NULL DEFAULT 'none',
  created_at          TEXT NOT NULL,
  last_turn_at        TEXT,
  last_delivered_seq  INTEGER NOT NULL DEFAULT 0,
  commands_json       TEXT,
  standing_fingerprint TEXT
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_assignment ON chat_sessions(assignment_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_acp ON chat_sessions(acp_session_id);

CREATE TABLE IF NOT EXISTS chat_items (
  item_id       TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL,
  session_key   TEXT NOT NULL,
  turn_id       TEXT,
  agent_id      TEXT NOT NULL,
  type          TEXT NOT NULL,
  ts            TEXT NOT NULL,
  seq_first     INTEGER NOT NULL,
  seq_last      INTEGER NOT NULL,
  sealed        INTEGER NOT NULL DEFAULT 0,
  json          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_items_assignment_seq ON chat_items(assignment_id, seq_first);
CREATE INDEX IF NOT EXISTS idx_chat_items_assignment_turn ON chat_items(assignment_id, turn_id);

CREATE TABLE IF NOT EXISTS chat_harness_options (
  harness         TEXT PRIMARY KEY,
  adapter_version TEXT,
  captured_at     TEXT,
  record_json     TEXT,
  auth_state      TEXT NOT NULL DEFAULT 'unknown',
  auth_detail     TEXT,
  auth_at         TEXT
);
`;
