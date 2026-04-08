# Syntaur Dashboard Review - 2026-03-29

Hands-on exploration of the Syntaur dashboard at `http://localhost:5173`, covering all pages and major interactions.

## Bugs

### 1. Agent Sessions page header says "Overview" instead of "Agent Sessions"
- **Page**: `/agent-sessions`
- **Severity**: Low
- The top-level page title in the header bar reads "Overview" instead of "Agent Sessions". The section label ("OPERATIONS / Agent Sessions") is correct, but the header bar title is wrong. Every other page (Missions, Assignments, Servers, Attention, Help) has its header title set correctly.

### 2. Create Mission form shows "Saved" badge on fresh load
- **Page**: `/create/mission`
- **Severity**: Low
- When navigating to the Create Mission form (via "+ New Mission" button), the form header immediately shows a "Saved" badge next to "Create Mission" even though nothing has been submitted yet. This is misleading — the user hasn't saved anything.

### 3. Sidebar highlight inconsistency on some navigations
- **Pages**: `/agent-sessions`, `/attention`
- **Severity**: Low
- On at least one navigation to Agent Sessions, "Servers" was highlighted in the sidebar instead of "Agent Sessions". On the Attention page, "Agent Sessions" was highlighted instead of "Attention". This off-by-one pattern was intermittent — a subsequent direct navigation to Agent Sessions showed the correct highlight. May be a race condition or stale state issue.

## Improvements

### 4. Make Overview stat cards clickable
- **Page**: `/` (Overview)
- **Impact**: Medium (UX polish)
- The stat cards at the top (Active Missions: 2, In Progress: 2, Blocked: 0, Review: 1, Failed: 0, Stale: 0, Active Servers: 1) are not clickable. Clicking "In Progress: 2" should navigate to the Assignments page pre-filtered to `?status=in_progress`. This is the most natural navigation path from the overview and currently requires manual clicks through the sidebar + filter dropdowns.

### 5. Make dependency graph nodes clickable
- **Page**: `/missions/:slug` (Dependencies tab)
- **Impact**: Medium (navigation shortcut)
- The dependency graph is well-rendered with color-coded status (green = completed, blue = in-progress, gray = pending), but the nodes are static. Clicking a node like "tool-registry-customization" should navigate to that assignment's detail page. Currently users must go back to the Assignments tab and find the assignment manually.

### 6. Agent session durations are hard to scan at large values
- **Page**: `/agent-sessions`
- **Impact**: Low (readability)
- Durations like "75h 7m" and "97h 6m" are displayed as raw hours. For sessions spanning multiple days, a "3d 3h" or "4d 1h" format would be more scannable. The "19m" format for short sessions is fine as-is.

### 7. Persistent "Source-first dashboard" tooltip covers content
- **Pages**: All pages (bottom-left corner)
- **Impact**: Low (annoyance)
- A floating info box reading "Source-first dashboard: Mission and assignment markdown files stay authoritative..." is permanently visible in the bottom-left corner. It cannot be dismissed and overlaps content when scrolling. Consider making it dismissable (with localStorage persistence) or moving it to the Help page only.

## Feature Ideas

### 8. Acceptance criteria as interactive checkboxes
- **Page**: Assignment detail (Summary tab)
- **Impact**: Medium (workflow enablement)
- Acceptance criteria are rendered as plain text `[ ]` markers from the markdown. Rendering these as actual checkboxes that toggle state back to the source file would make the assignment detail page a working execution surface instead of a read-only view. This aligns with the "source-first" philosophy — the dashboard writes back to the authoritative markdown.

### 9. Assignment detail: link dependency slugs to their detail pages
- **Page**: Assignment detail sidebar (Dependencies section)
- **Impact**: Low (navigation convenience)
- The Dependencies sidebar section shows dependency slugs like "project-scaffolding-document-store" as plain text. These should be clickable links that navigate to the corresponding assignment detail page within the same mission.

### 10. Agent Sessions: add search/filter and time-range controls
- **Page**: `/agent-sessions`
- **Impact**: Medium (operational visibility)
- The Agent Sessions page has basic status filter buttons (All, Active, Completed, Stopped) but lacks search, date-range filtering, and sorting. As sessions accumulate, finding a specific session or viewing sessions from a particular time window will become difficult. A search box + date range picker would help. Sorting by duration, started date, or assignment name would also be valuable.
