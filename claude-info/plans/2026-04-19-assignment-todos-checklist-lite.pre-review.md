# Assignment Todos Checklist (replace single-plan model)

**Date:** 2026-04-19
**Complexity:** small
**Tech Stack:** TypeScript (ESM, strict), Node.js 20+, Express 5, React 19, Vitest. Markdown + YAML frontmatter protocol mirrored across `platforms/claude-code/` and `platforms/codex/`.

## Objective

Replace the single `plan.md`-per-assignment model with a markdown todo checklist inside `assignment.md`. Todos are informal — they live in a new `## Todos` section and can be simple text or a link to a plan file (`plan.md`, `plan-v2.md`, ...). `/plan-assignment` now creates versioned plan files and appends todos; requirements shifts are handled by superseding a todo rather than rewriting `plan.md`.

## Conventions (normative)

- **Todos section:** new `## Todos` heading in `assignment.md` body, between `## Acceptance Criteria` and `## Context`. Items are GitHub checkboxes (`- [ ]` / `- [x]`). May contain plain text or a markdown link to a plan file inside the assignment dir.
- **Superseded-todo marker:** `- [x] ~~Execute [old plan](./plan.md)~~ (superseded by plan-v2)`. Checked + strikethrough + parenthetical pointer to the replacement. Never delete the old line — preserve history.
- **Plan filename versioning:** first plan is `plan.md`; subsequent runs pick the smallest unused `plan-v<N>.md` where `N >= 2` by scanning `plan*.md` in `assignmentDir`.
- **Plan todo text:** `- [ ] Execute [plan](./plan.md)` for v1, `- [ ] Execute [plan v2](./plan-v2.md)` for v2+.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/templates/assignment.ts` | MODIFY | Add `## Todos` section, remove hardcoded `- [Plan](./plan.md)` from `## Links` |
| `src/commands/create-assignment.ts` | MODIFY | Stop scaffolding `plan.md` (remove lines 158–165) |
| `src/dashboard/api-write.ts` | MODIFY | Stop scaffolding `plan.md` in dashboard create path (line 417) |
| `src/utils/doctor/checks/assignment.ts` | MODIFY | Relax `STATUSES_REQUIRING_PLAN` — plan is now optional |
| `src/templates/codex-agents.ts` | MODIFY | Remove `plan.md` from reading-order, directory tree, and writable lists where it implied exactly-one-plan; describe plans as optional and versioned |
| `src/templates/cursor-rules.ts` | MODIFY | Same edits as codex-agents.ts (reading order, writable files) |
| `platforms/claude-code/skills/create-assignment/SKILL.md` | MODIFY | Drop `plan.md` from scaffolded files list; mention `## Todos` section |
| `platforms/claude-code/skills/plan-assignment/SKILL.md` | MODIFY | New Step 4 behavior: pick next `plan-v<N>.md`, write it, append Todos entry, mark prior plan todo superseded |
| `platforms/claude-code/skills/complete-assignment/SKILL.md` | MODIFY | Step 2 also verifies all Todos are checked or marked superseded |
| `platforms/claude-code/skills/grab-assignment/SKILL.md` | MODIFY | Step 4 reads the Todos section too |
| `platforms/claude-code/skills/syntaur-protocol/SKILL.md` | MODIFY | Writable list reads "plan files" not `plan.md` |
| `platforms/codex/skills/create-assignment/SKILL.md` | MODIFY | Mirror Claude |
| `platforms/codex/skills/plan-assignment/SKILL.md` | MODIFY | Mirror Claude |
| `platforms/codex/skills/complete-assignment/SKILL.md` | MODIFY | Mirror Claude (if present — scout says mirror exists) |
| `platforms/codex/skills/grab-assignment/SKILL.md` | MODIFY | Mirror Claude |
| `platforms/codex/skills/syntaur-protocol/SKILL.md` | MODIFY | Mirror Claude |
| `platforms/claude-code/references/protocol-summary.md` | MODIFY | Directory tree notes plans are optional & versioned; describe Todos section |
| `platforms/claude-code/references/file-ownership.md` | MODIFY | Generalize `plan.md` → `plan*.md` (optional) |
| `platforms/codex/references/protocol-summary.md` | MODIFY | Mirror |
| `platforms/codex/references/file-ownership.md` | MODIFY | Mirror |
| `docs/protocol/file-formats.md` | MODIFY | Section 3 adds `## Todos` body section + supersede convention; Section 4 says 0+ plan files allowed, versioned naming |
| `docs/protocol/spec.md` | MODIFY | Remove single-plan assumptions |
| `dashboard/src/pages/AssignmentDetail.tsx` | MODIFY | Render Todos markdown block (clickable links) in the summary tab; keep existing Plan tab |
| `src/dashboard/help.ts` | MODIFY | Update help text (lines 288, 424) |
| `src/__tests__/templates.test.ts` | MODIFY | Assert `## Todos` present; drop `(./plan.md)` assertion from assignment body |
| `src/__tests__/commands.test.ts` | MODIFY | Scaffolded files no longer include `plan.md`; expect length 4 |
| `src/__tests__/adapter-templates.test.ts` | MODIFY | Reading-order assertion no longer requires `plan.md` |

