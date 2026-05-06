# Surface externalIds on Assignment and Project Headers

**Date:** 2026-05-01
**Complexity:** small
**Tech Stack:** TypeScript + React 18 + Vite, react-router-dom v7, Tailwind v3 (shadcn-style), `lucide-react`, `cn()` from `dashboard/src/lib/utils.ts`. CLI side: Node TypeScript + Vitest.

## Objective
Render a project's/assignment's `externalIds` (e.g. `jira:PROJ-123`) as small linked badges in the assignment detail header, the standalone assignment header, and the project header. Two pre-requisites: (a) the contract for `url` must allow `null` so unlinked entries survive parsing, and (b) project-side data needs to be plumbed through parser → types → API → hook.

## Files
| File | Action | Purpose |
|------|--------|---------|
| `src/lifecycle/types.ts` | MODIFY | Widen `ExternalId.url` to `string \| null` |
| `src/lifecycle/frontmatter.ts` | MODIFY | Keep entries with missing/empty `url`, default to `null` |
| `src/dashboard/parser.ts` | MODIFY | Same widening on `ParsedAssignmentFull` shape; same parser change; add `externalIds` to `ParsedProject` and populate from `parseProject()` |
| `src/dashboard/types.ts` | MODIFY | Widen `ExternalIdInfo.url` to `string \| null`; add `externalIds: ExternalIdInfo[]` to `ProjectDetail` |
| `src/dashboard/api.ts` | MODIFY | Include `externalIds` in `getProjectDetail()` return object |
| `dashboard/src/hooks/useProjects.ts` | MODIFY | Widen `ExternalIdInfo.url` to `string \| null`; add `externalIds: ExternalIdInfo[]` to `ProjectDetail` |
| `dashboard/src/components/ExternalIdBadges.tsx` | CREATE | Reusable badge group; renders `null` when empty |
| `dashboard/src/pages/AssignmentDetail.tsx` | MODIFY | Insert badges in sticky header flex row |
| `dashboard/src/pages/StandaloneAssignmentDetail.tsx` | MODIFY | Insert badges in header flex row |
| `dashboard/src/pages/ProjectDetail.tsx` | MODIFY | Insert badges in header flex row |
| `src/__tests__/dashboard-parser.test.ts` | MODIFY | Add `parseProject` externalIds case + URL-less entry case |
| `src/__tests__/frontmatter.test.ts` | MODIFY | Add URL-less entry case for the lifecycle parser |
| `src/__tests__/dashboard-api.test.ts` | MODIFY | Extend `PROJECT_MD` fixture (line 104) to include non-empty `externalIds`; assert `getProjectDetail` returns them |

## Tasks

### 1. Widen the `url` contract to allow `null`
The protocol spec (`docs/protocol/file-formats.md:89`) declares `externalIds[].url` as optional with default `null`, but the codebase rejects entries when `url` is missing (`src/dashboard/parser.ts:244`, `src/lifecycle/frontmatter.ts:78`) and the type declares `url: string` (non-nullable). Fix both ends:

- **File:** `src/lifecycle/types.ts` — change `ExternalId.url: string` to `string | null` (currently line 35).
- **File:** `src/lifecycle/frontmatter.ts` — at lines 78-84, drop the `entry['url']` requirement from the if-check (require only `system` and `id`). Push `{ system, id, url: entry['url'] || null }`.
- **File:** `src/dashboard/parser.ts` — three changes:
  1. Update `ParsedAssignmentFull.externalIds` shape at line 214 to `Array<{ system: string; id: string; url: string | null }>`.
  2. Update `parseExternalIds` return type at line 221 to match.
  3. At lines 244-250, drop the `entry['url']` requirement; push `{ system, id, url: entry['url'] || null }`.
- **File:** `src/dashboard/types.ts` — change `ExternalIdInfo.url: string` to `string | null` (currently line 110-114).
- **File:** `dashboard/src/hooks/useProjects.ts` — change `ExternalIdInfo.url: string` to `string | null` (currently line 108-112).
- **Verify:** `cd /Users/brennen/syntaur && npm run typecheck`.

### 2. Add `externalIds` to project parsing
- **File:** `src/dashboard/parser.ts` (MODIFY)
- **What:** Add `externalIds: Array<{ system: string; id: string; url: string | null }>` to the `ParsedProject` interface (currently lines 84-97). In `parseProject()` (lines 99-119), call the existing `parseExternalIds(fm)` helper (lines 221-253) and include it on the returned object — same pattern `parseAssignmentFull` uses at line 276.
- **Pattern:** Follow `parseAssignmentFull` at `src/dashboard/parser.ts:255-282`.
- **Verify:** `cd /Users/brennen/syntaur && npx vitest run src/__tests__/dashboard-parser.test.ts`.

### 3. Plumb `externalIds` through CLI types and API
- **File:** `src/dashboard/types.ts` (MODIFY) — add `externalIds: ExternalIdInfo[]` to `ProjectDetail` (currently lines 82-101). The `ExternalIdInfo` interface (now widened in task 1) lives at lines 110-114.
- **File:** `src/dashboard/api.ts` (MODIFY) — in `getProjectDetail()` (lines 657-678), add `externalIds: project.externalIds` to the returned object.
- **Verify:** `cd /Users/brennen/syntaur && npm run typecheck`.

### 4. Mirror `ProjectDetail` change in dashboard hook
- **File:** `dashboard/src/hooks/useProjects.ts` (MODIFY)
- **What:** Add `externalIds: ExternalIdInfo[]` to the `ProjectDetail` interface at lines 80-99. `ExternalIdInfo` (widened in task 1) is already exported from this file.
- **Pattern:** Mirror the assignment hook's `externalIds: ExternalIdInfo[]` line at `dashboard/src/hooks/useProjects.ts:140`.
- **Verify:** `cd dashboard && npx tsc --noEmit`.

