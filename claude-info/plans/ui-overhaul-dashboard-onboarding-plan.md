# Syntaur Dashboard UI Overhaul And In-Product Onboarding Plan

## Summary
Rebuild the dashboard into a command-center style product shell with real navigation, a useful overview page, mission and assignment workspaces, protocol-safe editing, and built-in how-to guidance so a first-time user can understand Syntaur from inside the app.

This version replaces the prior plan and adds a required onboarding/help workstream. The UI must teach:
- what a mission is
- what an assignment is
- how statuses work
- which files are editable vs derived
- the core CLI flow users actually have today

## Locked Decisions
- [x] Light theme is the default; dark theme is optional and persisted.
- [x] Markdown files remain the source of truth.
- [x] Slugs are immutable after creation.
- [x] Mission status is derived; only archive fields are directly editable.
- [x] Assignment status changes only through lifecycle transition actions.
- [x] `handoff.md` and `decision-record.md` remain append-only.
- [x] The dashboard must show source-of-truth state immediately after writes, even if derived files lag.
- [x] In-product help copy must only describe commands that actually exist in [`src/index.ts`](/Users/brennen/syntaur/src/index.ts).
- [x] In-product help must align with [`spec.md`](/Users/brennen/syntaur/docs/protocol/spec.md) and [`file-formats.md`](/Users/brennen/syntaur/docs/protocol/file-formats.md).
- [x] No auth, comments, notifications, slug rename support, or multi-user features in this pass.

## Route Map
- [x] `/` -> Overview
- [x] `/missions` -> Mission Directory
- [x] `/attention` -> Attention Queue
- [x] `/help` -> Help / Getting Started
- [x] `/create/mission` -> Create Mission
- [x] `/missions/:slug` -> Mission Workspace
- [x] `/missions/:slug/edit` -> Edit Mission
- [x] `/missions/:slug/create/assignment` -> Create Assignment
- [x] `/missions/:slug/assignments/:aslug` -> Assignment Workspace
- [x] `/missions/:slug/assignments/:aslug/edit` -> Edit Assignment
- [x] `/missions/:slug/assignments/:aslug/plan/edit` -> Edit Plan
- [x] `/missions/:slug/assignments/:aslug/scratchpad/edit` -> Edit Scratchpad
- [x] `/missions/:slug/assignments/:aslug/handoff/edit` -> Append Handoff Entry
- [x] `/missions/:slug/assignments/:aslug/decision-record/edit` -> Append Decision Entry

## Public API And Type Changes
- [x] Add `GET /api/overview`
- [x] Add `GET /api/attention`
- [x] Add `GET /api/help`
- [x] Add edit-document GET endpoints for mission, assignment, plan, scratchpad, handoff, decision record
- [x] Add `PATCH /api/missions/:slug`
- [x] Add `PATCH /api/missions/:slug/assignments/:aslug`
- [x] Add `PATCH /api/missions/:slug/assignments/:aslug/plan`
- [x] Add `PATCH /api/missions/:slug/assignments/:aslug/scratchpad`
- [x] Add `POST /api/missions/:slug/assignments/:aslug/handoff/entries`
- [x] Add `POST /api/missions/:slug/assignments/:aslug/decision-record/entries`
- [x] Add `POST /api/missions/:slug/assignments/:aslug/transitions/:command`
- [x] Add frontend types for `OverviewResponse`, `AttentionResponse`, `HelpResponse`, and transition actions in [`useMissions.ts`](/Users/brennen/syntaur/dashboard/src/hooks/useMissions.ts) or split hook files.

## Help Content Contract
The UI help system must ship with these sections and no speculative behavior.

- [x] “What Syntaur Is”
  - [x] Explain that Syntaur is a local-first, markdown-backed agent work system.
  - [x] Explain that the dashboard is a view over mission folders and files.
- [x] “Core Objects”
  - [x] Mission
  - [x] Assignment
  - [x] Resource
  - [x] Memory
  - [x] Derived files