No files need to be created or deleted.

## Tasks

### 1. Update assignment template body

- **File:** `src/templates/assignment.ts` (MODIFY)
- **What:** Insert a new `## Todos` section after `## Acceptance Criteria` (before `## Context`). Body: a single guidance HTML comment explaining the format and supersede convention, followed by no checkbox items. Remove `- [Plan](./plan.md)` from the `## Links` section (keep scratchpad, handoff, decision-record).
- **Pattern:** Follow the shape of the existing `## Acceptance Criteria` block (assignment.ts:51-55). Guidance comment mirrors the style used in `## Objective`.
- **Verify:** `npx vitest run src/__tests__/templates.test.ts`

### 2. Stop scaffolding plan.md

- **File:** `src/commands/create-assignment.ts` (MODIFY)
- **What:** Remove the `plan.md` entry from the `files` array (lines 158–165). Remove the now-unused `renderPlan` import if no other call sites exist.
- **Pattern:** Parallel structure of the remaining scratchpad/handoff/decision-record entries.
- **Verify:** `npx vitest run src/__tests__/commands.test.ts`

### 3. Mirror scaffolding change in dashboard

- **File:** `src/dashboard/api-write.ts` (MODIFY)
- **What:** Remove the `plan.md` entry from the `companions` array (line 417). Remove `renderPlan` import if unused.
- **Verify:** `npx vitest run src/__tests__/dashboard-write.test.ts`

### 4. Relax doctor plan check

- **File:** `src/utils/doctor/checks/assignment.ts` (MODIFY)
- **What:** Remove the `STATUSES_REQUIRING_PLAN` constant and the `if (STATUSES_REQUIRING_PLAN.has(...))` block (lines 10, 208–211). Plans are optional. Keep handoff check.
- **Verify:** `npm run typecheck` and run any doctor tests: `npx vitest run src/__tests__ -t doctor`

### 5. Rewrite `/plan-assignment` skill — versioned plan + Todos linkage

- **File:** `platforms/claude-code/skills/plan-assignment/SKILL.md` (MODIFY)
- **What:** Replace Step 4 ("Write the Plan") with three substeps:
  1. **Determine plan filename.** Use Glob `<assignmentDir>/plan*.md`. If none exists, target is `plan.md`. Otherwise pick the smallest `N >= 2` such that `plan-v<N>.md` does not exist.
  2. **Write the plan file.** If it's `plan.md` and doesn't exist yet, create it with the standard plan frontmatter (`assignment`, `status: draft`, `created`, `updated`) and body. For `plan-v<N>.md`, create with the same frontmatter but `status: draft` and a fresh `created` timestamp. If the target file exists (only `plan.md` can exist on first re-run), preserve frontmatter and replace body, flipping `status` from `draft` to `in_progress`.
  3. **Update `assignment.md` Todos.** Read the `## Todos` section. If any unchecked todo matches `Execute [.*plan.*](./plan(?:-v\d+)?\.md)`, convert it to the supersede form: `- [x] ~~<original text>~~ (superseded by plan-v<N>)`. Then append a new line: `- [ ] Execute [plan](./plan.md)` (or `[plan v<N>](./plan-v<N>.md)` for v2+).
