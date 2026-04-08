# Customizable Status Definitions and Kanban Ordering

**Date:** 2026-04-03
**Complexity:** small
**Tech Stack:** TypeScript, Express, React 18, Vite, Tailwind CSS

## Objective
Make the assignment status system fully configurable via `~/.syntaur/config.md`. Users can replace the default 6 statuses entirely, define custom display ordering for kanban swimlanes, and specify their own state machine transitions. All hardcoded status references become dynamic with sensible defaults.

## Files
| File | Action | Purpose |
|------|--------|---------|
| `src/utils/config.ts` | MODIFY | Add `statuses` config parsing (definitions, order, transitions, terminal) |
| `src/lifecycle/types.ts` | MODIFY | Widen `AssignmentStatus` to `string`, export default statuses/transitions as data |
| `src/lifecycle/state-machine.ts` | MODIFY | Accept configurable transition table, fall back to defaults |
| `src/lifecycle/transitions.ts` | MODIFY | Pass custom transition table through to `canTransition`/`getTargetStatus` |
| `src/dashboard/types.ts` | MODIFY | Make `ProgressCounts` a `Record<string, number> & { total: number }` |
| `src/dashboard/api.ts` | MODIFY | Add `GET /api/config/statuses` endpoint; make `buildMissionRollup`, `buildDependencyGraph`, `TRANSITION_DEFINITIONS`, and overview stats dynamic |
| `src/dashboard/api-write.ts` | MODIFY | Replace hardcoded `validStatuses` arrays with config-driven validation |
| `src/dashboard/help.ts` | MODIFY | Derive `statusGuide` from config instead of hardcoded array |
| `src/dashboard/parser.ts` | MODIFY | Make `ParsedStatus.progress` dynamic (`Record<string, number>`) |
| `src/dashboard/server.ts` | MODIFY | Wire the new `/api/config/statuses` endpoint |
| `dashboard/src/lib/kanban.ts` | MODIFY | Replace hardcoded column arrays with defaults, export function to get columns from config |
| `dashboard/src/components/StatusBadge.tsx` | MODIFY | Make `STATUS_META` extensible with fallback styling for unknown statuses |
| `dashboard/src/components/ProgressBar.tsx` | MODIFY | Derive `SEGMENTS` dynamically from status config instead of hardcoded array |
| `dashboard/src/hooks/useMissions.ts` | MODIFY | Widen `ProgressCounts` to `Record<string, number>`, widen `AssignmentSummary.status` to `string` |
| `dashboard/src/pages/AssignmentsPage.tsx` | MODIFY | Derive columns from fetched status config instead of hardcoded `ASSIGNMENT_BOARD_COLUMNS` |
| `dashboard/src/pages/MissionDetail.tsx` | MODIFY | Derive status override dropdown and filter options from config |
| `dashboard/src/pages/AssignmentDetail.tsx` | MODIFY | Derive status override dropdown options from config |
| `dashboard/src/hooks/useStatusConfig.ts` | CREATE | Hook to fetch and cache status config from `/api/config/statuses` |
| `src/lifecycle/frontmatter.ts` | MODIFY | Remove `as AssignmentStatus` cast, accept any string status |

## Tasks

### 1. Define status config schema and parsing
- **File:** `src/utils/config.ts` (MODIFY)
- **What:** Add a `StatusConfig` interface with: `statuses` (array of `{id, label, description, color?, icon?, terminal?}`), `order` (array of status ids for display), `transitions` (array of `{from, command, to}` objects). Add parsing logic in `readConfig()` to read a `statuses:` YAML section from config.md. When absent, return `null` so consumers use defaults.
- **Pattern:** Follow existing `agentDefaults` nested parsing in `parseFrontmatter()`. The YAML parser only handles 1-level nesting currently, so the `statuses` section will need array parsing (similar to how `parseDependsOn` works in `src/lifecycle/frontmatter.ts`).
- **Verify:** `node -e "import('./dist/utils/config.js').then(m => m.readConfig().then(console.log))"`