### 5. Create `ExternalIdBadges` component
- **File:** `dashboard/src/components/ExternalIdBadges.tsx` (CREATE)
- **What:** React component that takes `{ externalIds: ExternalIdInfo[]; className?: string }` and returns `null` when the array is empty. Otherwise renders a `flex flex-wrap items-center gap-1.5` container with one badge per entry. Each badge shows `<system>:<id>`. When `url` is non-null AND non-empty, render as `<a href={url} target="_blank" rel="noopener noreferrer">` with a small `ExternalLink` icon (`h-2.5 w-2.5`) trailing the text; otherwise render as a `<span>` with no icon. Import `ExternalIdInfo` from `../hooks/useProjects` and `cn` from `../lib/utils`.
- **Pattern:** Match `StatusBadge` pill styling baseline at `dashboard/src/components/StatusBadge.tsx:132-144` (`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold tracking-wide`). Use a muted/neutral tone like `border-border/60 text-muted-foreground hover:text-foreground hover:border-foreground/40` so badges don't compete with `StatusBadge`. Reference `ExternalLink` icon usage at `dashboard/src/pages/AssignmentDetail.tsx:700-706`.
- **Verify:** `cd dashboard && npx tsc --noEmit`.

### 6. Render badges in `AssignmentDetail` sticky header
- **File:** `dashboard/src/pages/AssignmentDetail.tsx` (MODIFY)
- **What:** Import `ExternalIdBadges`. Insert `<ExternalIdBadges externalIds={assignment.externalIds} />` inside the sticky header flex row, between the unmet-deps `<span>` (lines 366-370) and the `ml-auto` action `<span>` (line 371). Because the action span uses `ml-auto`, the badges naturally sit beside title metadata without disturbing the actions cluster.
- **Pattern:** Header flex row at lines 360-392.
- **Verify:** `cd dashboard && npx tsc --noEmit && npm run build`.

### 7. Render badges in `StandaloneAssignmentDetail` header
- **File:** `dashboard/src/pages/StandaloneAssignmentDetail.tsx` (MODIFY)
- **What:** Import `ExternalIdBadges`. Insert `<ExternalIdBadges externalIds={assignment.externalIds} />` in the flex row at line 29, between the id `<span>` (line 31) and the `Edit` link (lines 32-37). The Edit link's `ml-auto` keeps it pinned right.
- **Pattern:** Header flex row at lines 28-43.
- **Verify:** `cd dashboard && npx tsc --noEmit`.

### 8. Render badges in `ProjectDetail` header
- **File:** `dashboard/src/pages/ProjectDetail.tsx` (MODIFY)
- **What:** Import `ExternalIdBadges`. Insert `<ExternalIdBadges externalIds={project.externalIds} />` in the project header flex row immediately before the trailing "Created… Last source update…" `<span>` at line 176. Source data is `project.externalIds` (available after tasks 2-4 land).
- **Pattern:** Header flex row at lines 123-177.
- **Verify:** `cd dashboard && npx tsc --noEmit && npm run build`.

### 9. Extend Vitest coverage
- **File:** `src/__tests__/dashboard-parser.test.ts` (MODIFY) — add two cases:
  1. A `parseProject` case asserting `externalIds` is populated from a project frontmatter block (mirrors the existing assignment case at lines 186-194).
  2. An assignment case asserting URL-less entries (only `system` + `id`) survive parsing with `url: null`.
- **File:** `src/__tests__/frontmatter.test.ts` (MODIFY) — add a case asserting the lifecycle parser preserves URL-less entries with `url: null` (mirrors the existing case at line 95).
- **File:** `src/__tests__/dashboard-api.test.ts` (MODIFY) — modify the `PROJECT_MD` fixture at line 104 (the shared project fixture used by `getProjectDetail` tests) to include a non-empty `externalIds` block in frontmatter, and add an assertion to one `getProjectDetail` test (e.g., the existing test at line 263+) that the returned `externalIds` matches the fixture entries.
- **Verify:** `cd /Users/brennen/syntaur && npx vitest run src/__tests__/dashboard-parser.test.ts src/__tests__/frontmatter.test.ts src/__tests__/dashboard-api.test.ts`.

## Dependencies
- None. All required pieces (`parseExternalIds`, `ExternalLink` from `lucide-react`, `cn`, `StatusBadge` reference styling) already exist. Task 1 must land before any consumer task — it changes a public type.

## Verification
- `cd /Users/brennen/syntaur && npm run typecheck`
- `cd /Users/brennen/syntaur && npx vitest run src/__tests__/dashboard-parser.test.ts src/__tests__/frontmatter.test.ts src/__tests__/dashboard-api.test.ts`
- `cd /Users/brennen/syntaur/dashboard && npx tsc --noEmit && npm run build`
- Manual fixture (must cover all three header surfaces):
  - **Project header** (`/projects/:slug`): non-empty `externalIds` block in `project.md` frontmatter — confirm pill badges render.
  - **Assignment detail** (project-nested, `/projects/:slug/assignments/:slug`): non-empty `externalIds` in `assignment.md` — confirm badges render in sticky header.
  - **Standalone assignment** (`/assignments/:id`): non-empty `externalIds` in standalone `assignment.md` — confirm badges render in header.
  - In each case, include both a linked entry (with `url:`) and an unlinked entry (no `url:` line) and confirm the linked one opens in a new tab while the unlinked one renders as plain text.
  - Confirm that headers with empty `externalIds` (the default) show no empty container or label.