- **Pattern:** Existing Step 4 structure for editing markdown via Edit tool. The supersede regex/pattern mirrors the Acceptance Criteria checkbox edits in `complete-assignment/SKILL.md` Step 4.
- **Verify:** Manual: create a throwaway assignment, run `/plan-assignment` twice, confirm `plan.md` and `plan-v2.md` both exist and `## Todos` shows one superseded line + one active line.

### 6. Update `/create-assignment` skill text

- **File:** `platforms/claude-code/skills/create-assignment/SKILL.md` (MODIFY)
- **What:** Step 3 currently lists `plan.md` among created files (line 61). Remove it. Add a line noting "assignment.md includes a `## Todos` section — add todos as you plan work, or run `/plan-assignment` to create a plan file and link it automatically."
- **Verify:** Visual diff; no test.

### 7. Update `/grab-assignment` skill

- **File:** `platforms/claude-code/skills/grab-assignment/SKILL.md` (MODIFY)
- **What:** In Step 4 ("Read Assignment Context"), extend "Read the objective and acceptance criteria from the markdown body." to also read the `## Todos` section. In Step 6 reporting, include active todos alongside acceptance criteria.
- **Verify:** Visual diff.

### 8. Update `/complete-assignment` skill

- **File:** `platforms/claude-code/skills/complete-assignment/SKILL.md` (MODIFY)
- **What:** Extend Step 2 to also verify every `- [ ]` todo in the `## Todos` section is either checked (`- [x]`) or marked superseded per the convention. Unfinished todos get the same warn-and-confirm flow as unmet acceptance criteria. Extend Step 4 to also update Todos checkboxes if any were completed.
- **Verify:** Visual diff.

### 9. Update `syntaur-protocol` skill writable files list

- **File:** `platforms/claude-code/skills/syntaur-protocol/SKILL.md` (MODIFY)
- **What:** Change "`assignment.md`, `plan.md`, `scratchpad.md`, ..." (line 17) to "`assignment.md`, `plan*.md` (0 or more plan files), `scratchpad.md`, ..."
- **Verify:** Visual diff.

### 10. Mirror all skill edits to Codex

- **Files:** `platforms/codex/skills/{create-assignment,plan-assignment,complete-assignment,grab-assignment,syntaur-protocol}/SKILL.md` (MODIFY)
- **What:** Apply the textual changes from tasks 5–9 to each Codex SKILL.md. Keep Codex-specific phrasing where it differs (tool names etc.) but match semantics exactly.
- **Pattern:** Platform-mirror convention from AGENTS.md.
- **Verify:** Visual diff per file.

### 11. Update Codex adapter template

- **File:** `src/templates/codex-agents.ts` (MODIFY)
- **What:** Reading Order (lines ~35–44): change step 6 from "`plan.md` -- your implementation plan" to "any `plan*.md` files — each corresponds to a `## Todos` entry in assignment.md; read the ones linked from active todos." Directory Structure (lines ~54–80): change `plan.md            # Agent-writable: implementation plan` to `plan*.md           # Agent-writable: versioned implementation plans (optional, one per `## Todos` entry)`. Write Boundary (line ~86): replace `plan.md` with `plan*.md`. Conventions (line ~159): drop "Keep `plan.md` current after planning changes" or rephrase to "Keep active plan file(s) current".
- **Verify:** `npx vitest run src/__tests__/adapter-templates.test.ts`

### 12. Update Cursor rules template

- **File:** `src/templates/cursor-rules.ts` (MODIFY)
- **What:** Apply the same semantic edits as task 11 at lines 37, 53, 146, 153.
- **Verify:** `npx vitest run src/__tests__/adapter-templates.test.ts`

