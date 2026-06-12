---
name: manage-statuses
description: >-
  Manage custom assignment statuses and transitions in Syntaur. Use when the
  user wants to add a status, customize a workflow stage, rename a status,
  remove or reorder statuses, define a custom transition, change which states
  are terminal (the "done state"), or otherwise edit the `statuses:` block in
  `~/.syntaur/config.md`. Triggers on phrases like "add a status", "custom
  status", "rename a status", "workflow stage", "change my workflow",
  "terminal status", "done state".
license: MIT
metadata:
  author: prong-horn
  version: "1.0.0"
---

# Manage Statuses

Customize Syntaur's assignment-status workflow via the `syntaur status` CLI. The CLI writes to the same `statuses:` block in `~/.syntaur/config.md` that the dashboard Settings page edits — so CLI and dashboard edits stay in sync.

The runtime is **all-or-nothing**: once `~/.syntaur/config.md` has a `statuses:` block, the built-in defaults (`pending`, `in_progress`, `blocked`, `review`, `completed`, `failed`) are NOT merged. `syntaur status init` materializes those defaults explicitly so the user has a starting point to customize. `syntaur status reset` removes the block to revert.

## Input

The user usually describes the change in free-form prose ("add a needs-design status after pending", "rename in_progress to working", "remove blocked", "make completed not terminal"). Map their intent to a subcommand:

| Subcommand | When to use |
|-----------|-------------|
| `syntaur status list [--json]` | Show the current set, with `source: config | default` markers. Always run this first when the user asks "what statuses do I have?" |
| `syntaur status init [--force]` | Materialize the built-in defaults explicitly. Run before any custom edit if `list` shows `source: default` for everything. |
| `syntaur status reset [--force]` | Remove the `statuses:` block and revert to implicit defaults. |
| `syntaur status add <id> --label <label> [--color <hex>] [--icon <name>] [--description <text>] [--terminal] [--after <id> | --before <id> | --at-end]` | Append a new status. Position flags are mutually exclusive. |
| `syntaur status set --id <id> [...]` | Mutate metadata on an existing status without renaming. `--terminal true|false` (literal strings). |
| `syntaur status reorder <id,id,...>` | Replace the order array. CSV must be a permutation of current ids — no drops, no extras. |
| `syntaur status remove <id> [--force]` | Remove a status. Without `--force`, errors if any assignment references it; lists offenders. With `--force`, also prunes `order` and `transitions[i]` whose `from === <id>` or `to === <id>`. |
| `syntaur status rename <id> --to <new-id> [--label <label>]` | Rename a status id. **Atomic** rewrite across `config.md` + every affected `assignment.md`. Without `--label`, keeps the original label. |
| `syntaur status transition add --from <id> --command <cmd> --to <id> [--label <label>] [--requires-reason]` | Define a custom transition. |
| `syntaur status transition remove --from <id> --command <cmd>` | Drop a custom transition. |

Every mutating subcommand supports `--dry-run`, which prints a unified diff of the would-be `statuses:` block change (and, for `rename`, a per-file frontmatter diff for each affected `assignment.md`) and exits without writing.

## Step 1: Determine intent → pick subcommand

Read the user's request and choose the subcommand. If ambiguous, ask. If the user says "make my workflow look like X", run `syntaur status list` first, present what's there, and confirm what they actually want changed.

If the user is making a destructive change (`remove`, `rename`, `reset`), default to running with `--dry-run` first and showing the diff, then asking the user to confirm before re-running without `--dry-run`.

## Step 2: Run the CLI

Build and run the chosen `syntaur status ...` invocation. Quote labels and descriptions that contain spaces. Use the literal strings `true`/`false` for `--terminal` on the `set` subcommand.

If the user is on a fresh `~/.syntaur/config.md` (no `statuses:` block) and wants to make any change other than `init`/`reset`, run `syntaur status init` first so subsequent `add` / `set` / `reorder` / `rename` / `remove` operate on an explicit set.

## Step 3: Verify with `syntaur status list`

After every mutating subcommand, run `syntaur status list` (or `--json` for machine consumption) and confirm the change took effect. Report back to the user with the new state.

## Step 4: Guide next steps

