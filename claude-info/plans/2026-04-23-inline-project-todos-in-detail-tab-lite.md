# Inline Project Todos in Project Detail Tab

**Date:** 2026-04-23
**Complexity:** small
**Assignment branch:** add-project-level-todos
**Builds on:** `2026-04-23-add-project-level-todos-lite.md` (Revisions 1–3, shipped)

## Objective

Remove the standalone `/projects/:slug/todos` page and host the project-todos UI directly inside the existing **Todos** tab on the project detail page. Add an inline "add todo" input on the project page so users don't have to navigate to a separate surface.

The backend, hook, and CLI from the prior plan remain unchanged — this is a pure frontend restructure.

## Assumptions & Constraints (what we are NOT doing)

- No backend changes. `createProjectTodosRouter`, the watcher branch, and lock keys stay exactly as shipped.
- No CLI changes.
- No changes to `useProjectTodos` hook or mutation helpers.
- No removal of `useProjectTodos` — the hook is consumed by the new inline UI.
- Retain the workspace `!msg.projectSlug` WebSocket filter in `useTodos`; it still matters because the broadcast shape is unchanged.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `dashboard/src/pages/ProjectTodosPage.tsx` | DELETE | Replaced by inline tab content |
| `dashboard/src/components/ProjectTodosPanel.tsx` | CREATE | Extracted inline UI: add input + filtered list + status menu + DnD reorder. Takes `projectId` as a prop. |
| `dashboard/src/pages/ProjectDetail.tsx` | MODIFY | Replace the "Open project todos →" link in the `todos` tab with `<ProjectTodosPanel projectId={project.slug} />` |
| `dashboard/src/App.tsx` | MODIFY | Remove `ProjectTodosPage` import and the two routes (`/projects/:slug/todos` and `/w/:workspace/projects/:slug/todos`) |
| `dashboard/src/lib/routes.ts` | MODIFY | Remove the `parts[2] === 'todos'` breadcrumb branch under `/projects/:slug/` (route no longer exists) |
| `dashboard/src/hotkeys/paletteIndex.ts` | MODIFY | Update per-project todos entries to route to `/projects/:slug?tab=todos` (deep-link to the tab) instead of the removed page |
| `dashboard/src/pages/ProjectDetail.tsx` | MODIFY (2nd) | Read `?tab=` query string on mount and initialize `tab` state from it so palette deep-links land on the Todos tab. Write the tab to the URL on change so reload preserves selection. |
| `docs/protocol/file-formats.md` | MODIFY | Update §19b: remove the `/api/projects/:projectId/todos` page route mention if present; keep the API endpoint mention. Note the UI is now inside the project detail view's Todos tab. |

## Tasks

### 1. Extract `ProjectTodosPanel` component
- **File:** `dashboard/src/components/ProjectTodosPanel.tsx` (CREATE)
- **What:** Move the body of `ProjectTodosPage.tsx` into a component that takes `{ projectId: string }` as props (no `useParams`). Drop the outer page-level layout wrapper. Keep: stats strip, add input, search/status/tag filters, DnD-sorted list, status menu, copy-id, `?focus=<id>` deep-link behavior (still useful inside the tab).
- **Verify:** `npm run build:dashboard`

### 2. Wire panel into ProjectDetail Todos tab
- **File:** `dashboard/src/pages/ProjectDetail.tsx` (MODIFY)
- **What:** Replace the existing todos tab content (the `SectionCard` with "Open project todos →" link) with `<ProjectTodosPanel projectId={project.slug} />`. Keep the tab label "Todos" and value `'todos'`.
- **Verify:** `npm run build:dashboard`

### 3. Deep-link the tab via `?tab=`
- **File:** `dashboard/src/pages/ProjectDetail.tsx` (MODIFY)
- **What:** On mount, read `useSearchParams().get('tab')`. If it's one of the known tab values, initialize the `tab` state from it (falling back to `'overview'`). In the `onValueChange` handler, update the URL with `setSearchParams({ tab })`. Ensures palette deep-links to `/projects/foo?tab=todos` open the right tab and browser reload preserves state.
- **Verify:** Manually verify `/projects/<slug>?tab=todos` opens the Todos tab.

### 4. Delete old page + remove routes
- **Files:** `dashboard/src/pages/ProjectTodosPage.tsx` (DELETE), `dashboard/src/App.tsx` (MODIFY)
- **What:** Delete the file. Remove the `import { ProjectTodosPage } from './pages/ProjectTodosPage';` line and both `<Route path="/projects/:slug/todos" .../>` plus `<Route path="/w/:workspace/projects/:slug/todos" .../>` entries.
- **Verify:** `npm run build:dashboard`; grep for `ProjectTodosPage` returns nothing.

### 5. Remove breadcrumb branch
- **File:** `dashboard/src/lib/routes.ts` (MODIFY)
- **What:** Remove the `else if (parts[2] === 'todos') { ... title = 'Todos'; }` branch added in the prior plan. That path no longer exists.
- **Verify:** `npm run build:dashboard`; navigate `/projects/<slug>?tab=todos` — breadcrumb shows just the project (no "Todos" crumb, since it's a tab within the project page now).

### 6. Repoint palette entries
- **File:** `dashboard/src/hotkeys/paletteIndex.ts` (MODIFY)
- **What:** Change the per-project todos palette entry route from `${projectWs}/projects/${m.slug}/todos` to `${projectWs}/projects/${m.slug}?tab=todos`. Keep `type: 'todo'` (reused in the prior plan). Subtitle remains `${m.slug} · project`.
- **Verify:** `npm run build:dashboard`; open palette, jump to a project-todos entry, land on the project detail page with the Todos tab active.

### 7. Docs
- **File:** `docs/protocol/file-formats.md` (MODIFY around §19b)
- **What:** Update the project-todos section to reflect that the UI is now embedded in the project detail view (Todos tab). The API endpoint tree under `/api/projects/:projectId/todos` is unchanged — only the dashboard page is gone.
- **Verify:** grep for "project-todos page" or "`/projects/<slug>/todos`" in the doc and update any references.

## Dependencies

- None new. Reuses `useProjectTodos` + mutation helpers from `dashboard/src/hooks/useProjectTodos.ts`.

## Verification

```
npm run typecheck
npm run test
npm run build:dashboard
```

Manual smoke:
- From palette, jump to a project's todos entry → project detail page opens with Todos tab selected.
- Add a todo via the inline input → appears immediately.
- Navigate away and back → todos persist; WebSocket refresh works.
- Reload `/projects/<slug>?tab=todos` → still on Todos tab.
- `/projects/<slug>/todos` (old URL) → 404 / Overview fallback (acceptable; this is a hard removal per user direction).

## Risks / Open Questions

- **Hard URL removal.** Bookmarked `/projects/<slug>/todos` URLs break. If that matters, the panel should also be reachable via a tiny redirect route that rewrites to `?tab=todos`. Not included by default — add only if the user flags bookmarked usage.
- **Tab state in URL.** Adding `setSearchParams({ tab })` writes to the URL on every tab click, creating history entries. Use `setSearchParams(..., { replace: true })` so the tab change replaces rather than pushes a new entry, keeping the back-button sensible.
- **Component size.** The extracted panel will still be ~380 lines (copy-paste from `WorkspaceTodosPage`). Acceptable for this pass; deduplicating with `WorkspaceTodosPage` into a generic list is a separate refactor not in scope.
