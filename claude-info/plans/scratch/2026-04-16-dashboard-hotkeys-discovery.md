# Dashboard Keyboard Shortcuts & Command Palette — Discovery Findings

## Metadata
- **Date:** 2026-04-16
- **Complexity:** large
- **Tech Stack:** React 18 + TypeScript + Vite 6 + react-router-dom v7, Tailwind CSS 3, Radix UI primitives (dialog, alert-dialog, tabs, tooltip), lucide-react icons, @dnd-kit, mermaid. No fuzzy-search library currently installed.

## Complexity Reasoning
Assessed as **large** because:
- 15+ files touched across `components`, `pages`, `hooks`, plus a new `hotkeys` subsystem (context, provider, 5+ primitives).
- Introduces a cross-cutting keyboard subsystem that must coexist with page state (list selection, filter focus, prev/next) and modal/dialog focus traps.
- Needs a new global data layer for command-palette indexing (missions, assignments, playbooks, servers, todos are currently loaded per-page — palette needs them available anywhere).
- Requires adding or writing a fuzzy matcher; no such dependency exists yet.
- Cheatsheet, command palette, and g-chord layer are all new UX surfaces that interact with the existing Radix Dialog focus model.

## Objective
Add a complete keyboard navigation layer to the Syntaur dashboard: a Cmd/Ctrl+K command palette with fuzzy search across all entity types, g-prefix chord navigation, single-key actions on list/detail pages, a `?` cheatsheet, and `Shift+T` theme toggle — all respecting input/contenteditable focus (except Esc and Cmd+K) and coexisting with Radix modal focus/ESC behavior.

## User's Request (exact)
Add keyboard shortcuts to the Syntaur dashboard UI:
1. Command palette `Cmd+K`/`Ctrl+K` with fuzzy search across missions, assignments, playbooks, servers, todos, and pages.
2. Global g-chord navigation: `g o` Overview, `g m` Missions, `g a` Assignments, `g t` Todos, `g s` Servers, `g !` Attention, `g ,` Settings.
3. `?` opens cheatsheet modal.
4. List navigation on tables (missions, assignments, todos): `j`/`k` move selection, `Enter`/`o` open, `/` focuses filter, `r` refresh.
5. Assignment detail: `e` edit, `p` edit plan, `h` append handoff, `d` append decision, `s` edit scratchpad, `[`/`]` prev/next assignment in mission.
6. Mission detail: `a` new assignment, `e` edit mission.
7. `Esc` closes modals/drawers.
8. `Shift+T` toggles light/dark theme.
Scope: dashboard only (`/Users/brennen/syntaur/dashboard`). Do not modify CLI. Shortcuts must not fire while user is typing in input/textarea/contenteditable, except `Esc` and `Cmd+K`.

## Codebase Overview
### Routing (react-router-dom v7, BrowserRouter)
- `src/App.tsx` defines a single `<BrowserRouter>` with all routes. Every page is a direct child of one `<Layout />` element (wrapping `<AppShell>`), so any provider placed above `<Routes>` (or between `BrowserRouter` and `Routes`) is mounted for the entire app lifetime. Navigation is done via `<Link>` and `useNavigate()`.
- Routes have both root-scope (`/missions/:slug/...`) and workspace-scope (`/w/:workspace/missions/:slug/...`) variants. A hook `useWorkspacePrefix()` (`src/hooks/useMissions.ts:375`) returns `/w/<workspace>` or `''` depending on the current URL — the hotkey system needs to use the same prefix when constructing navigation targets.
- `src/lib/routes.ts` has `buildShellMeta` and `getSidebarSection` utilities; a parallel utility for g-chord route resolution (given current workspace prefix) will need to be added.

### Theme (src/theme.tsx)
- Context-based. `initTheme()` runs once in `main.tsx:7` before render. `ThemeProvider` wraps `<App />`. `useTheme()` exposes `resolvedTheme`, `toggleTheme()`, `setTheme()`. `toggleTheme` already writes to `localStorage` under key `syntaur-theme` and toggles the `dark` class on `document.documentElement`. `Shift+T` handler simply calls `toggleTheme()`.
- `TopBar.tsx:72` already wires a theme-toggle button with identical behavior, so there's a reference implementation to mirror.