- [x] “How Work Flows”
  - [x] `syntaur init`
  - [x] `syntaur create-mission`
  - [x] `syntaur create-assignment`
  - [x] `syntaur assign`
  - [x] `syntaur start`
  - [x] `syntaur review`
  - [x] `syntaur complete`
  - [x] `syntaur block`
  - [x] `syntaur unblock`
  - [x] `syntaur dashboard`
- [x] “Status Guide”
  - [x] `pending`
  - [x] `in_progress`
  - [x] `blocked`
  - [x] `review`
  - [x] `completed`
  - [x] `failed`
  - [x] Explicitly explain `pending` vs `blocked`
- [x] “Who Edits What”
  - [x] `mission.md` is human-authored
  - [x] assignment files are agent-writable
  - [x] handoff and decision logs are append-only
  - [x] underscore-prefixed files are derived and read-only
- [x] “Where To Look In The UI”
  - [x] Overview for triage
  - [x] Mission page for mission health
  - [x] Assignment page for execution
  - [x] Help page for model and CLI refresher

## Implementation Tasks

### Task 1: Rebuild the app shell and route structure
**Files:** [`App.tsx`](/Users/brennen/syntaur/dashboard/src/App.tsx), [`Layout.tsx`](/Users/brennen/syntaur/dashboard/src/components/Layout.tsx)

- [x] Change `/` from the old mission list to `Overview`.
- [x] Add `/missions`, `/attention`, and `/help`.
- [x] Keep all detail, create, and edit routes under a persistent shell.
- [x] Add a left sidebar on desktop with nav items for Overview, Missions, Attention, Help.
- [x] Add a top bar with breadcrumbs, page title, theme toggle, and shell actions.
- [x] Add quick action buttons for `New Mission` globally.
- [x] Show `New Assignment` only when a mission is in context.
- [x] Add a shell-level “Help” entry in both sidebar and top bar.
- [x] Add mobile navigation behavior that preserves access to Help and create actions.

### Task 2: Replace the current visual system
**Files:** [`globals.css`](/Users/brennen/syntaur/dashboard/src/globals.css), [`tailwind.config.ts`](/Users/brennen/syntaur/dashboard/tailwind.config.ts)

- [x] Replace the current dark-only root tokens with a full light-default token set.
- [x] Add `.dark` token overrides.
- [x] Add tokens for page background, panel background, sidebar background, muted panels, status colors, borders, and ring states.
- [x] Define panel, rail, card, sticky header, and empty-state styles.
- [x] Add a subtle background treatment so the app does not sit on a flat canvas.
- [x] Define typography styles for headings, labels, prose, and mono technical text.
- [x] Ensure the theme supports help callouts, code snippets, glossary chips, and status legends.

### Task 3: Add theme state and persistent toggle
**Files:** [`main.tsx`](/Users/brennen/syntaur/dashboard/src/main.tsx), new theme helper/provider files under `dashboard/src`

- [x] Add theme initialization before first meaningful paint.
- [x] Persist explicit theme choice in `localStorage`.
- [x] Default to light theme if no saved choice exists.
- [x] Respect OS theme only until the user makes an explicit choice.
- [x] Add a shell toggle that works on all routes, including Help.

### Task 4: Build shared UI primitives
**Files:** new files under `dashboard/src/components`

- [x] Create `AppShell`
- [x] Create `SidebarNav`
- [x] Create `TopBar`
- [x] Create `PageHeader`
- [x] Create `SectionCard`
- [x] Create `StatCard`
- [x] Create `FilterBar`
- [x] Create `SearchInput`
- [x] Create `ViewToggle`
- [x] Create `EmptyState`
- [x] Create `ErrorState`
- [x] Create `LoadingState`
- [x] Create `ContentTabs`
- [x] Create `HelpCallout`
- [x] Create `GettingStartedCard`
- [x] Create `GlossaryTooltip`
- [x] Create `CommandSnippet`
- [x] Update [`StatusBadge.tsx`](/Users/brennen/syntaur/dashboard/src/components/StatusBadge.tsx) to support icons and tooltip text.
- [x] Update [`ProgressBar.tsx`](/Users/brennen/syntaur/dashboard/src/components/ProgressBar.tsx) to support segmented legends and labels.

