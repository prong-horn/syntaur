# Assignment Todos Checklist (replace single-plan model)

**Date:** 2026-04-19
**Complexity:** small
**Tech Stack:** TypeScript (ESM, strict), Node.js 20+, Express 5, React 19, Vitest. Markdown + YAML frontmatter protocol mirrored across `platforms/claude-code/` and `platforms/codex/`.

## Objective

Replace the single `plan.md`-per-assignment model with a markdown todo checklist inside `assignment.md`. Todos are informal — they live in a new `## Todos` section and can be simple text or a link to a plan file (`plan.md`, `plan-v2.md`, ...). `/plan-assignment` now creates versioned plan files and appends todos; requirements shifts are handled by superseding a todo rather than rewriting `plan.md`.

## Conventions (normative)

- **Naming caveat:** the existing workspace-scoped "Quick Todos" system (`src/todos/`, `dashboard/src/pages/TodosPage.tsx`, `syntaur todo ...` CLI) is unrelated. This plan's `## Todos` lives inside `assignment.md` and is informal markdown — it is NOT parsed by `src/todos/parser.ts`. Do not wire the two together in this change; call them "assignment todos" in user-facing copy where disambiguation matters.
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
| `platforms/claude-code/agents/syntaur-expert.md` | MODIFY | Directory tree (line 58), writable list (line 81), workflow entries (lines 218, 225, 250, 300) — generalize `plan.md` → `plan*.md` |
| `platforms/codex/agents/syntaur-operator.md` | MODIFY | Mirror the same edits (lines 3, 14, 31, 50, 102) |
| `platforms/claude-code/hooks/hooks.json` | MODIFY | Line 10 ExitPlanMode prompt: generalize "update plan.md" to "create or update a plan file (plan.md or plan-v<N>.md) and append a todo linking to it in assignment.md's `## Todos` section" |
| `dashboard/src/pages/EditAssignmentScratchpad.tsx` | MODIFY | Line 20 helpBody mentions `plan.md`; generalize to "plan files" |
| `examples/sample-mission/assignments/design-auth-schema/assignment.md` | MODIFY | Keep `- [Plan](./plan.md)` (this is a completed example with a concrete plan) OR move under a `## Todos` section — pick one consistent convention; scout task before editing |
| `examples/sample-mission/assignments/implement-jwt-middleware/assignment.md` | MODIFY | Same as above |
| `examples/sample-mission/assignments/write-auth-tests/assignment.md` | MODIFY | Same as above |
| `examples/playbooks/read-before-plan.md` | MODIFY | Frontmatter `when_to_use` and body references to `plan.md`: generalize to "plan file(s)" |
| `examples/playbooks/keep-records-updated.md` | MODIFY | Body reference to `plan.md`: generalize to "any active plan file" |

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
- **What:** Remove the `STATUSES_REQUIRING_PLAN` constant at line 10 and the corresponding `if (STATUSES_REQUIRING_PLAN.has(parsed.status)) { ... }` block at lines 208–211 inside `requiredFilesByStatus.run`. Plans are optional — no longer flagged as missing. Keep `STATUSES_REQUIRING_HANDOFF`, the surrounding `const missing: string[] = []`, and the handoff check (lines 212–215) unchanged. Also update the check `title` on line 187 from "Plan and handoff files match assignment status" to "Handoff file matches assignment status".
- **Verify:** `npm run typecheck` and run any doctor tests: `npx vitest run src/__tests__/doctor.test.ts`

### 5. Rewrite `/plan-assignment` skill — versioned plan + Todos linkage

