FINDING 1  
SEVERITY: major  
LOCATION: src/dashboard/api-agent-sessions.ts:121  
ISSUE: The unpaged `includeUsageOnly=1` path treats the filtered result as the full tracked-ID set. An archived tracked session with usage is filtered out, then reintroduced as a synthetic usage-only row. With `archived=only`, every non-archived tracked session with usage is likewise synthesized.  
FIX: Determine orphanhood from `listAllSessionIds()` (or pass the unfiltered ID set into `attachUsage`), never from the filtered `sessions` array. Add unpaged hide/show/only tests with tracked usage rows.

FINDING 2  
SEVERITY: major  
LOCATION: src/dashboard/api-agent-sessions.ts:184  
ISSUE: `orphanPassesFilters` ignores `q.archived`. Consequently `archived=only&attribution=usage-only` returns every usage-only orphan even though none can have `archived_at`; `attribution=all` and its bucket counts are inflated similarly.  
FIX: Reject synthetic rows when the effective archived filter is `only`; retain them for `hide` and `show`. Add merge-path tests for `usage-only` and `all`.

FINDING 3  
SEVERITY: major  
LOCATION: dashboard/src/pages/AgentSessionsPage.tsx:155  
ISSUE: A selected session remains selected after it is archived or after the user changes to a filter that hides it. The persistent “Delete Selected” action then deletes a row the user can no longer see.  
FIX: Scope selections to the active non-page query, clear them on filter changes (especially `archived`), and remove an ID after a successful archive mutation. Close any pending delete dialog when that scope changes.

FINDING 4  
SEVERITY: major  
LOCATION: dashboard/src/pages/AgentSessionsPage.tsx:444  
ISSUE: The pinned-band logic assumes all pins fit on page 0. With more pins than `pageSize`, later pages can contain pinned rows and even the pinned→unpinned boundary, but render no band. Also `isEffectivelyPinned` excludes archived pins although SQL still sorts them first in `archived=show` and `archived=only`.  
FIX: Render grouping from the actual page’s pin state on every page, with server-provided pin-boundary metadata if needed for page-edge labels; use the same pin predicate as SQL or exclude archived pins from SQL consistently.

FINDING 5  
SEVERITY: major  
LOCATION: src/dashboard/agent-sessions.ts:263  
ISSUE: A user-assigned name is not durable against normal re-registration. `appendSession` overwrites an existing `description` whenever a later POST or `track-session --description` supplies a nonempty description, even when `description_source` is already `human`.  
FIX: Preserve a human-owned name during registration updates and make the curation rename path the deliberate replacement mechanism, or store names separately. Add a test that names a session, re-registers it with a description, and verifies the name survives.

FINDING 6  
SEVERITY: minor  
LOCATION: src/dashboard/agent-sessions.ts:157  
ISSUE: `parseSessionsIndex` remains a session-list query ordered solely by `started`, so it violates the claimed pinned-first behavior and also exposes archived rows. It currently has no internal callers, but is exported.  
FIX: Route it through the shared unpaged-list ordering/filter policy, or remove it if obsolete.

FINDING 7  
SEVERITY: minor  
LOCATION: src/__tests__/dashboard-api-agent-sessions-paging.test.ts:601  
ISSUE: New archive tests never combine archiving with usage-only rows or the unpaged `includeUsageOnly` route, so both synthetic-row failures above pass unnoticed. Separately, `archiving does not change status, activity, or ended` at `agent-sessions.test.ts:1398` would pass with a no-op archive setter because it never asserts that archiving occurred.  
FIX: Add integration coverage for archived tracked sessions with usage across paged and unpaged hide/show/only views; assert `archivedAt` in the non-destructive archive test.

VERDICT: REQUEST CHANGES