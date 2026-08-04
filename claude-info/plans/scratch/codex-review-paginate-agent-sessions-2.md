FINDING 1  
SEVERITY: major  
LOCATION: Task 3, plan lines 163-167; `dashboard/src/pages/AgentSessionsPage.tsx:647-652`  
ISSUE: The proposed spend/token path builds its ordered IDs solely from `listSessionUsage()`. That map contains only sessions with usage events, whereas the current sort includes tracked sessions with no usage as zero-cost/zero-token rows. Those rows would disappear from these sort modes and make `totalCount` wrong.  
FIX: Build the ordered set from the complete filtered union: all tracked session IDs plus usage-only IDs when enabled. Assign missing usage totals as zero, preserve the current `started DESC` tie-breaker, then use `session_id` as the final stable key. Add a test with tracked zero-usage sessions.

FINDING 2  
SEVERITY: major  
LOCATION: Task 3, plan lines 141-175; `src/dashboard/api.ts:813-830`  
ISSUE: `projectSlugs` alone cannot represent workspace membership. In particular, `_ungrouped` must include standalone sessions, and named workspaces can include standalone assignments; `resolveWorkspaceMembers` returns both project slugs and standalone assignment IDs for this reason. The proposed query would exclude those rows or be unable to distinguish “no workspace filter” from an empty workspace result.  
FIX: Extend `SessionPageQuery` with an explicit workspace scope containing project slugs and standalone assignment IDs (plus a defined policy for unattributed usage-only rows), and filter through the chosen engagement’s `project_slug` / `assignment_id`. Add endpoint tests for named-workspace standalone and `_ungrouped` sessions.

FINDING 3  
SEVERITY: major  
LOCATION: Task 7, plan lines 276-292; `dashboard/src/components/dashboard/widgets/SessionViewResults.tsx:26-48`, `AgentSessionsWidget.tsx:47`  
ISSUE: Requesting a page “matching what they display” breaks saved views: `SessionViewResults` currently filters and sorts the complete result before applying its configurable limit. A bounded arbitrary page can miss matching older sessions and produces incorrect saved-view results; `config.limit` is optional, so there is not always a display-sized bound. Also, `AgentSessionsWidget` still invokes its own hook even when a saved view renders `SessionViewResults`, so merely changing both calls does not collapse the duplicate request.  
FIX: Either add server-side support for the saved-view predicates/sorts before requesting a bounded result, or explicitly retain and justify the full fetch for saved-view rendering. For the unbound recent rail, use a bounded newest-first request. Specify one data owner per state—e.g., disable the widget’s query when `viewId` is set.

FINDING 4  
SEVERITY: major  
LOCATION: Task 4, plan lines 183-206; Task 7, plan lines 286-292; `dashboard/src/hooks/useProjects.ts:543-565,770-776`, `dashboard/src/components/CreateSessionViewDialog.tsx:58`  
ISSUE: Task 7 requires deferring `CreateSessionViewDialog`’s request with `useFetch`’s `enabled` flag, but `useFetch` is private and the proposed widened `useAgentSessions` API has no `enabled` option. No planned task supplies the required integration point, so the dialog cannot implement the stated deferral.  
FIX: Add `enabled?: boolean` to `useAgentSessions` and pass it as the third argument to `useFetch`; call it with `{ enabled: open }` in the dialog. Include a test or manual verification that closed dialogs issue no sessions request.

FINDING 5  
SEVERITY: minor  
LOCATION: Task 2-4, plan lines 104, 142-150, 186-191; `dashboard/src/pages/AgentSessionsPage.tsx:18-26`  
ISSUE: The plan uses `SessionSort` in server and hook signatures, but the only existing declaration is a page-local type in `AgentSessionsPage.tsx`; no shared/server type exists. The proposed signatures therefore do not compile as written and leave the wire contract duplicated.  
FIX: Add a task to define and export the sort union from an appropriate shared contract module, then import it from the page, hook, API route, and query implementation.

FINDING 6  
SEVERITY: minor  
LOCATION: Task 2, plan lines 127-130  
ISSUE: “Substring, matched as today” is not sufficient for a SQL implementation: a naïve `LIKE` makes `%`, `_`, and escape characters act as wildcards, unlike the current literal JavaScript `includes()` search.  
FIX: Specify a literal case-insensitive matcher, such as `instr(lower(column), lower(?)) > 0`, or escape `%`, `_`, and `\` with an explicit `ESCAPE` clause; add a special-character search test.

VERDICT: NEEDS REVISION