- **If the dashboard is running** (`syntaur dashboard`), tell the user to restart it. The dashboard caches `StatusConfig` per-process and CLI mutations cannot reach a separate Node process. The dashboard's own writes invalidate its cache automatically; CLI writes don't.
- **After a `rename`,** every assignment that referenced the old id has been rewritten in-place. Mention this to the user — git will show diffs in many `assignment.md` files. They are intentional.
- **After a `remove --force`,** the affected assignments now reference an undefined status. `syntaur doctor` will flag them as invalid. Suggest the user run `syntaur doctor` and either re-add the status (`syntaur status add ...`) or edit each frontmatter to a valid id.
- **After `transition add`,** the dashboard's transition buttons reflect the new transition only after the cache invalidation above.

## Custom facts and attestations

Beyond the 14 built-in derived-status facts, users can declare their **own** facts under `statuses.facts` and reference them in `phaseLadder` / `disposition` conditions. There are two kinds.

**Two ways to declare them**, kept in sync because both write the same `statuses.facts` block:

- **Dashboard** — the Settings page has a **Facts** section that lists every declared fact and lets the user add/edit/delete declarations (name + kind, plus `binds` for attestations) with the same validation the CLI/doctor enforce. Deleting a fact that a derive rule still references prompts for confirmation before saving, and a Facts save preserves the existing statuses, ordering, and derive rules.
- **Config / CLI** — hand-edit the `statuses.facts` block in `~/.syntaur/config.md` directly (the shapes below).

Declaring a fact (either way) only defines the vocabulary; asserting per-assignment values is always `syntaur fact set` / `syntaur attest`.

**1. Custom asserted facts** — config-declared `bool` / `number` values, asserted via `syntaur fact set` and stored in a `facts:` frontmatter map:

```yaml
statuses:
  facts:
    - name: qaPassed
      type: bool
    - name: storyPoints
      type: number
```

```bash
syntaur fact set <assignment> qaPassed true --project <p>
syntaur fact set <assignment> storyPoints 5 --project <p>
```

`bool` accepts case-insensitive `true`/`false`; `number` accepts any finite number. The declared `name` exports a single derive field of the same name (`qaPassed:true`, `storyPoints > 3`). Stored in frontmatter as `facts:\n  qaPassed: "true"`.

**2. Attestation facts** — model "agent X reviewed revision Y with verdict Z". Declared with `type: attestation` and a `binds:` mode:

```yaml
statuses:
  facts:
    - name: codeReview
      type: attestation
      binds: plan      # plan | commit | none
```

```bash
syntaur attest <assignment> codeReview --agent codex --verdict approved --project <p>
syntaur attest <assignment> codeReview --agent pi --verdict changes-requested --note "fix the lock" --project <p>
```

`--verdict` defaults to `approved` (the other value is `changes-requested`). One record per actor — re-attesting **replaces** that actor's record. Stored in an `attestations:` frontmatter list (`{fact, actor, verdict, at, note?}` + binding snapshot).

Each attestation fact exports **five** derive fields (for `codeReview`): `codeReview` (any valid record), `codeReviewApproved`, `codeReviewChangesRequested` (bools), and `codeReviewBy`, `codeReviewApprovedBy` (actor **sets** — use `:` for contains / `IN`-lists, e.g. `codeReviewApprovedBy:"agent:codex"`; quote actor values that contain a `:`). This makes review loops self-modeling — a rung `when: "codeReviewApproved:true"` fires on approval, and `when: "codeReviewChangesRequested:true"` expresses "reviewed but not signed off".

**Revision binding** is what makes attestations self-invalidate:
- `binds: plan` — bound to the latest plan file + its digest (same semantics as plan approval). A replan or a post-attest plan edit makes the record **stale**; stale records contribute nothing (the fact flips false, the actor drops out of the `*By` sets).
- `binds: commit` — bound to the workspace branch HEAD sha at attest time. A new commit makes it stale. **Lazy convergence:** dashboard payloads and `ls --query` compute facts fresh per request (always honest), but the *persisted* phase regression lands on the next recompute trigger (any CLI verb, watcher event, config change, or boot sweep) — there is no git watcher.
- `binds: none` — never stale (a standing sign-off).

