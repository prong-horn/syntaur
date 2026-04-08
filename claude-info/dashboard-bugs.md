# Dashboard Bugs & Improvements

Found during manual exploration of `http://localhost:5173/` on 2026-04-01.

---

## Bugs

### 1. "Source-first dashboard" notice re-renders on every page navigation

The info banner in the bottom-left corner reappears every time you navigate to a new route, even if you dismiss it. The dismissed state is not persisted (not saved to `localStorage` or session state). Users have to dismiss it on every page.

**Where:** All pages (sidebar, bottom-left).

---

### 2. Mission detail breadcrumb shows slug, not display name

The breadcrumb at the top of a mission detail page shows the raw slug (`MISSIONS / open-reeva`) instead of the human-readable title (`MISSIONS / Open Reeva`).

**Where:** `/missions/open-reeva` → top breadcrumb bar.

---

### 3. "Active Servers" stat card shows 0 on initial page load

On cold load, the Overview page's **Active Servers** card shows `0 / 0 ports · all healthy`. After a few seconds the WebSocket connects and it updates to the correct count (e.g. `2`). There is no loading skeleton or spinner while the data is in-flight, so it briefly looks like no servers are running.

**Where:** `/` → Active Servers stat card.

---

### 4. Recent Activity feed shows raw enum value `in_progress`

Activity descriptions in the Recent Activity list use the raw status enum value:
> "Assignment is **in_progress** with medium priority."

Should be formatted as "In Progress". Other statuses like `review` are lowercase but at least single-word; `in_progress` is the most glaring because of the underscore.

**Where:** `/` → Recent Activity panel.

---

### 5. "Drag missions between columns" hint shown on Cards and Table views

The info note at the bottom of the Missions page reads:
> "Drag missions between columns or use the status override on the mission detail page to set a manual status."

Drag-between-columns is only meaningful in **Kanban** view. It appears unchanged on Cards and Table views, which is misleading since neither supports column drag.

**Where:** `/missions` — all three view modes (Cards, Table, Kanban).

---

### 6. Mission detail stat row omits "Review" count

The stat row on a mission detail page has four cards: **Assignments · In Progress · Blocked · Completed**. The Review state is entirely absent here, even though the sidebar Progress Summary does display it. An assignment sitting in Review is invisible at a glance from the top of the page.

**Where:** `/missions/open-reeva` → top stat row.

---

### 7. Assignments Kanban — rightmost columns overflow with no scroll cue

The Kanban board for Assignments clips the **Completed** (and sometimes Review) columns off the right edge of the viewport. The content is horizontally scrollable, but there is no scroll shadow, fade, or scrollbar visible to indicate that more columns exist beyond the viewport.

**Where:** `/assignments` → Kanban view (default).

---

### 8. Dependency graph nodes show slugs instead of display names

The dependency graph on the **Dependencies** tab renders node labels as slugs (`project-scaffolding-document-store`, `web-frontend`) rather than the human-readable assignment titles ("Project Scaffolding & Document Store", "Web Frontend"). This makes the graph harder to read at a glance.

**Where:** `/missions/open-reeva` → Dependencies tab.

---

## Improvements

### 9. View preference (Cards / Table / Kanban) not reflected in URL

Switching views on the Missions page (`/missions`) changes the display but not the URL. Refreshing or sharing the link always resets to the default Cards view. Encoding the active view as a query param (e.g. `?view=kanban`) would make links shareable and survive refreshes.

**Where:** `/missions` → view toggle buttons.

---

### 10. Agent sessions table shows raw slugs in Mission/Assignment columns

The Agent Sessions table renders `open-reeva` and `web-frontend` in the Mission and Assignment columns instead of the resolved display names ("Open Reeva", "Web Frontend"). Standalone sessions with no linked assignment show `—`, which is fine, but the linked ones should show human-readable names.

**Where:** `/agent-sessions` → Mission and Assignment columns.

---

### 11. No favicon (404 on every page load)

The browser console logs a 404 for `/favicon.ico` on every page. The dashboard has no favicon configured, which looks unpolished in browser tabs and also spams the console.

**Console error:** `Failed to load resource: the server responded with a status of 404 (Not Found) @ http://localhost:5173/favicon.ico`