- **File:** `platforms/claude-code/skills/plan-assignment/SKILL.md` (MODIFY)
- **What:** Replace Step 4 ("Write the Plan") with three substeps:
  1. **Determine plan filename.** Use Glob `<assignmentDir>/plan*.md`. If none exists, target is `plan.md`. Otherwise pick the smallest `N >= 2` such that `plan-v<N>.md` does not exist.
  2. **Write the plan file.** If it's `plan.md` and doesn't exist yet, create it with the standard plan frontmatter (`assignment`, `status: draft`, `created`, `updated`) and body. For `plan-v<N>.md`, create with the same frontmatter but `status: draft` and a fresh `created` timestamp. If the target file exists (only `plan.md` can exist on first re-run), preserve frontmatter and replace body, flipping `status` from `draft` to `in_progress`.
  3. **Update `assignment.md` Todos.** Read the `## Todos` section. If any unchecked todo's line matches the regex `^- \[ \] Execute \[[^\]]*\]\(\.\/plan(?:-v\d+)?\.md\)\s*$`, convert that line to the supersede form: `- [x] ~~<original body after "- [ ] ">~~ (superseded by plan-v<N>)` where `<N>` is the version just written. Then append a new line at the end of the `## Todos` section: `- [ ] Execute [plan](./plan.md)` for v1, or `- [ ] Execute [plan v<N>](./plan-v<N>.md)` for v2+. If the `## Todos` section does not exist yet (pre-migration assignment), create it immediately after `## Acceptance Criteria` with a single guidance HTML comment (matching the template added in task 1) and then append the new line.
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
- **What:** Extract the `## Todos` section from `assignment.body` (the prop name is `body`, not `summary` — see AssignmentDetail.tsx:142 where `splitAssignmentSummary(assignment.body)` is called) and render it with `MarkdownRenderer` as a new `SectionCard` titled "Todos" in the summary tab, below the Acceptance Criteria card. Keep the Plan tab as-is (it already tolerates `plan: null` per api.ts:529 and the type declaration at `dashboard/src/hooks/useMissions.ts:142`).
- **Pattern:** Extend `dashboard/src/lib/acceptanceCriteria.ts` to export a second helper, e.g. `splitTodosSection(body: string): { todosMarkdown: string; remaining: string }`, that mirrors the existing `splitAssignmentSummary` structure (find `## Todos` heading, collect until next `##`). In `AssignmentDetail.tsx`, call it inside the existing `useMemo` at line 141-144 (either as a second helper on `body`, or chain from `summaryBody`) and render the `todosMarkdown` inside a new `<SectionCard title="Todos">` + `<MarkdownRenderer content={todosMarkdown} emptyState="No todos yet." />` block. Place it between the Acceptance Criteria card (lines 426-460) and the Assignment Summary card (lines 463-472).
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

### 18. Update Claude Code syntaur-expert agent

- **File:** `platforms/claude-code/agents/syntaur-expert.md` (MODIFY)
- **What:** Line 58 (directory tree): `plan.md` → `plan*.md           # Agent-writable: versioned implementation plans (0+)`. Line 81 (writable list): `plan.md` → `plan*.md` with "(optional, one per `## Todos` entry)". Line 218 (`/plan-assignment` workflow): change "Explore workspace, write detailed plan.md" to "Explore workspace, write next `plan-v<N>.md`, append a todo to `## Todos` (supersede any prior plan todo)". Line 225 (ExitPlanMode): update to reference plan files and Todos section. Line 250 (markdown editing): `plan.md` → `plan*.md`. Line 300 (plan.md frontmatter description): keep as-is but clarify "plan files (plan.md, plan-v2.md, ...)".
- **Verify:** Visual diff.

### 19. Update Codex syntaur-operator agent

- **File:** `platforms/codex/agents/syntaur-operator.md` (MODIFY)
- **What:** Mirror the semantic edits from task 18 at lines 3 (description), 14 (keep plan files accurate), 31 (read `<assignmentDir>/plan*.md`), 50 (writable list), 102 (plan-assignment step: pick next plan-v<N>.md, update Todos).
- **Verify:** Visual diff.

### 20. Update ExitPlanMode hook prompt

- **File:** `platforms/claude-code/hooks/hooks.json` (MODIFY)
- **What:** Line 10 currently reads "... update the assignment's plan.md with the plan you just created and update assignment.md to reflect that planning is complete." Change to: "... pick the next unused `plan-v<N>.md` filename (or `plan.md` if none exists) under the assignment dir, write the plan you just created there, and append a `- [ ] Execute [plan](./plan.md)` (or versioned equivalent) entry to the `## Todos` section of assignment.md — marking any prior plan todo as superseded per convention."
- **Verify:** `jq . platforms/claude-code/hooks/hooks.json` (must still parse); run the plugin install smoke test if available.

### 21. Update EditAssignmentScratchpad help text

- **File:** `dashboard/src/pages/EditAssignmentScratchpad.tsx` (MODIFY)
- **What:** Line 20 `helpBody` currently reads "Scratchpad is for transient notes. Keep canonical objective and lifecycle data in assignment.md and plan.md." Change the tail to "...in assignment.md and any active plan files (plan.md, plan-v<N>.md)."
- **Verify:** `npm run typecheck`.

