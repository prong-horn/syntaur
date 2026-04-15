# Assignment Linking

**Date:** 2026-04-15
**Complexity:** small
**Tech Stack:** TypeScript, Node.js, Express 5, React 19, YAML frontmatter data store

## Objective
Add a `links` field to assignments that enables cross-mission bidirectional linking between assignments. Links use `missionSlug/assignmentSlug` format and reverse links are computed at read time.

## Design Decisions

1. **API contract:** The detail endpoint returns `links: string[]` (forward, from frontmatter) and `reverseLinks: string[]` (computed at read time). These are separate fields — the frontend merges them for display.
2. **Link format:** Always `missionSlug/assignmentSlug`. Validated as `split('/').length === 2 && both parts pass isValidSlug`.
3. **Broken-link fallback:** If a linked assignment's mission or assignment doesn't exist, show the raw slug as the title with a `pending` status badge (same pattern as `enrichedDeps` in `AssignmentDetail.tsx:52-60`).
4. **Self-links:** Silently filtered out at read time — a link pointing to itself is dropped from both `links` and `reverseLinks`.
5. **Duplicates:** Deduplicated at read time. If A→B is in both forward links and reverse links, it appears once.
6. **Workspace-scoped routes:** `LinksPanel` uses `useWorkspacePrefix()` to build navigation URLs, matching the `/w/:workspace/...` route pattern.

## Files
| File | Action | Purpose |
|------|--------|---------|
| `src/lifecycle/types.ts` | MODIFY | Add `links: string[]` to `AssignmentFrontmatter` |
| `src/lifecycle/frontmatter.ts` | MODIFY | Add `parseLinks()` function, wire into `parseAssignmentFrontmatter()` |
| `src/templates/assignment.ts` | MODIFY | Add `links` to `AssignmentParams` and rendered YAML |
| `src/dashboard/parser.ts` | MODIFY | Add `links` to `ParsedAssignmentSummary`, `ParsedAssignmentFull`, parse calls |
| `src/dashboard/types.ts` | MODIFY | Add `links: string[]` to `AssignmentSummary`, `AssignmentDetail`; add `reverseLinks: string[]` to `AssignmentDetail` |
| `src/dashboard/api.ts` | MODIFY | Pass `links` through in `toAssignmentSummary`; compute `reverseLinks` in `getAssignmentDetail()` |
| `src/dashboard/api-write.ts` | MODIFY | Add `links: []` to template endpoint |
| `src/index.ts` | MODIFY | Add `--links <slugs>` CLI option |
| `src/commands/create-assignment.ts` | MODIFY | Parse and validate `--links` option |
| `dashboard/src/lib/documents.ts` | MODIFY | Add `links` to `AssignmentEditorState`, `parseAssignmentEditorState`, `updateAssignmentContent` |
| `dashboard/src/components/MarkdownEditor.tsx` | MODIFY | Add "Links" field to assignment editor form |
| `dashboard/src/hooks/useMissions.ts` | MODIFY | Add `links: string[]` to `AssignmentSummary`; add `links: string[]` and `reverseLinks: string[]` to `AssignmentDetail` |
| `dashboard/src/pages/AssignmentDetail.tsx` | MODIFY | Enrich and render links (forward + reverse) using LinksPanel |
| `dashboard/src/components/LinksPanel.tsx` | CREATE | Simplified version of `DependencyPanel` for linked assignments |
| `src/__tests__/frontmatter.test.ts` | MODIFY | Add `links` parsing tests |
| `src/__tests__/dashboard-parser.test.ts` | MODIFY | Add `links` field parser tests |
| `src/__tests__/templates.test.ts` | MODIFY | Verify template renders `links` |
| `src/__tests__/dashboard-api.test.ts` | MODIFY | Add reverse-link computation tests |
| `src/__tests__/dashboard-write.test.ts` | MODIFY | Add `links` to template endpoint tests |
| `src/__tests__/commands.test.ts` | MODIFY | Add `--links` CLI parsing/validation tests |

## Tasks

### 1. Add `links` to core types
- **File:** `src/lifecycle/types.ts` (MODIFY)
- **What:** Add `links: string[]` to `AssignmentFrontmatter` interface, next to `dependsOn`
- **Pattern:** Same shape as `dependsOn: string[]` on line 55
- **Verify:** `npx tsc --noEmit`

### 2. Add `parseLinks()` to lifecycle frontmatter parser
- **File:** `src/lifecycle/frontmatter.ts` (MODIFY)
- **What:** Add a `parseLinks()` function (identical to `parseDependsOn` at lines 25-38 but for `links`). Wire it into `parseAssignmentFrontmatter()` return object at line 130.
- **Pattern:** Copy `parseDependsOn` exactly, replace field name
- **Verify:** `npx vitest run src/__tests__/frontmatter.test.ts`

### 3. Add `links` to assignment template
- **File:** `src/templates/assignment.ts` (MODIFY)
- **What:** Add `links: string[]` to `AssignmentParams` interface. Add `linksYaml` rendering logic identical to `dependsOnYaml` (lines 14-17). Insert rendered `links` into the template YAML between `dependsOn` and `blockedReason`.
- **Pattern:** Follow `dependsOnYaml` pattern exactly
- **Verify:** `npx vitest run src/__tests__/templates.test.ts`

