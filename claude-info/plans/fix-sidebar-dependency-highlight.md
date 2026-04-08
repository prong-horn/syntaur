# Fix: Assignment dependency links highlight wrong sidebar tab

## Context
When clicking a dependency link on an assignment detail page, the Missions tab gets highlighted instead of staying on Assignments. The dependency links navigate to `/missions/{slug}/assignments/{dep}`, which matches the `/missions` prefix first in `getSidebarSection()`.

## Fix

**File:** `dashboard/src/lib/routes.ts` — `getSidebarSection()` (line 35)

Change the `/missions` check to exclude paths that contain `/assignments/`:

```typescript
if (normalized.startsWith('/missions')) {
  // Assignment detail nested under a mission should highlight the Assignments tab
  if (/^\/missions\/[^/]+\/assignments\//.test(normalized)) {
    return '/assignments';
  }
  return '/missions';
}
```

This way `/missions/foo/assignments/bar` returns `'/assignments'` while `/missions` and `/missions/foo` still return `'/missions'`.

## Verification
- Navigate to an assignment detail page via the Assignments tab — Assignments tab stays highlighted
- Click a dependency link — Assignments tab stays highlighted
- Navigate to a mission detail page — Missions tab is highlighted
- Navigate to the missions list — Missions tab is highlighted