### UI Component Library
- No shadcn/cmdk/kbar. The project uses **Radix primitives directly** (@radix-ui/react-dialog, @radix-ui/react-alert-dialog, @radix-ui/react-tabs, @radix-ui/react-tooltip) and has thin wrappers in `src/components/ui/` (`dialog.tsx`, `alert-dialog.tsx`, `tooltip.tsx`) styled with Tailwind. Tailwind tokens use semantic names (`bg-background`, `text-foreground`, `border-border`, `bg-card`, `bg-muted`, `text-muted-foreground`, `text-primary`). Common pattern: `shell-action` utility class, `editor-input` for inputs.
- Radix `<Dialog>` auto-handles `Esc` to close (via its own focus trap / `onOpenChange(false)`), so the requirement 7 is largely satisfied by existing modals. The new palette and cheatsheet should be built on the same `Dialog` primitive so they inherit Esc-to-close and focus-trap behavior. A global key handler must NOT also call close on Esc (that would double-fire) — the handler should be a no-op for Esc when a Radix dialog is open.
- Icons from `lucide-react`. Use `Command`, `Search`, `CornerDownLeft`, `ArrowUp`, `ArrowDown`, etc.

### Data Hooks (all in `src/hooks/`)
Every hook is page-local today — none are mounted at `AppShell`/`Layout` level. All share a `useWebSocket` subscription and refetch on relevant ws events.

- `useMissions()` → `MissionSummary[]` (`/api/missions`) — list of all missions; used by MissionList, ServersPage, AppShell sidebar (indirectly via `useWorkspaces`).
- `useAssignmentsBoard()` → `AssignmentsBoardResponse { assignments: AssignmentBoardItem[] }` (`/api/assignments`) — flat list across missions with `missionSlug`, `missionTitle`, `slug`, `id`, `title`.
- `usePlaybooks()` → `PlaybooksResponse { playbooks: PlaybookSummary[] }` (`/api/playbooks`) — each has `slug`, `name`, `description`, `tags`. Detail route is `/playbooks/:slug`.
- `useServers()` → `ServersResponse { sessions: TrackedSession[] }` (`/api/servers`). Each session has a `name` but there is **no detail route**; `ServersPage` renders an expandable list. Palette selection should navigate to `/servers` (and ideally focus/scroll to the row — optional).
- `useAllTodos()` → `TodoAggregateResponse { workspaces: TodoListResponse[] }` (`/api/todos`). Each todo has `id`, `description`, `tags`, `status`, `session` but **no detail route** — selecting it should navigate to `/todos` with the id in a URL query (new behavior to add) or simply focus the row.
- `useStatusConfig()` — module-level cached; safe to call anywhere.
- `useMission(slug)` — on `AssignmentDetail`, this already loads `mission.assignments` (the ordered list the component uses for dependency enrichment); this same array supplies the prev/next navigation list for `[` / `]`.

**Consequence for palette:** the palette needs missions, assignments, playbooks, and todos available globally. Two viable approaches:
1. **Lazy fetch on palette open:** mount the four data hooks inside the `CommandPalette` component; they fire when the palette opens. Pro: zero cost when palette isn't open. Con: visible loading spinner on first open.
2. **Eager global fetch:** mount the hooks in a `HotkeyProvider` that wraps the routed tree. Pro: instant palette. Con: data always loaded even when not needed.

Given the existing WebSocket-driven refresh model and that most pages already trigger several of these same fetches, eager global fetch adds modest cost (4 GET requests on initial page load) and is simplest. **Recommend option 2**, with a slight refinement: fetch only when the user first presses `Cmd+K` or `g` (lazy-then-sticky).

### Tables & Lists — How They Render Rows
- **MissionList** (`src/pages/MissionList.tsx`): three views (cards, table, kanban) controlled by `?view=` query param. The table branch renders `<tr>` rows at line 228 with `<Link to={...mission slug...}>` inside the first cell. Rows are not currently focusable (`tabIndex` not set), and there is no "selected row" concept.
- **AssignmentsPage** (`src/pages/AssignmentsPage.tsx`): three views (table, list, kanban), default kanban. Table rows at 527 have a `<Link>` in the first cell; other cells use a `<select>` and plain text. No row selection.
- **TodosPage** (`src/pages/TodosPage.tsx`): custom rendered list with copy-id buttons and status menu. No row selection.

