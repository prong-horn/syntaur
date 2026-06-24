/**
 * Engagement edge schema — DDL + schema-version constant.
 *
 * This module has **zero imports** on purpose. Both `dashboard/session-db.ts`
 * (which creates the table inside `initSessionDb`) and `db/engagement-db.ts`
 * (the runtime ops, which import `getSessionDb` from `session-db.ts`) need the
 * DDL. Keeping it here breaks the otherwise-circular `session-db ↔ engagement-db`
 * dependency. See decision-record.md Decision 10.
 *
 * `engagement` is the canonical append-only session↔assignment M:N edge:
 * intervals carrying a `stage`, with at most one OPEN row per session enforced
 * by the partial unique index. Token snapshots (`tokens_at_open`/
 * `tokens_at_close`) are JSON `TokenSnapshot` blobs (see `engagement-tokens.ts`)
 * or NULL for backfilled rows. It owns its own schema-version row in the shared
 * `meta` table, mirroring `usage-db.ts`.
 */

export const ENGAGEMENT_SCHEMA_VERSION = '1';

export const ENGAGEMENT_DDL = `
CREATE TABLE IF NOT EXISTS engagement (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT    NOT NULL,
  assignment_id   TEXT,
  project_slug    TEXT,
  assignment_slug TEXT,
  stage           TEXT    NOT NULL DEFAULT 'implement',
  started_at      TEXT    NOT NULL,
  ended_at        TEXT,
  tokens_at_open  TEXT,
  tokens_at_close TEXT,
  close_reason    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_per_session
  ON engagement(session_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_engagement_session ON engagement(session_id);
CREATE INDEX IF NOT EXISTS idx_engagement_assignment ON engagement(assignment_id);
CREATE INDEX IF NOT EXISTS idx_engagement_slug ON engagement(project_slug, assignment_slug);
`;
