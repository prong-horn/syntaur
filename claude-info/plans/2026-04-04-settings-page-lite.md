# Settings Page: Status Config UI

**Date:** 2026-04-04
**Complexity:** medium
**Tech Stack:** TypeScript, React (Vite), Tailwind CSS, Lucide icons, Express backend

## Objective
Add a Settings page to the Syntaur dashboard where users can view and edit status definitions, ordering, and transitions via UI instead of manually editing `~/.syntaur/config.md`. Includes a write API endpoint and cache invalidation.

## Files
| File | Action | Purpose |
|------|--------|---------|
| `src/dashboard/server.ts` | MODIFY | Add `POST /api/config/statuses` route |
| `src/utils/config.ts` | MODIFY | Add `writeStatusConfig()` to serialize status config back into `config.md` frontmatter |
| `src/dashboard/api.ts` | MODIFY | Export `clearStatusConfigCache` (already exists, just confirm reachable from server) |
| `dashboard/src/pages/SettingsPage.tsx` | CREATE | Settings page with status definitions, order, and transitions editors |
| `dashboard/src/components/AppShell.tsx` | MODIFY | Add Settings nav item to `NAV_ITEMS` |
| `dashboard/src/lib/routes.ts` | MODIFY | Add `/settings` to `SIDEBAR_SECTIONS` and routing logic |
| `dashboard/src/App.tsx` | MODIFY | Add `/settings` route |
| `dashboard/src/hooks/useStatusConfig.ts` | MODIFY | Add `invalidateStatusConfigCache()` export to clear module-level cache after saves |

## Tasks

### 1. Add `writeStatusConfig()` to config utils
- **File:** `src/utils/config.ts` (MODIFY)
- **What:** Add a function that takes a `StatusConfig` object and writes it into `~/.syntaur/config.md`. Must read the existing file first, replace only the `statuses:` block in frontmatter (preserving `version`, `defaultMissionDir`, `agentDefaults`, and markdown body below frontmatter). If file doesn't exist, create it with default non-status fields plus the new statuses block. Also add a `deleteStatusConfig()` that removes the `statuses:` block (for reset-to-defaults).
- **Pattern:** Follow the YAML serialization style already used in the existing frontmatter (2-space indent, `- id:` list items). Look at `parseStatusConfig()` in the same file for the expected format.
- **Verify:** `npx tsx -e "import { writeStatusConfig } from './src/utils/config.js'; ..."` — manual test or unit test

### 2. Add `POST /api/config/statuses` endpoint
- **File:** `src/dashboard/server.ts` (MODIFY)
- **What:** Add a POST endpoint that accepts `{ statuses, order, transitions }` JSON body (matching `StatusConfig` shape), calls `writeStatusConfig()`, then calls `clearStatusConfigCache()` so subsequent reads pick up changes. Also add `DELETE /api/config/statuses` that calls `deleteStatusConfig()` and clears cache (for reset-to-defaults). Return the new resolved config from both endpoints.
- **Pattern:** Follow the existing `GET /api/config/statuses` handler pattern at line 124 of `server.ts`. Import `clearStatusConfigCache` from `./api.js` and new write function from `../utils/config.js`.
- **Verify:** `curl -X POST http://localhost:4800/api/config/statuses -H 'Content-Type: application/json' -d '{"statuses":[...],"order":[...],"transitions":[...]}'`

### 3. Add `invalidateStatusConfigCache()` to frontend hook
- **File:** `dashboard/src/hooks/useStatusConfig.ts` (MODIFY)
- **What:** Export a function that sets `cachedConfig = null` and `fetchPromise = null` so the next `useStatusConfig` call refetches from the server. The Settings page will call this after a successful save.
- **Pattern:** Module-level cache variables already exist at lines 42-43.
- **Verify:** TypeScript compiles without error

### 4. Add `/settings` to sidebar and routing
- **File:** `dashboard/src/components/AppShell.tsx` (MODIFY)
- **What:** Add a Settings entry to `NAV_ITEMS` array, using `Settings` icon from lucide-react. Place it after Help (bottom of nav).
- **File:** `dashboard/src/lib/routes.ts` (MODIFY)
- **What:** Add `'/settings'` to `SIDEBAR_SECTIONS`, add routing case in `getSidebarSection()` and `buildShellMeta()`.
- **File:** `dashboard/src/App.tsx` (MODIFY)
- **What:** Import `SettingsPage` and add `<Route path="/settings" element={<SettingsPage />} />`.
- **Pattern:** Follow existing nav items in `AppShell.tsx` (line 19-28), sidebar sections in `routes.ts`, and route definitions in `App.tsx`.
- **Verify:** Settings link appears in sidebar and navigates correctly

### 5. Create SettingsPage component
- **File:** `dashboard/src/pages/SettingsPage.tsx` (CREATE)
- **What:** Build the Settings page with three `SectionCard` sections:
  1. **Status Definitions** — Table showing id, label, color, terminal flag. Add/remove/edit rows inline. Color uses a text input (color name like "gray", "blue", "green").
  2. **Status Order** — List with move-up/move-down buttons per item (no drag library needed).
  3. **Transitions** — Table showing from, command, to. Add/remove rows with dropdowns populated from current definitions.
  4. **Config state banner** — Show whether using defaults or custom config. "Reset to defaults" button that calls `DELETE /api/config/statuses`.
  5. **Save button** — POSTs to `/api/config/statuses`, calls `invalidateStatusConfigCache()` on success, shows success/error feedback.
- **Pattern:** Follow `ServersPage.tsx` for fetch/mutate patterns (inline `fetch()` calls, `useState` for form state). Use `SectionCard`, `LoadingState`, `ErrorState` components. Use `useStatusConfig` hook for initial data load.
- **Verify:** `npm run build:dashboard` succeeds; page renders at `/settings`

## Dependencies
- No new packages needed (move-up/move-down buttons avoid drag-and-drop library)
- `lucide-react` already has `Settings` icon

## Verification
- `npm run build` — full build succeeds
- `npm run build:dashboard` — frontend build succeeds  
- Navigate to `/settings` in dashboard — page loads with current config
- Edit a status definition and save — changes persist in `~/.syntaur/config.md`
- Reset to defaults — `statuses:` block removed from config file
- Other pages (Overview, Assignments) reflect updated status config after save