**Implication:** "list navigation" is a new concept. The implementation needs:
- A page-level `useListSelection(items, opts)` hook that tracks `selectedIndex`, responds to `j`/`k` within the hotkey scope, and scrolls the row into view.
- Each row must render a stable ref (data-attribute selector like `data-hotkey-row={index}`) so the hook can locate and scroll/click it.
- `Enter`/`o` triggers navigation to a detail route; for missions that's `/missions/:slug`, for assignments `/missions/:ms/assignments/:as`, for todos there is no detail route so `Enter` could toggle status or be a no-op.
- `/` focuses the filter input: the existing `SearchInput` (used by MissionList and AssignmentsPage) doesn't currently accept a ref. Two options: (a) add `inputRef` prop to `SearchInput` and pass it through; (b) use a `data-hotkey-filter` attribute on the input and `document.querySelector` to focus it. Option (a) is cleaner and more React-idiomatic.
- `r` calls the page's `refetch()` — each list hook already exposes this.
- `TodosPage` uses a raw `<input>` not `SearchInput` (line 42 of TodosPage; the code re-implements a search input). This page needs the same `data-hotkey-filter` or ref treatment.

### Assignment Detail — `e`/`p`/`h`/`d`/`s`/`[`/`]`
- `src/pages/AssignmentDetail.tsx:51` loads `useAssignment(slug, aslug)`; `:52` loads `useMission(slug)` which gives `mission.assignments` — a slug-ordered list used already for dependency enrichment. **Prev/next in mission:** find index of `aslug` in `mission.assignments.map(a => a.slug)`, navigate to the sibling slug using `wsPrefix`. No extra fetch needed.
- Edit routes are separate react-router routes (NOT modals): `.../edit`, `.../plan/edit`, `.../scratchpad/edit`, `.../handoff/edit`, `.../decision-record/edit`. The shortcut handlers call `navigate(wsPrefix + path)`.
- Acceptance criteria checkboxes, transition dialog, and confirm dialog are all live in this page — the hotkey scope must NOT capture keys while any dialog is open (see "Focus rules" below).

### Mission Detail — `a` / `e`
- `src/pages/MissionDetail.tsx` currently has no edit button link at the top (but the `EditMission` route exists at `/missions/:slug/edit`). The `a` handler navigates to `${wsPrefix}/missions/${slug}/create/assignment`; the `e` handler navigates to `${wsPrefix}/missions/${slug}/edit`.

### Keyboard Handling Already In Place
- `src/components/DependencyGraph.tsx:95` — attaches `keydown` listeners to individual SVG `<g>` elements, not `window`. No global conflict.
- `src/components/AppShell.tsx:263` — inline `onKeyDown` on the new-workspace `<input>` for Esc. Scoped to a single input; no conflict.
- `src/pages/WorkspaceTodosPage.tsx`, `src/pages/TodosPage.tsx` — inline input handlers; no conflict.
- **No global/window-level hotkey handler exists anywhere.** This is greenfield.

### Fuzzy Search — No Library Installed
Verified `dashboard/package.json` has no `fuse.js`, `cmdk`, `kbar`, `fzf`, or similar. Need to either (a) add `fuse.js` (smallest mainstream option, ~10KB gzip) or (b) hand-roll a simple substring/subsequence ranker. Given ~10–500 items expected (missions+assignments+playbooks+todos+servers+pages), a hand-rolled subsequence ranker is ~40 LOC and avoids a new dependency. Recommend hand-roll.