### 4. Add `links` to dashboard parser
- **File:** `src/dashboard/parser.ts` (MODIFY)
- **What:** Add `links: string[]` to `ParsedAssignmentSummary` (line 162) and `ParsedAssignmentFull` (line 189). Add `parseListField(fm, 'links')` to both `parseAssignmentSummary()` (line 182) and `parseAssignmentFull()` (line 254).
- **Pattern:** Identical to `dependsOn: parseListField(fm, 'dependsOn')` usage
- **Verify:** `npx vitest run src/__tests__/dashboard-parser.test.ts`

### 5. Add `links` and `reverseLinks` to dashboard API types
- **File:** `src/dashboard/types.ts` (MODIFY)
- **What:** Add `links: string[]` to `AssignmentSummary` (line 32). Add both `links: string[]` and `reverseLinks: string[]` to `AssignmentDetail` (line 103).
- **Pattern:** Same as `dependsOn: string[]` on those interfaces
- **Verify:** `npx tsc --noEmit`

### 6. Wire `links` and `reverseLinks` through dashboard API
- **File:** `src/dashboard/api.ts` (MODIFY)
- **What:**
  - (a) Add `links: assignment.links` to `toAssignmentSummary()` at line 813.
  - (b) Add `links: assignment.links` to the return object in `getAssignmentDetail()` at line 583.
  - (c) Compute `reverseLinks`: after building the detail response, call `listMissionRecords()` (already used at line 604) to scan all missions/assignments. Collect any assignment whose `links` array contains `${missionSlug}/${assignmentSlug}` (the current assignment's qualified slug). Return these as `reverseLinks: string[]` in `missionSlug/assignmentSlug` format.
  - (d) Filter self-links: exclude any link where `linkMission === missionSlug && linkAssignment === assignmentSlug`.
  - (e) Deduplicate: if a slug appears in both `links` and `reverseLinks`, keep it only in `links`.
- **Pattern:** `toAssignmentSummary` passes through `dependsOn` the same way. `listMissionRecords` is already used in attention/board endpoints.
- **Verify:** `npx vitest run src/__tests__/dashboard-api.test.ts`

### 7. Update template endpoint in write API
- **File:** `src/dashboard/api-write.ts` (MODIFY)
- **What:** Add `links: []` to the `renderAssignment()` call at line 186
- **Pattern:** Same as `dependsOn: []` already passed there
- **Verify:** `npx vitest run src/__tests__/dashboard-write.test.ts`

### 8. Add `--links` CLI option
- **File:** `src/index.ts` (MODIFY)
- **What:** Add `.option('--links <slugs>', 'Comma-separated linked assignment slugs (missionSlug/assignmentSlug format)')` next to `--depends-on` at line 80
- **File:** `src/commands/create-assignment.ts` (MODIFY)
- **What:** Parse `options.links` with the same comma-split pattern as `dependsOn` (line 58-60). Validate each link: `const parts = link.split('/'); parts.length === 2 && parts.every(isValidSlug)`. Pass `links` to `renderAssignment()`.
- **Pattern:** Follow `dependsOn` parsing at lines 58-67
- **Verify:** `npx vitest run src/__tests__/commands.test.ts`

### 9. Add `links` to dashboard editor (documents.ts + MarkdownEditor.tsx)
- **File:** `dashboard/src/lib/documents.ts` (MODIFY)
- **What:**
  - Add `links: string` to `AssignmentEditorState` interface (line 20-30). String type because the editor stores comma-separated values (same as `dependsOn: string` on line 26).
  - In `parseAssignmentEditorState()` (line 227): add `links: getStringList(model, 'links').join(', ')`.
  - In `updateAssignmentContent()` (line 242): add `setStringList(model, 'links', commaListToArray(next.links))` after the `dependsOn` line (line 254).
- **File:** `dashboard/src/components/MarkdownEditor.tsx` (MODIFY)
- **What:** Add a "Links" field after the "Depends on" field (after line 314). Same structure:
  ```tsx
  <Field label="Links" className="md:col-span-2">
    <input
      value={state.links}
      onChange={(event) => onChange(normalizeEditorContent(documentType, content, { links: event.target.value }))}
      placeholder="Comma-separated: missionSlug/assignmentSlug"
      className="editor-input"
    />
  </Field>
  ```
- **Pattern:** Identical to the "Depends on" field at lines 307-314
- **Verify:** `npm run build --prefix dashboard`

### 10. Add `links` and `reverseLinks` to frontend types
- **File:** `dashboard/src/hooks/useMissions.ts` (MODIFY)
- **What:** Add `links: string[]` to `AssignmentSummary` (line 31). Add `links: string[]` and `reverseLinks: string[]` to `AssignmentDetail` (line 113).
- **Pattern:** Same as `dependsOn: string[]` on those interfaces
- **Verify:** `npx tsc --noEmit --project dashboard/tsconfig.json`

### 11. Create LinksPanel component
- **File:** `dashboard/src/components/LinksPanel.tsx` (CREATE)
- **What:** Build a simplified version of `DependencyPanel.tsx`. Props:
  ```ts
  interface LinkedAssignmentInfo {
    slug: string;           // missionSlug/assignmentSlug
    missionSlug: string;
    assignmentSlug: string;
    title: string;          // fallback to raw slug if not found
    status: string;         // fallback to 'pending'
    isReverse: boolean;     // true if this is a reverse link
  }
  interface LinksPanelProps {
    links: LinkedAssignmentInfo[];
  }
  ```
  Shows linked assignments with `StatusBadge`, title, slug, a directional indicator (→ forward / ← reverse), and a navigation link. No met/unmet semantics — just a flat list. Uses `useWorkspacePrefix()` to build routes: `` `${wsPrefix}/missions/${link.missionSlug}/assignments/${link.assignmentSlug}` ``.
- **Pattern:** Follow `DependencyPanel.tsx` structure (lines 47-106) but remove resolved/unresolved logic. Use `SectionCard` wrapper, `StatusBadge`, and `Link` from react-router-dom.
- **Verify:** `npm run build --prefix dashboard`

### 12. Integrate LinksPanel into AssignmentDetail page
- **File:** `dashboard/src/pages/AssignmentDetail.tsx` (MODIFY)
- **What:** Import `LinksPanel`. Enrich links using the backend-provided data:
  - For **forward links** (`assignment.links`): for each `missionSlug/assignmentSlug`, use `listMissionRecords` data already available via the API. Since links are cross-mission and the page only has the current mission's data (`mission.assignments` map at line 51), the backend must return enriched link data. Add an `enrichedLinks` field to the API response in Task 6 that includes `{ slug, missionSlug, assignmentSlug, title, status }` for each forward and reverse link. This avoids the frontend needing to fetch multiple missions.
  - **Updated approach for Task 6:** In `getAssignmentDetail()`, after computing forward and reverse link slugs, enrich each by reading the target assignment's summary via `listMissionRecords()`. Return `enrichedLinks: Array<{ slug: string, missionSlug: string, assignmentSlug: string, title: string, status: string, isReverse: boolean }>` on the `AssignmentDetail` response.
  - Render `LinksPanel` below the `DependencyPanel` section (after line 231).
- **Pattern:** Follow `enrichedDeps` pattern (lines 49-62) but data comes pre-enriched from the API
- **Verify:** `npm run build --prefix dashboard`

### 13. Add backend tests
- **File:** `src/__tests__/frontmatter.test.ts` (MODIFY)
- **What:** Add `links: []` to the simple fixture YAML and `links` entries (in `missionSlug/assignmentSlug` format) to the complex fixture. Assert parsing in both test cases.
- **File:** `src/__tests__/dashboard-parser.test.ts` (MODIFY)
- **What:** Add `links` field to test fixtures, verify `parseAssignmentSummary` and `parseAssignmentFull` parse it.
- **File:** `src/__tests__/templates.test.ts` (MODIFY)
- **What:** Pass `links` to `renderAssignment()`, verify output contains `links: []` and populated list format.
- **Pattern:** Follow existing `dependsOn` test patterns in each file
- **Verify:** `npx vitest run`

### 14. Add API and CLI tests
- **File:** `src/__tests__/dashboard-api.test.ts` (MODIFY)
- **What:** Test reverse-link computation: create two assignments where A links to B, verify B's detail response includes A in `reverseLinks`. Test self-link filtering. Test deduplication when A→B and B→A both exist.
- **File:** `src/__tests__/dashboard-write.test.ts` (MODIFY)
- **What:** Verify template endpoint includes `links: []` in rendered assignment content.
- **File:** `src/__tests__/commands.test.ts` (MODIFY)
- **What:** Test `--links` parsing: valid `missionA/assignment1` passes, invalid `no-slash` fails, `too/many/slashes` fails, empty string results in `[]`.
- **Pattern:** Follow existing `dependsOn` / `--depends-on` test patterns
- **Verify:** `npx vitest run`

## Task Dependencies

```
1 → 2 → 3 (core types → parser → template)
1 → 4 (core types → dashboard parser)
5 → 6 → 7 (API types → API wiring → write API)
5 → 10 (API types → frontend types)
6 → 12 (API wiring with enriched data → frontend integration)
9 (editor support, independent after Task 1)
11 → 12 (LinksPanel component → integration)
1-8 → 13 (backend tasks → backend tests)
6,7,8 → 14 (API/CLI tasks → API/CLI tests)
```

## Verification
- `npx vitest run` — all tests pass
- `npx tsc --noEmit` — no type errors
- `npm run build --prefix dashboard` — frontend builds
- Manual: create an assignment with `--links missionA/assignment1`, verify it appears on both assignment detail pages
- Manual: open dashboard editor, verify Links field appears and saves correctly
- Manual: verify workspace-scoped routes (`/w/:workspace/missions/...`) work for link navigation