### Task 5: Switch the server and hooks to source-first reads
**Files:** [`api.ts`](/Users/brennen/syntaur/src/dashboard/api.ts), [`types.ts`](/Users/brennen/syntaur/src/dashboard/types.ts), [`useMissions.ts`](/Users/brennen/syntaur/dashboard/src/hooks/useMissions.ts)

- [x] Make mission rollups source-first so dashboard state stays correct after edits.
- [x] Continue using `_status.md` only for optional extras like dependency graph extraction when safe.
- [x] Add `useOverview`.
- [x] Add `useAttention`.
- [x] Add `useHelp`.
- [x] Keep websocket invalidation wired into overview, attention, mission, assignment, and help surfaces where relevant.
- [x] Ensure frontend types exactly match the new API shapes.

### Task 6: Build the Overview page
**Files:** new `dashboard/src/pages/Overview.tsx`

- [x] Add a large header with app summary and `New Mission` CTA.
- [x] Add stat cards for active missions, in-progress assignments, blocked, review, failed, and stale.
- [x] Add a “Needs Attention Now” panel using overview attention data.
- [x] Add a “Recently Updated Missions” panel.
- [x] Add a “Recent Activity” panel built from parsed `updated` timestamps, not file mtimes.
- [x] Add a “Getting Started” card.
- [x] If there are zero missions, show the full onboarding version of the card with explicit step-by-step setup.
- [x] If missions already exist, show a compact refresher version of the card.
- [x] Link the card to the Help page.

### Task 7: Build the Help / Getting Started page
**Files:** new `dashboard/src/pages/Help.tsx`, new help data helper under `src/dashboard` if needed

- [x] Add page sections for:
  - [x] Getting Started
  - [x] Core Concepts
  - [x] Status Guide
  - [x] Ownership And File Rules
  - [x] CLI Quick Reference
  - [x] How To Navigate The Dashboard
- [x] Populate help content from a server-side help model or static typed content assembled from known protocol facts.
- [x] Add command snippets for actual commands from [`src/index.ts`](/Users/brennen/syntaur/src/index.ts).
- [x] Do not mention a `syntaur rebuild` CLI command unless it actually exists by implementation time.
- [x] Add glossary definitions for mission, assignment, resource, memory, manifest, derived file, handoff, decision record.
- [x] Add links from help sections into real app surfaces where appropriate.
- [x] Add an FAQ entry explaining why some files are read-only in the UI.
- [x] Add a “first mission checklist” that maps directly to the real CLI flow.

### Task 8: Redesign the Mission Directory
**Files:** [`MissionList.tsx`](/Users/brennen/syntaur/dashboard/src/pages/MissionList.tsx)

- [x] Move this page to `/missions`.
- [x] Add a page header with mission count and create CTA.
- [x] Add search by title and tags.
- [x] Add filters for status and archived state.
- [x] Add a tag filter.
- [x] Add sort options for updated date, created date, title, and attention severity.
- [x] Add a card/table view toggle.
- [x] Upgrade mission cards with richer status, progress, attention, updated date, and tags.
- [x] Add an empty state that includes a “What is a mission?” help callout and create CTA.
- [x] Add inline help explaining archived missions and derived mission status.

### Task 9: Redesign Mission Detail into a workspace
**Files:** [`MissionDetail.tsx`](/Users/brennen/syntaur/dashboard/src/pages/MissionDetail.tsx)

- [x] Add a mission header with title, status, tags, timestamps, edit CTA, and create-assignment CTA.
- [x] Add KPI cards for total assignments, in progress, blocked, completed.
- [x] Add internal sections or tabs for Overview, Assignments, Dependencies, and Knowledge.
- [x] In Overview, render the mission body in a styled panel and show a callout explaining that mission status is derived from assignments except for archive.
- [x] In Assignments, support board and table modes with filters for status, assignee, and priority.
- [x] In Dependencies, improve graph framing and show fallback text when no graph exists.
- [x] In Knowledge, separate resources and memories into clearer panels.
- [x] Add a right rail with progress summary, attention counts, and quick links.
- [x] Add a small “How missions work” help callout in the Overview section.