## Files That Will Need Changes
| File | Current Purpose | Needed Change |
|------|-----------------|---------------|
| `dashboard/src/App.tsx` | Router shell | Wrap `<Routes>` (or inside BrowserRouter above Layout) with `<HotkeyProvider>` so all pages share one global listener. Possibly add top-level `<CommandPalette>` and `<HotkeyCheatsheet>` components. |
| `dashboard/src/main.tsx` | Boots ThemeProvider + App | No change (HotkeyProvider placed inside App because it needs `useNavigate`/`useLocation` from router context). |
| `dashboard/src/components/AppShell.tsx` | Shell/sidebar layout | Optionally render the palette/cheatsheet here to stay inside the router context; add a visible "press ⌘K" affordance (optional but recommended). |
| `dashboard/src/components/TopBar.tsx` | Top bar with theme toggle + actions | Optionally expose a `⌘K` search affordance button. |
| `dashboard/src/components/SearchInput.tsx` | Filter input used across pages | Add `inputRef` prop (forwardRef) so `/` can focus it from the hotkey scope. |
| `dashboard/src/pages/MissionList.tsx` | Mission list/table/kanban | Integrate `useListSelection` over `filtered`; mark rows with ref attrs; pass inputRef to `SearchInput`; register refresh+filter+nav actions for this page. |
| `dashboard/src/pages/AssignmentsPage.tsx` | Assignments list/table/kanban | Same: selection on `sortedItems`, row refs, inputRef on SearchInput, `r` refresh. |
| `dashboard/src/pages/TodosPage.tsx` | Todos table | Same; replace raw input with `SearchInput` OR expose its ref; register selection over `filtered`; decide Enter behavior (cycle status or no-op). |
| `dashboard/src/pages/AssignmentDetail.tsx` | Assignment detail page | Register `e`,`p`,`h`,`d`,`s`,`[`,`]` shortcuts via `useScopedHotkeys`. Uses `mission.assignments` for prev/next. |
| `dashboard/src/pages/MissionDetail.tsx` | Mission detail page | Register `a`, `e` shortcuts. |
| `dashboard/src/pages/Help.tsx` | Help page | Add a "Keyboard shortcuts" section that mirrors the cheatsheet content (or link to it). |
| **NEW** `dashboard/src/hotkeys/HotkeyProvider.tsx` | — | Global provider: single `window` keydown listener, scope stack, g-chord buffer with 1500ms timeout, focus-filter (skip when typing except Esc/Cmd+K/g-sequence-completion). |
| **NEW** `dashboard/src/hotkeys/useHotkey.ts` | — | Registers a binding (sequence + handler + scope + description) for cheatsheet aggregation. |
| **NEW** `dashboard/src/hotkeys/useListSelection.ts` | — | Shared hook for `j`/`k`/`Enter`/`o` list navigation. |
| **NEW** `dashboard/src/hotkeys/CommandPalette.tsx` | — | Radix `<Dialog>` + `<input>` + fuzzy-ranked results list (missions, assignments, playbooks, servers, todos, pages). |
| **NEW** `dashboard/src/hotkeys/CheatsheetDialog.tsx` | — | Radix `<Dialog>` rendering all registered bindings grouped by scope. |
| **NEW** `dashboard/src/hotkeys/fuzzy.ts` | — | Tiny subsequence ranker (score = match positions + consecutiveness + prefix bonus). |
| **NEW** `dashboard/src/hotkeys/match.ts` | — | Platform-aware key matcher (Cmd on mac, Ctrl elsewhere). Handles `Shift+T`, `g o`, `?` (shift-slash). |
| **NEW** `dashboard/src/hotkeys/index.ts` | — | Re-exports. |

## Patterns Discovered
| Pattern | Reference File | Description |
|---------|----------------|-------------|
| Radix Dialog wrapper | `dashboard/src/components/ui/dialog.tsx` | `<Dialog open onOpenChange>` with `<DialogContent>` — already handles Esc-to-close and focus trap. Build palette and cheatsheet on this exact primitive. |
| Context provider + hook | `dashboard/src/theme.tsx` | `createContext`, `useContext` throws when missing provider. Mirror this pattern for `HotkeyContext` (getState, register/unregister). |
| Page-local data fetch with refetch | `dashboard/src/hooks/useMissions.ts:294` (`useFetch`) | Every list hook returns `{ data, loading, error, refetch }`. The `r` shortcut simply calls `refetch()`. |
| Workspace-prefixed navigation | `dashboard/src/hooks/useMissions.ts:375` (`useWorkspacePrefix`) | Always use this when constructing a nav target so workspace context is preserved. |
| Client-side filter pattern | `MissionList.tsx:44`, `AssignmentsPage.tsx:230`, `TodosPage.tsx:47` | Each page has a `filtered` memo; the palette index will do similar substring matching but graded by fuzzy score. |
| localStorage for UI preferences | `theme.tsx:18` (`syntaur-theme`), `AppShell.tsx:44` (`syntaur.dashboard.sourceFirstNoticeDismissed`) | If cheatsheet needs "do not show again" state, use the same pattern under `syntaur.dashboard.hotkeys.*`. |
| Element data-attributes used as hooks for JS (not React refs) | `DependencyGraph.tsx:81` queries `.node` SVG groups | Acceptable precedent for `data-hotkey-*` attributes if ref prop-drilling is undesirable. |

