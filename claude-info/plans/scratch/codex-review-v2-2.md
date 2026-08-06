FINDING 1  
SEVERITY: major  
LOCATION: src/dashboard/agent-sessions.ts:996  
ISSUE: The pinned-first ORDER BY invalidates the existing `idx_sessions_started` optimization. The default paged query now plans as a full `SCAN s` plus `USE TEMP B-TREE FOR ORDER BY`, so every page scans and sorts the whole sessions table—negating server-side paging at scale.  
FIX: Re-ensure expression indexes after migrations in `src/dashboard/session-db.ts` (not `SCHEMA_SQL`, since v9 upgrades lack these columns): indexes on `(pinned_at IS NULL, pinned_at DESC, started DESC, session_id ASC)` and the corresponding `started ASC` form. Add an `EXPLAIN QUERY PLAN` regression test.

VERDICT: REQUEST CHANGES