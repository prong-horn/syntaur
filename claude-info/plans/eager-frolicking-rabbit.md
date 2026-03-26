# Plan: SessionEnd Hook + Rename "abandoned" to "stopped"

## Context

Agent sessions show as "active" in the dashboard after a Claude Code session has been closed. Two fixes are needed:
1. A `SessionEnd` hook to automatically mark sessions as "stopped" when Claude exits
2. Rename the "abandoned" status to "stopped" throughout the codebase

The reconciliation added yesterday handles assignment-level staleness (assignment moved to completed/review/failed), but doesn't catch the case where the Claude session simply exits while the assignment is still `in_progress`. The SessionEnd hook fills that gap.

## Changes

### 1. Rename "abandoned" to "stopped" (6 source files + docs)

**Backend types:**
- `src/dashboard/types.ts:346` — Change type union to `'active' | 'completed' | 'stopped'`
- `dashboard/src/types.ts:45` — Same change (frontend mirror)

**Backend logic:**
- `src/dashboard/agent-sessions.ts` — Change `'abandoned'` to `'stopped'` in reconciliation (line ~238) and comment (line ~203)
- `src/dashboard/api-agent-sessions.ts` — Update validation array (line 91) and error message (line 92)

**Frontend:**
- `dashboard/src/pages/AgentSessionsPage.tsx:17` — Filter label: `{ label: 'Stopped', value: 'stopped' }`
- `dashboard/src/components/StatusBadge.tsx` — Add a `stopped` entry to `STATUS_META` (use a neutral gray/slate style with `StopCircle` icon from lucide)

**Docs:**
- `docs/protocol/file-formats.md:198` — Replace "abandoned" with "stopped"
- `claude-info/plans/` references — update but non-critical

### 2. Add `stopped` to StatusBadge

The StatusBadge component currently has no entry for "abandoned" (it falls through to `pending`). Add a proper `stopped` entry with a neutral gray/slate style.

### 3. Create SessionEnd hook script

**New file:** `plugin/hooks/session-cleanup.sh`

The script will:
1. Read `cwd` from the JSON stdin (`SessionEnd` provides `cwd`, `session_id`, `reason`)
2. Look for `.syntaur/context.json` at that `cwd`
3. If found, extract `sessionId`, `missionSlug`, and `missionDir`
4. Try the dashboard API first: `PATCH /api/agent-sessions/:sessionId/status` with `{"status": "stopped", "missionSlug": "..."}`
   - Port discovery: try `~/.syntaur/dashboard-port`, fall back to 4800
5. If API fails (dashboard not running), directly edit `_index-sessions.md` with sed:
   - Replace `| active |` with `| stopped |` on the matching sessionId line
   - Update the `activeSessions:` frontmatter count
6. Also update the assignment-level Sessions table in `assignment.md` (set status to `stopped`, fill in Ended timestamp)
7. Always exit 0

### 4. Register the hook in hooks.json

**Modify:** `plugin/hooks/hooks.json`

Add `SessionEnd` alongside existing `PreToolUse`:

```json
{
  "description": "Syntaur protocol hooks",
  "hooks": {
    "PreToolUse": [ ... existing ... ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/session-cleanup.sh",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

### 5. Write dashboard port file

**Modify:** `src/dashboard/server.ts`

After the server starts listening, write the port to `~/.syntaur/dashboard-port` so hooks and skills can discover it. Clean it up on server close.

## Key files

| File | Action |
|------|--------|
| `plugin/hooks/session-cleanup.sh` | **new** — SessionEnd hook script |
| `plugin/hooks/hooks.json` | modify — register SessionEnd |
| `src/dashboard/types.ts` | modify — type rename |
| `dashboard/src/types.ts` | modify — type rename |
| `src/dashboard/agent-sessions.ts` | modify — reconciliation rename |
| `src/dashboard/api-agent-sessions.ts` | modify — validation rename |
| `dashboard/src/pages/AgentSessionsPage.tsx` | modify — filter rename |
| `dashboard/src/components/StatusBadge.tsx` | modify — add stopped style |
| `src/dashboard/server.ts` | modify — port file write |
| `docs/protocol/file-formats.md` | modify — doc rename |
| `plugin/skills/complete-assignment/SKILL.md` | already updated yesterday |

## Verification

1. `npx tsc --noEmit` — no new errors in changed files
2. `npx vitest run src/__tests__/dashboard-api.test.ts` — passes
3. Manual: start session with `/grab-assignment`, exit Claude, check `_index-sessions.md` shows `stopped`
4. Dashboard: "Stopped" filter works, StatusBadge renders correctly
5. Port file: start dashboard → `~/.syntaur/dashboard-port` exists; stop → cleaned up