### 2. Widen AssignmentStatus type to string
- **File:** `src/lifecycle/types.ts` (MODIFY)
- **What:** Change `AssignmentStatus` from a union literal to `string`. Export `DEFAULT_STATUSES` as a const array of the 6 original statuses. Export `DEFAULT_TERMINAL_STATUSES` as a `Set<string>`. Keep `TERMINAL_STATUSES` but make it a `Set<string>` (no longer generic over the union). Change `TransitionCommand` to `string` as well, exporting `DEFAULT_COMMANDS` for the originals.
- **Pattern:** Keep exports backward-compatible -- existing code casting `as AssignmentStatus` will just work since it is now `string`.
- **Verify:** `npx tsc --noEmit`

### 3. Make state machine configurable
- **File:** `src/lifecycle/state-machine.ts` (MODIFY)
- **What:** Export `DEFAULT_TRANSITION_TABLE` (the current hardcoded map). Change `canTransition` and `getTargetStatus` to accept an optional custom transition table parameter. When omitted, use the default. Add `buildTransitionTable(transitions: Array<{from: string, command: string, to: string}>): Map<string, string>` factory function.
- **File:** `src/lifecycle/transitions.ts` (MODIFY)
- **What:** `executeTransition` calls `canTransition` and `getTargetStatus` at lines 58 and 66. These calls need to pass through the custom transition table when one is configured. Import `readConfig` and resolve the transition table at the start of `executeTransition`. Also update `checkDependencies` (line 37) to use `isTerminalStatus` with the config's terminal set rather than hardcoding `completed`.
- **Pattern:** Follow existing function signatures, just add optional parameter.
- **Verify:** `npx tsc --noEmit`

### 4. Make server-side ProgressCounts dynamic
- **File:** `src/dashboard/types.ts` (MODIFY)
- **What:** Change `ProgressCounts` from fixed fields to `Record<string, number> & { total: number }`. Update `HelpStatusGuideEntry.status` from `AssignmentStatus` to `string`. Update `AssignmentSummary.status`, `AssignmentDetail.status`, `AttentionItem.status` to `string`. Update `AssignmentTransitionAction.targetStatus` to `string`, `command` to `string`.
- **Pattern:** Keep the interface name and `total` field; just widen the type.
- **Verify:** `npx tsc --noEmit`

### 5. Make api.ts fully dynamic
- **File:** `src/dashboard/api.ts` (MODIFY)
- **What:**
  - In `buildMissionRollup` (line 609), initialize `progress` dynamically: start with `{total: 0}`, then increment `progress[assignment.status]` for each assignment (initializing to 0 if absent).
  - In `buildDependencyGraph` (line 693), generate classDef lines dynamically from status config color mappings instead of the 6 hardcoded lines at lines 711-716.
  - Make `TRANSITION_DEFINITIONS` (lines 66-114) configurable: derive from the status config's transitions instead of hardcoding the 7 commands. Custom transitions need label, description, and requiresReason fields.
  - In `getOverview` (lines 159-175), the `stats` object accesses `progress.in_progress`, `progress.blocked`, etc. by name. These need to work with a `Record<string, number>` — use optional chaining or default to 0 (e.g., `progress['in_progress'] ?? 0`).
  - Add a `getStatusConfig()` helper that reads config and merges with defaults.
  - Add a `GET /api/config/statuses` handler that returns the resolved status config (statuses, order, transitions).
- **Pattern:** Follow existing API handler pattern in `server.ts` (inline `app.get` with try/catch).
- **Verify:** `curl http://localhost:4800/api/config/statuses`

### 6. Wire status config endpoint in server
- **File:** `src/dashboard/server.ts` (MODIFY)
- **What:** Add `app.get('/api/config/statuses', ...)` route that calls the new `getStatusConfig()` from `api.ts` and returns the result as JSON.
- **Pattern:** Follow existing inline route handlers at lines 93-175 of `server.ts`.
- **Verify:** `curl http://localhost:4800/api/config/statuses`

### 7. Create dashboard status config hook
- **File:** `dashboard/src/hooks/useStatusConfig.ts` (CREATE)
- **What:** Create a `useStatusConfig()` hook that fetches `/api/config/statuses` and caches in React context or module-level state. Return the resolved config with defaults. Export the default status metadata (colors, icons, labels) so components can merge custom statuses over defaults.
- **Pattern:** Follow `useFetch` pattern from `useMissions.ts`. No websocket scope needed since config changes require server restart.
- **Verify:** `npx tsc --noEmit`