### Task 10: Redesign Assignment Detail into an execution console
**Files:** [`AssignmentDetail.tsx`](/Users/brennen/syntaur/dashboard/src/pages/AssignmentDetail.tsx)

- [x] Add a sticky header with mission link, title, status, priority, assignee, and updated timestamp.
- [x] Replace freeform status ideas with transition action buttons only.
- [x] Show blocked reason prominently when present.
- [x] Add summary chips for dependencies, plan status, handoff count, decision count, and stale state.
- [x] Use a shared tab system for Summary, Plan, Scratchpad, Handoff, and Decisions.
- [x] In Summary, show objective/body, dependencies, workspace info, external IDs, and latest handoff/decision summaries.
- [x] Add a right rail with metadata, dependencies, workspace info, and edit actions.
- [x] Add contextual help explaining transition actions and the difference between `pending`, `blocked`, and `review`.
- [x] Add an append-only explanation near Handoff and Decision sections.

### Task 11: Fix markdown rendering and content framing
**Files:** [`MarkdownRenderer.tsx`](/Users/brennen/syntaur/dashboard/src/components/MarkdownRenderer.tsx)

- [x] Remove hardcoded `prose-invert`.
- [x] Add light-theme prose defaults and dark-theme overrides.
- [x] Improve headings, spacing, code blocks, tables, lists, and blockquotes.
- [x] Make code/command snippets visually distinct.
- [x] Ensure help content and documentation-style panels are readable in both themes.
- [x] Ensure empty markdown states render as helpful UI, not just “No content.”

### Task 12: Rebuild the markdown editor workspace
**Files:** [`MarkdownEditor.tsx`](/Users/brennen/syntaur/dashboard/src/components/MarkdownEditor.tsx)

- [x] Add a real editor header with save, cancel/back, unsaved indicator, and raw markdown toggle.
- [x] Parse frontmatter into structured fields for supported document types.
- [x] Keep markdown body as the main writing surface.
- [x] Preserve unsupported frontmatter keys.
- [x] Show preview on desktop and a toggle on smaller screens.
- [x] Add inline validation errors.
- [x] Add protocol-aware help text for the current document type.
- [x] For mission edit, explain which fields are editable and which are derived.
- [x] For assignment edit, explain that status changes use actions, not raw field edits.

### Task 13: Refresh create flows
**Files:** [`CreateMission.tsx`](/Users/brennen/syntaur/dashboard/src/pages/CreateMission.tsx), [`CreateAssignment.tsx`](/Users/brennen/syntaur/dashboard/src/pages/CreateAssignment.tsx)

- [x] On Create Mission, explain what belongs in a mission and what does not.
- [x] On Create Assignment, explain dependencies, status expectations, and when to use blocked later.
- [x] Present structured fields first, markdown body second.
- [x] Keep raw markdown mode available.
- [x] Validate fields before submit.
- [x] Add sidebar or inline help linking back to the Help page.
- [x] Redirect to the created workspace on success.

### Task 14: Add edit pages and append-only entry pages
**Files:** new page files under `dashboard/src/pages`

- [x] Create `EditMission`
- [x] Create `EditAssignment`
- [x] Create `EditAssignmentPlan`
- [x] Create `EditAssignmentScratchpad`
- [x] Create `AppendAssignmentHandoff`
- [x] Create `AppendAssignmentDecisionRecord`
- [x] Reuse the shared editor workspace for mission, assignment, plan, and scratchpad.
- [x] Use dedicated append-entry forms for handoff and decision record.
- [x] Show append-only warnings on handoff and decision entry pages.
- [x] Redirect back to the relevant assignment tab after save or append.

### Task 15: Implement safe write, append, and transition endpoints
**Files:** [`api-write.ts`](/Users/brennen/syntaur/src/dashboard/api-write.ts), [`parser.ts`](/Users/brennen/syntaur/src/dashboard/parser.ts)

