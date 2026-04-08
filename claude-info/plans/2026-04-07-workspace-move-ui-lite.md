# Move Mission Between Workspaces via Dashboard UI

**Date:** 2026-04-07
**Complexity:** small
**Tech Stack:** TypeScript, React 18, Tailwind CSS, Express 5, markdown frontmatter data store

## Objective
Add a "Move to Workspace" dropdown on the MissionDetail page and in the mission StructuredEditor, backed by a new API endpoint that updates the `workspace` frontmatter field. Since assignments, servers, and sessions inherit workspace from their parent mission, moving the mission moves everything.

## Files
| File | Action | Purpose |
|------|--------|---------|
| `src/dashboard/api-write.ts` | MODIFY | Add `POST /api/missions/:slug/move-workspace` endpoint |
| `dashboard/src/pages/MissionDetail.tsx` | MODIFY | Add "Move to Workspace" dropdown in action bar |
| `dashboard/src/lib/documents.ts` | MODIFY | Add `workspace` field to `MissionEditorState`, parse/update functions |
| `dashboard/src/components/MarkdownEditor.tsx` | MODIFY | Add workspace dropdown to mission StructuredEditor form |

## Tasks

### 1. Add move-workspace API endpoint
- **File:** `src/dashboard/api-write.ts` (MODIFY)
- **What:** Add `POST /api/missions/:slug/move-workspace` that accepts `{ workspace: string | null }`. Read the mission.md, call `setTopLevelField(content, 'workspace', workspace)` (null removes it for ungrouped), set `updated` timestamp, write back. Return updated mission.
- **Pattern:** Follow the `status-override` endpoint at lines 717-744 exactly -- same structure, same error handling, same response shape.
- **Verify:** `curl -X POST http://localhost:7778/api/missions/<slug>/move-workspace -H 'Content-Type: application/json' -d '{"workspace":"test"}'`

### 2. Add "Move to Workspace" dropdown on MissionDetail
- **File:** `dashboard/src/pages/MissionDetail.tsx` (MODIFY)
- **What:** Add a `<select>` dropdown next to the existing "Set Status..." dropdown (line 91-104). Import `useWorkspaces` from `useMissions.ts`. Options: each workspace name + "Ungrouped" (value null). On change, POST to `/api/missions/${slug}/move-workspace`. No redirect needed -- WebSocket file watcher triggers automatic refetch.
- **Pattern:** Follow the "Set Status..." `<select>` at lines 91-104 and `handleStatusOverride` at line 44-49.
- **Verify:** Open MissionDetail in browser, confirm dropdown appears with workspace options, select a workspace and verify mission moves.

### 3. Add workspace to mission StructuredEditor
- **File:** `dashboard/src/lib/documents.ts` (MODIFY)
- **What:** Add `workspace: string` to `MissionEditorState` interface (line 8-16). In `parseMissionEditorState` (line 193), add `workspace: getScalar(model, 'workspace')`. In `updateMissionContent` (line 206), add `setScalar(model, 'workspace', next.workspace || null)`.
- **Pattern:** Follow the existing fields like `tags` in the same functions.
- **Verify:** TypeScript compilation passes.

### 4. Add workspace dropdown to StructuredEditor form
- **File:** `dashboard/src/components/MarkdownEditor.tsx` (MODIFY)
- **What:** In the mission StructuredEditor block (lines 179-232), add a `<Field label="Workspace">` with a `<select>` after the Tags field. Fetch workspace list using `useWorkspaces()` hook. Include an empty/"Ungrouped" option.
- **Pattern:** Follow the `<Field label="Tags">` pattern at lines 213-220. Use `normalizeEditorContent` on change like other fields.
- **Verify:** Open Create/Edit Mission form, confirm workspace dropdown appears and persists selection.

## Dependencies
- None. All utilities (`setTopLevelField`, `useWorkspaces`, `getScalar`/`setScalar`) already exist.

## Verification
- `cd /Users/brennen/syntaur && npx tsc --noEmit` -- TypeScript compiles
- Start dev server and test: move a mission to a different workspace via MissionDetail dropdown, confirm it disappears from old workspace view and appears in new one
- Edit a mission via StructuredEditor, change workspace field, save, confirm frontmatter updated
