# Syntaur Dashboard — UX Review (2026-06-16)

Reviewed the live dashboard (port 4800, real data) across Overview, Projects, Project detail,
Assignment detail, Assignments list, Usage, Command palette — in light, dark, and 390px mobile.
Each finding is grounded in a screenshot and (where applicable) the code that causes it.

## What's already good
- Command palette (⌘K): type chips, keyboard hints, live result count — genuinely nice.
- Dark mode is clean and high-contrast.
- Mobile sidebar collapses to a hamburger (the shell IS responsive at the nav level).

## The 20

### Information architecture & redundancy
1. **Nav items duplicated across scopes.** `Inventories`, `Usage`, `Todos` appear in the global
   nav AND in every workspace — with 2 workspaces they each show 3×. (`AppShell.tsx:41-61`)
   Meanwhile `Assignments`/`Servers`/`Agent Sessions` are workspace-only. Pick one home per item.
2. **"New Assignment" appears 2-3× on a project.** Top bar + page action row + Quick Links
   "Create assignment". (`TopBar.tsx`, `ProjectDetail.tsx`) Keep one primary CTA.
3. **"What needs you today" printed twice on Overview** — once as the page H1, once as the hero
   eyebrow. (`Overview.tsx:219` + `OverviewHero.tsx:47`)
4. **Status counts repeated 2-3× on project detail** — top stat cards (Review/Blocked/Completed)
   duplicate the Progress Summary pills which duplicate the Attention list. (`ProjectDetail.tsx:676-680`, `1031`)

### Visual signal / status noise
5. **Zero-count "false alarms."** The Blocked stat card is hardcoded `tone="warn"` so it renders
   amber (light) / dark-red (dark) even at **0 blocked**. (`ProjectDetail.tsx:679`, `TodosPage.tsx:449`)
   Make tone conditional on `count > 0`.
6. **11 status pills per project card, most = 0,** all equal weight → noisy. De-emphasize or hide
   zero-count statuses; consider collapsing rarely-used ones. (project cards + Progress Summary)
7. **"0 dependencies" chip on every assignment row** (plus a short ID hash) — pure noise when zero.
   Hide the chip at 0. (`AssignmentsPage` list rows)

### Layout & responsive
8. **Kanban page balloons to ~16,000px tall** with huge empty whitespace below content — a layout/
   min-height bug on the project-detail Assignments tab. (`ProjectDetail` + `KanbanBoard.tsx`)
9. **Persistent 280px right rail squeezes the kanban.** With many status columns the board is
   unreadable on a normal laptop and forces horizontal scroll; it only stacks at small `lg`.
   (`AppShell` grid `lg:grid-cols-[minmax(0,1fr)_280px]`)
10. **Top-bar actions overflow on mobile** — at 390px the theme toggle is clipped off the right
    edge; buttons keep full text labels instead of collapsing to icons. (`TopBar.tsx`)
11. **Stat cards are oversized on mobile** — 5 full-width blocks (~500px) push real content far
    below the fold before you reach the tabs. (`ProjectDetail` stats grid)

### Feedback & states
12. **Mutations give no success feedback.** Todos only toast on error; **Kanban drag-to-move shows
    no toast at all** (0 `showToast`), so the user can't tell a move/status change saved.
    (`TodosPage.tsx:263`, `KanbanBoard.tsx`)
13. **Empty project overview is a dead end** — a passive "does not have overview content yet."
    sentence with no "Add overview" CTA; sparse markdown renders as bare `Overview`/`Notes` headings.
    (`ProjectDetail.tsx:697`)
14. **Usage errors are raw red text** (`text-red-400`) with no ErrorState/retry. (`UsagePage.tsx`)
15. **In-flight actions aren't disabled** (status override / archive / move-workspace) → double-click
    can fire duplicate mutations. (`ProjectDetail` action row)

### Accessibility
16. **Focus ring removed on palette/search inputs** (`outline-none focus:ring-0`) while the standard
    `SearchInput` keeps `focus:ring-2` — keyboard users lose the focus indicator inconsistently.
    (`CommandPalette.tsx:230`, `ActionPalette.tsx:439/461`)
17. **Icon-only buttons missing `aria-label`** — mobile-nav close X, dialog close X, overflow "⋯".
    (`AppShell.tsx`, `CreateScheduleDialog.tsx`, `OverflowMenu.tsx`)
18. **Hand-rolled modals lack dialog semantics** — no `role="dialog"`/`aria-modal`, focus trap, or
    Esc-to-close on some dialogs (e.g. `CreateScheduleDialog.tsx`). Standardize on one Dialog primitive.

### Consistency & polish
19. **Mixed form controls.** Usage uses native OS `<select>` (default chevrons) while the rest of the
    app uses custom styled dropdowns/MultiSelect — visually inconsistent. (`UsagePage.tsx`)
20. **Inconsistent number/currency formatting.** Costs render to 4 decimals with no grouping
    (`$2501.9671`, `$0.0000`); tokens use grouping but tables have no totals row. (`UsagePage.tsx`)

## Honorable mentions (quick wins not in the 20)
- Assignments filter bar has **two side-by-side free-text inputs** (AQL query vs Search) — unclear
  which to use; and ~13 controls total with no progressive disclosure.
- "SOURCE-FIRST" label on assignment rows is unexplained jargon.
- Usage page is all tables — a small bar/line chart would make spend trends scannable.
