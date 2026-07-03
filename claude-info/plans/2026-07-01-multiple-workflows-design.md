# Multiple Workflows — Design Spec

**Status:** Approved design (brainstorming complete) · **Date:** 2026-07-01
**Assignment:** `syntaur-meta/support-multiple-workflows-multi-workflow-lifecycle-library`
**Origin:** brainstorming session `8151bea9` (2026-07-01), continued and finished in a follow-up session.

## Problem

Syntaur supports exactly **one** lifecycle. It lives in the global `statuses:`/`derive:` block of
`~/.syntaur/config.md`, backed by four things:

1. `statuses.definitions` — the status set (draft, ready_for_planning, in_progress, review, completed…) with labels/colors/terminal flags.
2. `statuses.order` — display/board ordering.
3. **transitions** — the `from:command → to` table (`src/lifecycle/state-machine.ts`). The CLI is deliberately guard-free (flow enforced by agent prompting); only the dashboard uses the table to gate the kanban picker.
4. **derived-status v3** — the `src/utils/derive-config.ts` phase ladder (AQL `when` rungs), disposition rules, and headline projection that compute an assignment's *shown* phase from its real state.

That whole bundle is global and singular. Assignments already carry a `type:` field (default `feature`) that is currently unused for behavior — the natural hook for "different flows for different task types."

**Goal:** users define **multiple named workflows** (each a full bundle of the four things above) and
bind each ticket to one, so a bugfix flow can legitimately differ from a feature flow — not just
recolored columns.

## Decisions locked

- **Full** workflows — each workflow owns `definitions / order / transitions / derive` (not just columns).
- **Global library** — workflows defined once, referenced by id everywhere.
- **Binding** — per-project default **plus** `type → workflow` mapping, with an explicit per-ticket override.
- **Board** — support **all three** mixed-workflow render modes (A/B/C below).
- **v1 scope** — everything: dashboard switcher + binding UI + config model + board modes + CLI verbs.

---

## §1 — Data model

Workflows become a **global library**, defined once and referenced by id everywhere (keeps the
single-source derive-config validator intact; projects/tickets never redefine, only point):

```yaml
# ~/.syntaur/config.md
workflows:
  default:                    # current config, migrated verbatim
    label: Default
    definitions: [ {id, label, description, color, terminal}, … ]
    order:       [ draft, ready_for_planning, … ]
    transitions: [ {from, command, to}, … ]
    derive:
      phaseLadder: [ {phase, when, next}, … ]
      disposition: [ {when, is}, … ]
      headline:    { terminal, parked, blocked, active }
  bugfix:
    label: Bug Fix
    definitions: [ triage, fixing, verifying, done, … ]
    …
defaultWorkflow: default      # global fallback
```

Each workflow owns all four pieces — that's "Full." The legacy top-level `statuses:`/`derive:` block
is read as `workflows.default` when `workflows:` is absent, so **old configs keep loading with zero
changes**; a migration lifts it into place on first write (see §6).

**Binding, resolved first-hit-wins:**

1. `workflow:` on the ticket (`assignment.md` frontmatter) — explicit, always wins.
2. project's `workflowByType[ticket.type]` — the type map.
3. project's `defaultWorkflow`.
4. global `defaultWorkflow` (→ `default`).

So a project says "bugs use `bugfix`, everything else uses `feature`," any single ticket can override,
and nothing set anywhere still resolves to `default`.

A single resolver (`resolveWorkflow(assignment, project, config) → WorkflowId`) is the one place this
priority is implemented; everything downstream (derive, board, doctor, UI) calls it.

## §2 — Derived status per workflow

`src/lifecycle/recompute.ts` / `src/lifecycle/derive.ts` currently load the *global* derive config.
The change is small and surgical: **resolve the ticket's workflow first, then run its `derive` block.**
The cached `phase` in frontmatter is always computed against that ticket's own workflow. The existing
browser-safe validator runs per-workflow, so client/server/doctor parity holds automatically.

## §3 — Doctor / validation

New checks (extend `src/utils/doctor/checks/derive-config.ts` and friends):

- workflow id exists;
- `assignment.status` ∈ that workflow's `definitions`;
- each workflow's `derive` references only its own status ids;
- `workflowByType` values resolve to real workflows.

Deleting a workflow or changing its status set reuses the **existing
`src/utils/status-config-resolution.ts` remap/delete machinery** (buffer → TOCTOU re-verify →
rollback) — no new safety code, just scoped per-workflow.

## §4 — Board rendering

Today every board builds one column set from the single global status order
(`dashboard/src/lib/kanban.ts` → `getAssignmentColumns`), and each card lands in the column matching
its `status`. Once a board contains more than one workflow (e.g. a project using `workflowByType`),
a card's status may not exist in the column set. Support **all three** modes as a per-board / per-view
setting:

- **(A) Filter-to-one-workflow** — a workflow picker; the board renders that workflow's *real* status
  columns via `getAssignmentColumns(workflow.order)`. Cards of other workflows are filtered out.
- **(B) Per-workflow swimlanes** — one horizontal band per workflow, each with its own real columns.
  The richest view; renders every workflow's true lifecycle at once.
- **(C) Normalized disposition columns** — project every workflow's statuses onto the shared
  **disposition axis that already exists** (`DEFAULT_PROJECT_BOARD_COLUMNS`:
  `pending/active/blocked/failed/completed`). Cards show a workflow badge + their real status label.
  Always renders regardless of how many workflows are present; the safe default for mixed boards.

Saved views can filter by `workflow`. `KanbanBoard` is already generic (`columns: KanbanColumn[]` +
`getColumnId(item)`), so A and C reuse existing primitives; B adds a swimlane layout wrapper.

## §5 — Authoring & management surface

**Config (three files gain fields):**

- Global `config.md` → `workflows:` map + `defaultWorkflow` (§1).
- Project `project.md` frontmatter → `defaultWorkflow: <id>` + `workflowByType: { bug: bugfix, spike: research }`.
- Assignment `assignment.md` frontmatter → optional `workflow: <id>` (explicit override).

**Dashboard `/workflow` page** — today the four-tab editor (`dashboard/src/pages/WorkflowPage.tsx`:
Statuses · Transitions · Derive Rules · Facts) mutates the one global config. Add a **workflow
switcher** across the top: a list/dropdown of workflows plus *New*, *Duplicate*, *Delete*, *Set as
default*. The four tabs stay as-is but operate on the *selected* workflow's bundle. Because each tab
already edits a self-contained status-config bundle, this is close to a wrapper change, not a rewrite —
the per-workflow validator and remap/delete machinery from §3 come along for free.

**Binding UI** — a "Workflows" section on project settings (default-workflow dropdown + a
`type → workflow` table), and a workflow dropdown on Create/Edit Assignment that pre-fills the
*resolved* binding but is overridable.

**CLI** — `syntaur workflow list|new|edit|delete|set-default`, `syntaur workflow bind-type <project>
<type> <workflow>`, and `--workflow` on `create-assignment`. Mirrors the existing `manage-statuses`
surface so the skill/agent path stays consistent.

## §6 — Migration, edge cases, rollout

- **Migration (automatic, zero-touch):** reads already treat an absent `workflows:` as
  `{ default: <legacy statuses/derive> }`, so nothing breaks on read. On the first *write* under the
  new code, lift the top-level `statuses:`/`derive:` into `workflows.default` — same pattern the
  codebase already uses for config migrations. No flag, no manual step.
- **Re-binding a ticket (X → Y):** the ticket's current `status` may not exist in Y. Reuse the status
  remap machinery (`status-config-resolution.ts`): require a status remap into Y's set, then recompute
  the derived phase against Y. Doctor flags any ticket whose `status ∉ its workflow`.
- **Deleting a workflow in use:** same buffer → TOCTOU re-verify → rollback flow as status deletion —
  resolve the N affected tickets and force "reassign to `<workflow>`" before removal. `default` can't
  be deleted while anything resolves to it.
- **Views/board:** saved views can filter by `workflow`; the A/B/C board mode is a per-board/per-view
  setting.

**Build order** (each stage independently shippable/testable):

1. Config model (`workflows:` + `defaultWorkflow`) + `resolveWorkflow` resolver + automatic migration.
2. Per-workflow derive (§2) + doctor checks (§3).
3. Dashboard `/workflow` switcher wrapping the existing four-tab editor (§5).
4. Binding: project `defaultWorkflow`/`workflowByType` + assignment `workflow:` frontmatter + Create/Edit UI.
5. Board modes A/B/C (§4).
6. `syntaur workflow` CLI verbs.

## Key files

| Concern | File |
|---|---|
| Derive config / validator | `src/utils/derive-config.ts` |
| Derive + recompute | `src/lifecycle/derive.ts`, `src/lifecycle/recompute.ts` |
| Transitions | `src/lifecycle/state-machine.ts` |
| Status remap/delete safety | `src/utils/status-config-resolution.ts` |
| Doctor checks | `src/utils/doctor/checks/derive-config.ts` |
| Workflow editor page | `dashboard/src/pages/WorkflowPage.tsx` (+ `settings-page-helpers.ts`, section components) |
| Board columns | `dashboard/src/lib/kanban.ts`, `dashboard/src/components/KanbanBoard.tsx` |

## Out of scope (YAGNI for v1)

- Workflow-bound **methodology** (which playbooks/planning style/review gates apply per type) — the
  broad "workflows as primary organizing concept" version. Explicitly deferred; this feature is
  lifecycle-only.