### 22. Update example playbooks and sample mission

- **Files:**
  - `examples/playbooks/read-before-plan.md` — frontmatter `when_to_use` (line 5) and body line 15: "plan.md" → "any plan file (plan.md, plan-v<N>.md)". Skill-level narrative remains the same.
  - `examples/playbooks/keep-records-updated.md` — line 26: "If a plan.md exists" → "If any plan files exist".
  - `examples/sample-mission/assignments/{design-auth-schema,implement-jwt-middleware,write-auth-tests}/assignment.md` — the `## Links` section still contains `- [Plan](./plan.md)`. Leave these (these are historical example assignments with concrete plans), OR replace with a `## Todos` section and demote the Link. Pick ONE: convert all three examples to the new convention by adding a `## Todos` section above `## Context` with `- [x] Execute [plan](./plan.md)` (since these examples show completed/in-progress states with plan files already written) and removing the `[Plan](./plan.md)` line from `## Links`. This keeps examples consistent with the new protocol.
  - `examples/sample-mission/_index-plans.md` — no change (this is a derived index that correctly links to existing plan.md files, which the new convention still supports as v1).
- **Verify:** Visual diff; optionally `syntaur doctor --root examples/sample-mission` if that's a supported path.

### 23. Smoke-test doctor + existing assignments

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

## Review Summary

**Verdict:** READY FOR IMPLEMENTATION

**Pre-review snapshot:** `claude-info/plans/2026-04-19-assignment-todos-checklist-lite.pre-review.md`

### Internal passes

- **Pass 1 — Completeness:** Original plan missed several files that reference `plan.md`. Added tasks 18–22 covering `syntaur-expert.md`, `syntaur-operator.md`, `hooks.json` (ExitPlanMode prompt), `EditAssignmentScratchpad.tsx`, and example playbooks/sample-mission assignments.
- **Pass 2 — Detail:** Tightened task 4 (explicit constants to keep, doctor check title update on line 187), task 5.3 (concrete regex + missing-section fallback), and task 15 (correct prop name `body`, specific render location between lines 426–472).
- **Pass 3 — Accuracy:** Explorers verified every cited line number (create-assignment.ts 158–165, api-write.ts 417, doctor/checks/assignment.ts 10/208–211, help.ts 288/424, codex-agents.ts, cursor-rules.ts, test files, api.ts:529, splitAssignmentSummary helper). All confirmed. Also confirmed `plan: null` tolerance via `useMissions.ts:142` type.
- **Pass 4 — Standards:** Plan lives under `claude-info/plans/` per CLAUDE.md. Platform-mirror convention honored (claude-code + codex edits paired).
- **Pass 5 — Simplicity:** Added a naming caveat clarifying that the existing workspace-scoped "Quick Todos" system (`src/todos/`) is unrelated — this plan's `## Todos` is informal markdown, NOT parsed by `src/todos/parser.ts`. Prevents accidental wiring.

### External reviews

- `feature-dev:code-reviewer`: completed — no blocking issues.
- `sun-tzu:review-agent` (plan-focused pass): completed — surfaced the `syntaur-expert.md` and `hooks.json` gaps now captured as tasks 18/20.
- Codex CLI (gpt-5.4, xhigh): **SKIPPED** — output stream hung past the 5-minute timeout. Two of three completed, which meets the acceptance threshold.

### Remaining concerns

- Task 22 instructs converting example sample-mission assignments to the new `## Todos` convention. If you'd rather preserve those examples as historical snapshots, downgrade that task to a no-op and add a one-line note in `examples/README` instead.
- No migration script for existing user assignments under `~/.syntaur/` — they simply stop being flagged by doctor. Acceptable given lite scope, but worth calling out at release time.

## Next Steps

1. Run `/sun-tzu-lite-implement claude-info/plans/2026-04-19-assignment-todos-checklist-lite.md` to begin implementation, OR execute tasks 1–23 manually in order.
2. After implementation, run the full verification block (`npm run typecheck`, `npx vitest run`, `syntaur doctor`) and the dashboard smoke test.
3. Commit in logical groups: template/scaffold (tasks 1–4), skills + mirrors (5–10, 18–19), adapter templates (11–14), dashboard (15–16, 21), tests (17), playbooks (22), hook (20), smoke test (23).
