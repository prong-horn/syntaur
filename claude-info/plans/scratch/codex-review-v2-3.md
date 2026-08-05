FINDING 1
SEVERITY: major
LOCATION: src/dashboard/session-db.ts:580
ISSUE: `archived=show` and `archived=only` cannot use the new partial indexes. Show scans and sorts the whole set; archived-only performs a table scan plus sort for every page. This reintroduces the paging scalability failure in two shipped archive views.
FIX: Add full pinned-order indexes for `show`, plus `archived_at IS NOT NULL` partial pinned-order indexes for `only`; add EXPLAIN regression tests for both views.

FINDING 2
SEVERITY: major
LOCATION: dashboard/src/components/dashboard/widgets/SessionViewResults.tsx:54
ISSUE: Saved session views re-sort the unpaged response with `sortSessions`, which ignores `pinnedAt`. An old pinned session therefore falls below unpinned rows in an Overview saved-view widget, violating pinned-first ordering outside the dedicated paged list.
FIX: Prefix the saved-view comparator with the same pinned-first / newest-pin ordering used by SQL and merge paths, and add a saved-view pin-order test.

FINDING 3
SEVERITY: major
LOCATION: dashboard/src/pages/AgentSessionsPage.tsx:597
ISSUE: The confirmation dialog retains a snapshot of IDs. A selected session can be archived before confirmation (including by the user’s own in-flight archive request), disappear from the active view, and still be deleted by `handleDelete(pendingDelete.sessionIds)`.
FIX: Clear affected selections and cancel/revalidate pending bulk deletion when archive begins or visible rows change; submit only IDs still actionable at confirmation.

VERDICT: REQUEST CHANGES