### 8. Make dashboard ProgressCounts and status types dynamic
- **File:** `dashboard/src/hooks/useMissions.ts` (MODIFY)
- **What:** Change `ProgressCounts` to `Record<string, number> & { total: number }`. Change `AssignmentSummary.status` to `string`. Change `AssignmentTransitionAction.command` and `targetStatus` to `string`. Change `AttentionItem.status` to `string`. Change `HelpResponse.statusGuide[].status` to `string`.
- **Pattern:** Minimal changes -- just widen the union types to `string`.
- **Verify:** `npx tsc --noEmit`

### 9. Make StatusBadge extensible
- **File:** `dashboard/src/components/StatusBadge.tsx` (MODIFY)
- **What:** Keep `STATUS_META` as default metadata. Add a fallback entry generator for unknown statuses that produces a neutral gray style with a generic circle icon and a title-cased label. The component already does `STATUS_META[status as keyof typeof STATUS_META] ?? STATUS_META.pending` -- change the fallback to use the generated neutral style instead of falling back to `pending`.
- **Pattern:** Follow existing `STATUS_META` shape.
- **Verify:** Visual check in dashboard with a custom status.

### 10. Make ProgressBar dynamic
- **File:** `dashboard/src/components/ProgressBar.tsx` (MODIFY)
- **What:** Instead of a hardcoded `SEGMENTS` array, accept segments via props or derive from the status config hook. Define a `DEFAULT_SEGMENTS` with the current colors. For unknown statuses, assign colors from a palette rotation. Iterate over actual keys present in the `progress` object (excluding `total`) in the config-defined order.
- **Pattern:** Keep the existing rendering logic, just make the segment list dynamic.
- **Verify:** Visual check in dashboard.

### 11. Make kanban columns dynamic
- **File:** `dashboard/src/lib/kanban.ts` (MODIFY)
- **What:** Rename current arrays to `DEFAULT_ASSIGNMENT_BOARD_COLUMNS` and `DEFAULT_MISSION_BOARD_COLUMNS`. Export a `getAssignmentColumns(configOrder?: string[]): string[]` function that returns custom order if provided, or the default.
- **Pattern:** Keep `moveItem` unchanged.
- **Verify:** `npx tsc --noEmit`

### 12. Update AssignmentsPage to use dynamic columns
- **File:** `dashboard/src/pages/AssignmentsPage.tsx` (MODIFY)
- **What:** Use the status config hook to get column order. Derive `ASSIGNMENT_COLUMNS` and `ASSIGNMENT_COLUMN_LABELS` from the config instead of the hardcoded constant. Update `VALID_STATUS_FILTERS` to be derived dynamically. The `normalizeStatusFilter` function should accept any string that appears in the config.
- **Pattern:** Follow existing column-building pattern at lines 26-39, just source from config.
- **Verify:** Visual check in dashboard.

### 13. Widen frontmatter parsing
- **File:** `src/lifecycle/frontmatter.ts` (MODIFY)
- **What:** Remove the `as AssignmentStatus` cast on line 120. The `status` field in `AssignmentFrontmatter` is already `AssignmentStatus` which is now `string`, so no cast needed.
- **Pattern:** Straightforward type narrowing removal.
- **Verify:** `npx tsc --noEmit`

### 14. Make write API status validation dynamic
- **File:** `src/dashboard/api-write.ts` (MODIFY)
- **What:** The mission status-override endpoint (line 725) hardcodes `const validStatuses = ['pending', 'active', 'blocked', 'failed', 'completed']`. The assignment status-override endpoint (line 759) hardcodes `const validStatuses = ['pending', 'in_progress', 'blocked', 'review', 'completed', 'failed']`. The transition endpoint (line 789) hardcodes the 7 valid commands. All three need to derive their valid values from the resolved status config.
- **Pattern:** Import `getStatusConfig()` from `api.ts` and use `config.statuses.map(s => s.id)` for valid statuses and `config.transitions.map(t => t.command)` for valid commands (deduplicated).
- **Verify:** `npx tsc --noEmit`