## CLAUDE.md Rules Found
No `CLAUDE.md` exists at `/Users/brennen/syntaur`, `/Users/brennen/syntaur/dashboard`, or any subdirectory of `dashboard/`. Verified via Glob. The only governing docs are the user-level instructions at `/Users/brennen/.claude/CLAUDE.md` (plans directory, shell aliases, env vars) — none of which constrain the implementation. The Syntaur protocol (MEMORY.md feedback files) governs assignment recordkeeping but does not dictate dashboard code standards.

## Questions Asked & Answers
| Question | Answer |
|----------|--------|
| Which fuzzy library? | None installed — decision in plan phase. Recommendation: hand-roll a ~40 LOC subsequence ranker; avoid new dependency. |
| How do g-chord and `?` interact when typing in an input? | Spec says shortcuts don't fire when typing except Esc and Cmd+K. So `g`, `?`, `j`, `k`, `r`, etc. are all suppressed inside inputs. `?` = Shift+/ so it naturally wouldn't fire inside a text input anyway (the character would just type). Verified no other user clarification needed. |
| Is there a detail route for todos or servers? | **No.** Todos are rendered inline on `/todos`; servers on `/servers`. Palette will navigate to the page and (optionally) scroll to / highlight the row via URL hash or query. |
| Should `/` focus the global palette search or the page filter? | Spec says "`/` focuses filter" for list pages. So `/` is a list-scoped shortcut, not global. On pages with no filter (Overview, Help, Settings), `/` is a no-op. |
| Where does prev/next for assignments source its list? | `useMission(slug).assignments` — already loaded by `AssignmentDetail.tsx:52`. No extra fetch needed. |

## Exploration Log
Since I was able to directly read every file relevant to this scope (package.json, App.tsx, theme.tsx, all hooks, AppShell, all relevant pages including DependencyGraph to check for existing handlers, and all three UI primitives), the required exploration surface was fully covered without spawning Task-based Explore subagents. The tech stack is small and self-contained (one app, ~35 source files in `dashboard/src`), and every question the prompt called out was answerable from direct file reads. This is recorded as a deliberate choice — a single-repo, already-mapped codebase.