**Validation & teeth.** Declared names are validated by `syntaur doctor` (the `derive-config.valid` check): bad name/type/binds and any collision of an exported field with a built-in or another declaration is reported as an error and the offending declaration is dropped (built-ins always win). A derive condition that references an **undeclared** fact still fails at recompute time (`CompileError`), exactly as before. `syntaur fact set` / `syntaur attest` reject undeclared names, wrong types, and invalid verdicts. Every `fact set` / `attest` is recorded in `statusHistory` with its actor and cause, even when no dimension moves.

## Derive rules and transitions

The dashboard Settings page edits the **entire** `statuses:` workflow config, not just the status list and facts. A single **Save Configuration** button writes statuses, descriptions, facts, derive rules, and transitions together as one coherent config; CLI/config-file edits and dashboard edits stay in sync because both write the same `~/.syntaur/config.md` block.

- **Status descriptions** are editable inline alongside id/label/color/Done(terminal).
- **Derive Rules** section edits the three pieces that map facts → status:
  - **Phase ladder** — drag-reorderable rung cards (highest matching rung wins; the `*` catch-all is pinned at the lowest-priority slot and matches everything). Each rung is a status + a condition + an optional `next:` action label.
  - **Disposition** — first-match-wins `active|blocked|parked` rules with a mandatory pinned `else:` arm.
  - **Headline projection** — which status id the single-column board shows when parked/blocked (terminal is always `passthrough`, active always shows the `phase`).
  - Each condition has a **dual-mode editor**: a structured builder (fact → operator → value, AND/OR groups) and a raw AQL text mode backed by the same string. Conditions too complex for the builder open in raw mode (never lossily flattened). Both modes validate live against the 14 built-in derive fields plus your declared custom facts — the exact `parseQuery`/`compileNode` checks the CLI and `syntaur doctor` run.
  - When the config declares no custom derive rules, the section shows the built-ins read-only with a banner; editing switches to a custom config, and **Reset to default rules** restores the built-ins.
- **Transitions** section edits which commands move an assignment between statuses, grouped into one card per from-status (command → target, optional label/description, and a `requiresReason` toggle). An empty config shows the built-in `DEFAULT_TRANSITION_TABLE` read-only (filtered to your defined statuses) with a **Customize defaults** affordance that seeds editing.

**Hand-written rules survive a Settings save.** Transitions and derive rules you author directly in `config.md` are preserved across a dashboard save even if you only touched, say, the status list — the dashboard sends each section only when you change it, and the server preserves untouched sections (the old "transitions get wiped on save" bug is gone).

**Cross-section integrity.** Deleting a status that ladder rungs, the headline projection, or transitions reference surfaces those exact rules in the delete dialog (even when no assignments use the status). Remap rewrites every reference to the chosen target; delete drops the referencing ladder rungs and transitions, and — because the headline projection cannot point at nothing — requires a remap target for any headline reference. Removing a fact that a remaining derive rule still references is blocked with an acknowledgement prompt, the same guard `syntaur doctor` enforces. The server re-validates everything with `validateDeriveConfig` before writing, so the dashboard can never persist a config the CLI/doctor would reject.

## Safety notes

- **`remove` is destructive.** Without `--force` it refuses if any assignment references the id. Don't suggest `--force` without first running `syntaur status remove <id>` (no force) so the user sees the affected list.
- **`rename` rewrites many files.** It edits `config.md` AND every affected `assignment.md` in a single atomic transaction (with rollback if any write fails partway). Always run `--dry-run` first on a non-trivial codebase so the user sees the per-file diff.
- **`terminal: true` is load-bearing.** Terminal statuses affect dashboard progress bars and dependency-satisfaction logic — an assignment with a terminal status counts as "done" for downstream `dependsOn` checks and project-rollup status. Don't toggle this on `pending`-style states without thinking.
- **`init --force` overwrites a custom block.** Use `reset` first if the user wants a clean slate, OR confirm before passing `--force` if they have unsaved customizations. It resets to the built-in defaults and therefore **drops any `statuses.facts` declarations and `derive` rules** along with the custom statuses — every other `status` subcommand (`set`/`add`/`remove`/`rename`/`reorder`/`transition`) preserves them.
- **Concurrency.** `rename`'s buffer-write-rollback strategy assumes no concurrent writers. Tell the user to close the dashboard / pause other agents during a rename.
- **`SYNTAUR_HOME` precedence.** If the user has `SYNTAUR_HOME` set, the CLI writes there instead of `~/.syntaur`. Mirror their environment.
