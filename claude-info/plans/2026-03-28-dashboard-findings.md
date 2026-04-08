# Syntaur Dashboard — Findings & Improvement Ideas

Explored on 2026-03-28 at `http://localhost:5173`. Tested across Overview, Missions, Assignments, Servers, Agent Sessions, Attention, Create Mission, and assignment detail pages. Both dark and light themes.

---

## 1. Bug: Assignment links don't navigate in Kanban view

**Page:** `/assignments` (Kanban view)

Assignment title text is rendered as `<a>` links with correct `href` values (e.g., `/missions/open-reeva/assignments/project-scaffolding-document-store`), but clicking them does not navigate to the assignment detail page. The click events appear to be swallowed — likely by the drag-and-drop event handler on the Kanban cards. Direct URL navigation works fine.

**Expected:** Clicking an assignment title in the Kanban card should navigate to its detail page. Drag-and-drop should only activate on drag gestures, not on simple clicks.

---

## 2. Bug: Markdown preview renders HTML comments as visible text

**Page:** `/create/mission`

The live markdown preview on the Create Mission form renders `<!-- ... -->` HTML comments as literal visible text (e.g., `<!-- Describe the mission goal, context, and success criteria here. -->`). These should either be hidden (standard HTML comment behavior) or stripped from the preview entirely.

**Expected:** HTML comments in the mission body markdown should not appear in the rendered preview.

---

## 3. UX: Overview stat cards overflow / "Stale" card cut off

**Page:** `/` (Overview)

The top stats row (Active Missions, In Progress, Blocked, Review, Failed, Stale) overflows horizontally. The "Stale" card is partially cut off at the right edge with no scroll affordance or wrapping. Users may not realize the card exists.

**Suggestion:** Either wrap the stat cards into two rows on narrower viewports, add a horizontal scroll indicator, or reduce card min-width so all six fit without overflow.

---

## 4. Improvement: Cross-mission Assignments page lacks filters

**Page:** `/assignments`

The Missions page has a rich filter bar (status dropdown, archive toggle, tag filter, sort order), but the Assignments page only has a search box and view-mode toggle (Table / List / Kanban). There's no way to filter by status, priority, assignee, or parent mission — you have to visually scan or search by text.

**Suggestion:** Add filter dropdowns (at minimum: status, assignee, mission) to the Assignments page, similar to what the Missions page has. The table view's column headers could also be made sortable.

---

## 5. Feature: Agent Sessions page should show duration / elapsed time

**Page:** `/agent-sessions`

The Agent Sessions table shows Assignment, Agent, Session ID, Started, Status, and Path — but no duration column. For active sessions there's no indication of how long the agent has been running, and for completed/stopped sessions there's no way to see total elapsed time.

**Suggestion:** Add a "Duration" or "Elapsed" column that shows:
- For active sessions: live-updating time since start (e.g., "2h 14m")
- For completed/stopped sessions: total run duration
This helps quickly spot stuck or long-running agents.