### 15. Make help statusGuide dynamic
- **File:** `src/dashboard/help.ts` (MODIFY)
- **What:** The `statusGuide` array (lines 155-188) hardcodes 6 entries with status, meaning, and useWhen. Derive this from the resolved status config. Default entries use the current text; custom statuses get a generic description derived from their label.
- **Pattern:** Import `getStatusConfig()`, map each status definition to a guide entry.
- **Verify:** `npx tsc --noEmit`

### 16. Make parser ParsedStatus.progress dynamic
- **File:** `src/dashboard/parser.ts` (MODIFY)
- **What:** `ParsedStatus.progress` (lines 120-128) is a fixed interface with 7 named fields. Change to `Record<string, number>` with a `total` field. Update `parseStatus` (line 137) to dynamically read progress fields from the frontmatter instead of hardcoding `completed`, `in_progress`, etc.
- **Pattern:** Iterate over the nested `progress` keys found in the frontmatter rather than calling `getNestedField` for each hardcoded status.
- **Verify:** `npx tsc --noEmit && npm test`

### 17. Make MissionDetail dropdowns dynamic
- **File:** `dashboard/src/pages/MissionDetail.tsx` (MODIFY)
- **What:** The status override dropdown (lines 96-102) hardcodes 5 `<option>` elements. The assignment status filter dropdown (lines 153-161) hardcodes 6 `<option>` elements. The stat cards (lines 115-119) hardcode `progress.in_progress`, `progress.review`, etc. All need to derive from the status config hook.
- **Pattern:** Use `useStatusConfig()` to get the status list. Map over statuses to render `<option>` elements. For stat cards, iterate over the config's display order and render cards dynamically with the configured label and an appropriate tone.
- **Verify:** Visual check in dashboard.

### 18. Make AssignmentDetail dropdown dynamic
- **File:** `dashboard/src/pages/AssignmentDetail.tsx` (MODIFY)
- **What:** The status override dropdown (around line 192) hardcodes `<option>` elements for the 6 assignment statuses. Derive from the status config hook.
- **Pattern:** Same as MissionDetail — use `useStatusConfig()` and map over statuses.
- **Verify:** Visual check in dashboard.

### 19. Update tests for dynamic statuses
- **What:** Several test files assert specific status strings and hardcoded `ProgressCounts` shapes. After widening types, update tests that will fail:
  - `src/__tests__/state-machine.test.ts` — Tests pass string literals to `canTransition`/`getTargetStatus`. These will still work since `AssignmentStatus` becomes `string`, but verify the tests still compile.
  - `src/__tests__/dashboard-api.test.ts` — Assertions on `progress.in_progress`, `progress.blocked` etc. need to account for `Record<string, number>` (property access still works).
  - `src/__tests__/dashboard-parser.test.ts` — `ParsedStatus.progress` shape changes to `Record<string, number>`, update assertions.
  - `src/__tests__/dashboard-write.test.ts` — Hardcoded status validation tests may need updating if valid statuses become dynamic.
  - `src/__tests__/adapter-templates.test.ts` — Asserts default status strings appear in rendered templates; should still pass.
- **Pattern:** Run `npm test` and fix any compilation or assertion failures.
- **Verify:** `npm test` — all tests pass

## Dependencies
- No new external packages required.
- The custom YAML parser in `config.ts` needs to support array-of-objects nesting (currently only supports flat and 1-level nesting). This is the main implementation risk. **Mitigation:** add a purpose-built `parseStatusConfig()` function that extracts the `statuses:` block and parses the YAML list structure directly using regex, rather than trying to generalize `parseFrontmatter()`. This follows the same approach used by `parseDependsOn()` and `parseExternalIds()` in `src/lifecycle/frontmatter.ts`.

## Verification
- `npx tsc --noEmit` -- full type check passes
- `npm test` -- all existing tests pass (Task 19)
- `curl http://localhost:4800/api/config/statuses` -- returns default config when no custom config exists
- Dashboard kanban board renders correctly with default statuses (no regression)
- Dashboard mission and assignment detail pages render status dropdowns correctly
- Add custom statuses to `~/.syntaur/config.md` and verify they appear in kanban columns, status badges, dropdowns, progress bars, and stat cards
- Override an assignment to a custom status via the dashboard and verify the write API accepts it
- Define custom transitions in config and verify the state machine enforces them