- [x] Add PATCH routes for mission, assignment, plan, and scratchpad.
- [x] Reject slug changes with explicit 400 errors.
- [x] Reject raw assignment status edits with explicit 400 errors.
- [x] Add append-entry routes for handoff and decision record.
- [x] Add transition route that uses the lifecycle engine rather than raw status mutation.
- [x] Require `blockedReason` when blocking.
- [x] Write changes atomically via temp file + rename.
- [x] Return the updated parsed document or updated assignment detail payload.
- [x] Preserve append-only history for handoff and decision logs.
- [x] Add parser/serializer helpers that preserve unknown keys and stable formatting.

### Task 16: Add the Help API contract
**Files:** [`api.ts`](/Users/brennen/syntaur/src/dashboard/api.ts), new helper file under `src/dashboard`

- [x] Implement `GET /api/help`.
- [x] Return structured sections instead of hardcoding large prose blobs in the page component.
- [x] Include command labels, descriptions, and example invocations only for commands that exist in [`src/index.ts`](/Users/brennen/syntaur/src/index.ts).
- [x] Include glossary entries and ownership rules.
- [x] Include dashboard navigation guidance.
- [x] Keep the response shape stable so the page and contextual help callouts can reuse the same source.

### Task 17: Add loading, empty, and error states everywhere
**Files:** all primary pages and shared state components

- [x] Replace plain loading text with reusable loading states.
- [x] Replace bare error text with reusable error panels.
- [x] Add empty states for missions, assignments, resources, memories, handoff, decisions, and activity.
- [x] Ensure empty states include next actions or help links.
- [x] Add onboarding-oriented empty states for first-run users.

### Task 18: Responsive and accessibility pass
**Files:** all interactive UI files

- [ ] Verify layouts at 1440, 1280, 1024, 768, and 390 widths.
- [ ] Collapse sidebar or convert to drawer appropriately.
- [ ] Move rails below content on smaller screens.
- [ ] Ensure table overflow is handled.
- [ ] Ensure help content remains readable on mobile.
- [ ] Add visible focus states.
- [ ] Ensure keyboard access for navigation, tabs, filters, editor controls, and help expanders/tooltips.
- [ ] Ensure status meaning is not conveyed by color alone.

### Task 19: Verification and acceptance
**Files:** frontend and backend test files

- [ ] Add API tests for overview, attention, help, edit, append, and transition endpoints.
- [ ] Add serializer round-trip tests.
- [ ] Add route/component tests for shell navigation, Help page, Overview onboarding card, and mission/assignment help callouts.
- [ ] Add tests that prove append-only endpoints do not rewrite history.
- [ ] Add tests that prove assignment status changes cannot bypass lifecycle transitions.
- [ ] Manually verify:
  - [ ] first-time user lands on Overview and sees how to get started
  - [ ] Help page explains the real CLI flow
  - [ ] mission empty state teaches what a mission is
  - [ ] assignment page explains status actions
  - [ ] handoff and decision pages explain append-only behavior
  - [ ] light/dark theme works across help and content pages
  - [ ] source-first reads keep UI state correct after edits

## Execution Order
- [x] Phase 1: Tasks 1, 2, 3, 4, 5
- [x] Phase 2: Tasks 6, 7, 16
- [x] Phase 3: Tasks 8, 9, 10, 11
- [x] Phase 4: Tasks 12, 13, 14, 15
- [ ] Phase 5: Tasks 17, 18, 19

## Acceptance Criteria
- [ ] A brand-new user can understand the Syntaur model without leaving the UI.
- [ ] A user can find the real getting-started steps from Overview or Help in under 10 seconds.
- [ ] A user can tell the difference between mission-level and assignment-level work.
- [ ] A user can tell the difference between `pending` and `blocked`.
- [ ] A user can understand which files are editable and which are derived/read-only.
- [ ] A user can navigate from Overview to Mission to Assignment without losing context.
- [ ] A user can edit mission, assignment, plan, and scratchpad content safely.
- [ ] A user can append handoff and decision entries without rewriting history.
- [ ] All onboarding/help content matches the actual protocol and CLI surface.

## Assumptions
- [ ] The frontend remains in `dashboard/`.
- [ ] The dashboard API remains in `src/dashboard/`.
- [ ] There is no separate docs CMS; help content is shipped as typed app content.
- [ ] No rebuild command is introduced in this UI overhaul unless separately planned and implemented.