### 13. Update protocol reference mirrors

- **Files:** `platforms/claude-code/references/protocol-summary.md`, `platforms/claude-code/references/file-ownership.md`, `platforms/codex/references/protocol-summary.md`, `platforms/codex/references/file-ownership.md` (MODIFY)
- **What:** Directory tree and ownership tables: `plan.md` → `plan*.md (optional, 0+)`. Add a one-line description of the `## Todos` section convention and the supersede marker.
- **Verify:** Visual diff.

### 14. Update protocol docs

- **Files:** `docs/protocol/file-formats.md`, `docs/protocol/spec.md` (MODIFY)
- **What:** `file-formats.md` Section 3 (assignment.md body sections): add `## Todos` row to the body-section table with purpose "checklist of work items; may link to plan files" and writer "Agent". Add a paragraph describing the supersede marker format. Section 4 (plan.md): replace "The implementation plan for an assignment. Created as an empty template by scaffolding..." with "Zero or more implementation plan files per assignment. Not scaffolded — created by `/plan-assignment`. Filenames: `plan.md`, `plan-v2.md`, `plan-v3.md`, ...". Clarify linkage to `## Todos`. `spec.md`: grep for "plan.md" and generalize single-plan assumptions.
- **Verify:** `grep -n "plan.md" docs/protocol/*.md` returns only intentional references (examples or the versioning rule).

### 15. Dashboard: render Todos in AssignmentDetail

- **File:** `dashboard/src/pages/AssignmentDetail.tsx` (MODIFY)
- **What:** Extract the `## Todos` section from `assignment.summary` (or the raw body; scout notes this should be straightforward via `splitAssignmentSummary` or similar) and render it with `MarkdownRenderer` as a new `SectionCard` titled "Todos" in the summary tab, below the Acceptance Criteria card. Keep the Plan tab as-is (it already tolerates `plan: null` per api.ts:529).
- **Pattern:** Use the same `SectionCard` + `MarkdownRenderer` shape as the Acceptance Criteria card. Follow `splitAssignmentSummary` (`dashboard/src/lib/acceptanceCriteria.ts`) — may need a parallel helper to split out Todos markdown.
- **Verify:** `npm run typecheck` in repo root; manual smoke via dashboard on a seeded assignment.

### 16. Update dashboard help text

- **File:** `src/dashboard/help.ts` (MODIFY)
- **What:** Lines 288 and 424 reference `plan.md` in help strings. Update to match the new model (plans are optional, todos in assignment.md).
- **Verify:** Visual diff.

### 17. Update tests

- **Files:**
  - `src/__tests__/templates.test.ts` — line 189: drop `expect(out).toContain('(./plan.md)');` Add `expect(out).toContain('## Todos');`.
  - `src/__tests__/commands.test.ts` — line 108: remove `expect(files).toContain('plan.md');` and change line 112 to `expect(files.length).toBe(4);`.
  - `src/__tests__/adapter-templates.test.ts` — line 80: drop `expect(out).toContain('plan.md');` (reading order). Keep other assertions. Add a new assertion that the reading order references plans generically (e.g., `plan*.md` or "plan files").
- **Verify:** `npx vitest run` (whole suite).

### 18. Smoke-test doctor + existing assignments

- **What:** Confirm `syntaur doctor` no longer warns about missing `plan.md` on assignments in `in_progress`/`review`/`completed` states. Run against a fixture or a dev `~/.syntaur/`.
- **Verify:** `syntaur doctor --json | jq '.results[] | select(.detail | contains("plan.md"))'` returns no results.

## Dependencies

None — all changes are in-repo. No new packages, no env vars.

## Verification

Run after all tasks land:

```
npm run typecheck
npx vitest run
syntaur doctor
```

Then manual dashboard smoke test (existing assignment with no `plan.md`, and a freshly created one after running `/plan-assignment` twice to verify versioning + supersede).
