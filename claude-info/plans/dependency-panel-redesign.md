# Dependency Panel Redesign — AssignmentDetail

## Context

Dependencies on the assignment detail view are buried in the 280px right sidebar as tiny slug-only pill links. They're one of the most important pieces of context for understanding an assignment's state (especially when blocked), but they're easy to miss. This plan promotes them to a prominent, full-width panel with enriched status information.

## Approach

Move dependencies out of the sidebar into a full-width panel between the sticky header and the content grid. Enrich with status badges and titles by fetching sibling assignment data via `useMission()`.

## Files to change

| File | Action |
|------|--------|
| `dashboard/src/components/DependencyPanel.tsx` | **Create** — new component |
| `dashboard/src/pages/AssignmentDetail.tsx` | **Modify** — wire up panel, remove sidebar card, extend Chip |

## Step 1: Create `DependencyPanel` component

New file: `dashboard/src/components/DependencyPanel.tsx`

**Props:**
```typescript
interface DependencyPanelProps {
  missionSlug: string;
  dependencies: Array<{
    slug: string;
    title: string;
    status: string;
    priority: string;
    assignee: string | null;
  }>;
  blockedReason: string | null;
}
```

**Behavior:**
- If `dependencies.length === 0` → render nothing
- If all deps are `completed` or `review` → compact green bar: "All N dependencies resolved" with expand toggle
- If any deps are unmet → expanded card with amber warning banner + dependency list

**Expanded layout (per dependency row):**
- `StatusBadge` (left) → title + slug (middle) → optional assignee → arrow link icon (right)
- Each row is a `<Link>` to the dependency's detail page
- Rows separated by `divide-y`

**Warning banner** (when unmet deps exist):
- Amber border/bg, `AlertCircle` icon
- Text: "N dependencies are not yet completed"
- If `blockedReason` is set, show it inline below

**Collapsed bar** (all resolved):
- Emerald border/bg, `CheckCircle2` icon
- "All N dependencies resolved" + "Show details" toggle
- When expanded, shows the same list as the expanded variant

## Step 2: Modify `AssignmentDetail.tsx`

### 2a. Add data fetching

Add `useMission(slug)` alongside existing `useAssignment` call (~line 40). Derive enriched deps:

```typescript
const { data: mission } = useMission(slug);

const enrichedDeps = useMemo(() => {
  if (!assignment || !mission) return [];
  const map = new Map(mission.assignments.map((a) => [a.slug, a]));
  return assignment.dependsOn.map((depSlug) => {
    const s = map.get(depSlug);
    return {
      slug: depSlug,
      title: s?.title ?? depSlug,
      status: s?.status ?? 'pending',
      priority: s?.priority ?? 'medium',
      assignee: s?.assignee ?? null,
    };
  });
}, [assignment, mission]);

const unmetDeps = enrichedDeps.filter(
  (d) => d.status !== 'completed' && d.status !== 'review'
);
```

### 2b. Insert `DependencyPanel`

Place between the sticky header (`</div>` at ~line 202) and the grid (`<div className="grid ...">` at ~line 204):

```tsx
{enrichedDeps.length > 0 && (
  <DependencyPanel
    missionSlug={slug!}
    dependencies={enrichedDeps}
    blockedReason={assignment.blockedReason}
  />
)}
```

### 2c. Remove sidebar Dependencies card

Delete the `<SectionCard title="Dependencies">` block (lines 385–401).

### 2d. Extend `Chip` for color variants

Update the local `Chip` function to accept `variant?: 'default' | 'warning' | 'success'`:

```typescript
function Chip({ label, variant = 'default' }: { label: string; variant?: 'default' | 'warning' | 'success' }) {
  const cls = {
    default: 'border-border/60 bg-background/80 text-muted-foreground',
    warning: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300',
    success: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300',
  }[variant];
  return (
    <span className={`rounded-full border px-3 py-1 text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}
```

Update the dependencies Chip usage (line 196):
```tsx
<Chip
  label={`${assignment.dependsOn.length} dependencies`}
  variant={unmetDeps.length > 0 ? 'warning' : enrichedDeps.length > 0 ? 'success' : 'default'}
/>
```

## Verification

1. Run `cd dashboard && npm run dev` to start the dev server
2. Navigate to an assignment with dependencies → verify the panel appears full-width above the content tabs, showing status badges, titles, and links
3. Navigate to an assignment with all completed dependencies → verify the compact green bar appears with expand toggle
4. Navigate to an assignment with no dependencies → verify no panel renders
5. Navigate to a blocked assignment with unmet dependencies → verify amber warning with blocked reason
6. Click a dependency link → verify navigation to the correct assignment detail
7. Verify dark mode styling looks correct