| Explorer | Focus Area | Key Findings |
|----------|-----------|--------------|
| Direct read (package.json + App.tsx) | Tech stack + routing | React 18 + Vite 6 + react-router-dom v7. Radix UI primitives, Tailwind, lucide-react. No fuzzy-search, cmdk, or kbar installed. Single `<BrowserRouter>` with all routes wrapped in one `<Layout>`. |
| Direct read (hooks/*.ts) | Data model + loading topology | Every list hook (`useMissions`, `useAssignmentsBoard`, `usePlaybooks`, `useServers`, `useAllTodos`) is page-local, not global. All return `{ data, loading, error, refetch }`. WebSocket-driven auto-refresh is already unified. Palette must mount hooks globally (or lazily-sticky on first trigger). |
| Direct read (pages/*.tsx) | Similar patterns + table structure | Three different table/list shapes (cards/table/kanban) across MissionList, AssignmentsPage, TodosPage. No existing row-selection concept. Edit operations are route-based, not modal-based. `useMission(slug).assignments` supplies the prev/next list on AssignmentDetail without extra fetches. |
| Direct read (components/ui/*.tsx + theme.tsx + DependencyGraph.tsx) | Modal library + theme + existing keydown | Radix Dialog handles Esc+focus-trap natively. `useTheme().toggleTheme()` is ready to wire to Shift+T. DependencyGraph's keydown is SVG-element-scoped, no conflict. |

## Reflection (gaps addressed)
1. **Understanding:** The feature is a cross-cutting keyboard layer with a command palette centerpiece. Eight shortcut groups; several page-local, some global.
2. **Files:** Mapped above — 9 existing files to modify, 8 new files to create.
3. **Patterns to follow:** Radix Dialog for modals, context+hook for global state, page-local hooks with refetch, workspace-prefixed navigation, Tailwind semantic tokens.
4. **Uncertainties resolved:**
   - Fuzzy lib: recommend hand-roll (decision recorded for plan phase).
   - Data loading strategy: lazy-sticky global fetch in HotkeyProvider on first palette or g-chord trigger.
   - Row selection: new concept; introduce `useListSelection` hook and `data-hotkey-row-index` attribute.
   - Filter focus: add `inputRef` prop to `SearchInput`; TodosPage either migrates to `SearchInput` or exposes a ref on its raw input.
   - Esc double-fire: rely on Radix's built-in Esc handling for palette/cheatsheet/existing dialogs; the global handler's Esc path should only handle non-Radix drawers (e.g., mobile nav) — detect "any Radix dialog is open" and bail out on Esc.
5. **Open concerns for plan phase:**
   - Should `useListSelection` persist its index across route changes, or reset each mount? (Recommend: reset.)
   - Should the cheatsheet also be reachable from the Help page? (Recommend: yes, via a visible link; cheatsheet content should itself be generated from the hotkey registry.)
   - Should `Cmd+K` also work while a non-palette Radix dialog is open? (Recommend: no — let Esc close the current dialog first, then `Cmd+K` reopens. Simplifies scope management.)
   - g-chord timeout value (spec'd as 1500ms in my notes; not in user request). Plan phase to confirm.

## Key Risks
- **Focus trap interaction:** Radix Dialog traps focus and intercepts Esc. The global key handler must check `document.querySelector('[role="dialog"][data-state="open"]')` (Radix sets these) and skip non-Esc/non-Cmd+K keys when a dialog is open.
- **Input heuristic:** `activeElement.tagName === 'INPUT' || 'TEXTAREA' || activeElement.isContentEditable` is the safe check. The existing new-workspace input (AppShell), Search inputs, edit-page textareas (MarkdownEditor), and the transition-dialog textarea all rely on this skip.
- **g-chord vs. single-letter shortcuts on list pages:** When on AssignmentsPage, `a` is not a list-scoped shortcut. But the spec has `g a` = Assignments globally. The 1500ms chord buffer naturally handles this — user types `g`, then `a` is captured as the chord's second key. A bare `a` on AssignmentsPage (no preceding `g`) could be a future list action but is not in the current spec.
- **Keyboard layout / non-US keyboards:** `?` is Shift+/ on US keyboards; `[`/`]` are the bracket keys. On non-US layouts these keys can differ. Reading `event.key` (not `event.code`) gives the correct logical character for the user's layout — document this and use `event.key` consistently.
- **StrictMode double-registration:** `main.tsx` wraps in `<StrictMode>`, which double-invokes effects in dev. The HotkeyProvider must guard against duplicate `window.addEventListener` attachment (useEffect cleanup must remove the handler).
- **Bundle size:** Adding a hotkey system + palette is ~3–5 KB gzipped if hand-rolled, ~15 KB with a full fuzzy lib. Acceptable either way.

## Confirmation: Completion Gate
- [x] Tech stack identified (React 18 + Vite + react-router-dom v7 + Radix UI + Tailwind + lucide; no fuzzy lib)
- [x] Complexity assessed: **large** (reasoning above)
- [x] Understanding documented (detailed objective + per-shortcut wiring)
- [x] Files identified (9 existing modifications + 8 new files)
- [x] Patterns found (Radix Dialog, context+hook, page-local refetch, workspace prefix, data-attrs for DOM queries)
- [x] CLAUDE.md read (none exist in repo; global user rules have no bearing on dashboard code)
- [x] Exploration documented (direct reads of all relevant files logged in Exploration Log)
- [x] Reflection done (gaps enumerated, resolutions recorded, open items flagged for plan phase)
- [x] Questions answered (fuzzy lib, data loading strategy, detail routes for todos/servers, `/` scope, prev/next source)
- [x] Discovery document created at `claude-info/plans/scratch/2026-04-16-dashboard-hotkeys-discovery.md`
