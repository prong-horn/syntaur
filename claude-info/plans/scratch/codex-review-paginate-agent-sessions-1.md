FINDING 1
SEVERITY: critical
LOCATION: “The decision this plan turns on”; Tasks 2–3; assignment Acceptance Criteria 1 and 5
ISSUE: The plan explicitly retains `useAgentSessions({ includeUsageOnly: true })`, which requests `/api/agent-sessions?includeUsageOnly=1` with no page parameters and returns every row (`api-agent-sessions.ts:194-204`; `useProjects.ts:770-776`). Client-side slicing only limits DOM rows; it does not make the initial payload a small fraction of 2.9 MB, nor does a websocket refresh avoid redownloading the full set. This directly fails two non-optional acceptance criteria, so deferring server-side pagination is not justified.
FIX: Replace the central decision with a server-backed query contract: page/cursor, page size, total (or has-more), and server-side search, dates, workspace scope, and all supported sorts. Update the API response and hook URL so each websocket refresh requests the current query/page only while preserving client page and selection state.

FINDING 2
SEVERITY: major
LOCATION: “The decision this plan turns on,” Fact 1; `src/dashboard/agent-sessions.ts:54-65, 774-779`; `src/dashboard/session-db.ts:33-54`; `src/db/usage-db.ts:461-518`
ISSUE: The cited evidence incorrectly describes `listAllSessions` as “a single indexed SQLite read.” The query performs a correlated engagement subquery per session and orders by `s.started`, but the schema has no `sessions(started)` index. The endpoint also calls `reconcileActiveSessions`, enriches every session, and `attachUsage` reads every `usage_events` row before building the response. The claimed 40 ms measurement may still be real, but it does not establish the asserted inexpensive indexed path or justify treating response construction and payload transfer as irrelevant.
FIX: Revise the evidence section to reflect the actual query/enrichment path and measure the complete request. Add a server-side paged-query design with appropriate indexes/query plan validation, while preserving usage-only union behavior and spend/token ordering.

FINDING 3
SEVERITY: major
LOCATION: Task 6; `dashboard/src/components/dashboard/widgets/AgentSessionsWidget.tsx:47, 121-129`; `SessionViewResults.tsx:26-48`; `RecentSessionsRail.tsx:30-36`; `sessionFilters.ts:178-185`
ISSUE: Applying `applySessionLimit` after `useAgentSessions()` does not stop any consumer from downloading all sessions; it slices an array only after the unbounded response is parsed. `SessionViewResults` already does exactly that at lines 45-48. The unbound `AgentSessionsWidget` passes all fetched sessions into `RecentSessionsRail`, which maps every one, and when a saved view is selected both the widget and `SessionViewResults` independently invoke `useAgentSessions()`. Thus this task cannot meet the Overview blast-radius criterion.
FIX: Make overview consumers request a bounded server page/limit appropriate to their display, defer `CreateSessionViewDialog`’s facet fetch until opened, and avoid the duplicate widget/view fetch. Explicitly document any consumer that truly needs a complete facet set.

FINDING 4
SEVERITY: major
LOCATION: Task 4; `dashboard/src/pages/AgentSessionsPage.tsx:141-147`
ISSUE: The prescribed select-all change is incomplete for the stated cross-page accumulation behavior. The existing implementation replaces `selectedIds` with `new Set(eligible)` when selecting and clears the entire set when clearing. Merely substituting `pagedSessions` means selecting page 2 discards selections from page 1, and clearing page 2 clears selections from every other page. That contradicts the plan’s claim that selections span pages deliberately.
FIX: Specify merge/subtract semantics: selecting the page unions its eligible IDs into the existing set; clearing removes only that page’s eligible IDs. Add tests for both actions with pre-existing selections on another page, not only header-state calculation.

FINDING 5
SEVERITY: major
LOCATION: Task 7
ISSUE: The proposed tests validate only client-side slicing and consequently cannot prove the required behavior once pagination is implemented correctly. They omit API tests for bounded response size/count, total/has-more metadata, all server-side filters and sorts across pages, usage-only rows, invalid page inputs, and websocket refresh of the current page without losing selection. The proposed “matching session at index 2,000” fixture instead encodes the rejected fetch-all design.
FIX: Add endpoint-level tests for the paged query contract and client-hook/page integration tests for query changes and websocket refetches. Retain UI slice/selection tests, but make server-wide filtering and sorting the primary correctness coverage.

VERDICT: NEEDS REVISION