---
name: complete-bundle
description: >-
  Bulk-complete every member todo of a Syntaur todo bundle. Use when the
  user wants to "finish this bundle", "close out bundle b:xxxx", or mark
  the whole bundle done after every implementation task is verified.
license: MIT
metadata:
  author: prong-horn
  version: "1.0.0"
---

# Complete Bundle

Bulk-complete every open / in-progress / blocked member todo of the
current Syntaur bundle. Bundles have no lifecycle to transition — this
skill simply flips each member todo to `completed`, writes a log entry
per newly-completed member, and (optionally) appends a shared summary
to the bundle's plan.

## When NOT to use this skill

- The bundle has unverified work. Read each member's description and
  confirm it is actually done in the codebase BEFORE running this skill.
  Once a todo is `completed`, the log entry is permanent.
- A member belongs to an assignment via `linkedAssignmentId`. The
  assignment's own lifecycle (`/complete-assignment`) is the authoritative
  closer; let it auto-complete the todo via the existing linked-todos
  hook (`src/lifecycle/linked-todos.ts`).

## Step 1: Load context

Read `.syntaur/context.json`. It must contain `bundleId`. Extract that and
the scope (`bundleScope` + `bundleScopeId`).

## Step 2: Verify every member is done

For each `t:<id>` in `todoIds`, read the description and confirm in the
codebase that the work is complete:

- Files exist / were modified as the plan described.
- Tests pass.
- No `// TODO(bundle):` markers remain in the modified files for that
  member.

If any member is not done, list it for the user and ask whether to
proceed anyway (default: don't). If the user says yes, note in the shared
summary that member `t:<id>` was bulk-completed despite incomplete
verification.

## Step 3: Append a completion summary to the plan (optional but recommended)

If the bundle has a `planDir`, open the latest `plan*.md` and append at
the bottom:

```markdown
## <ISO 8601 timestamp> — Completion

<One paragraph summarizing what was implemented, which tests pass, and any
deferred scope. Reference each member by t:<id> if behavior differed.>
```

## Step 4: Run the CLI

```bash
syntaur todo bundle complete <bundle-id> \
  [--summary "<shared one-line summary>"] \
  <scope flags>
```

The CLI flips every non-completed member to `completed`, clears its
`session`, writes one log entry per newly-completed member, and bumps the
bundle's `updatedAt`. Already-completed members are skipped silently.

## Step 5: Confirm derived status

```bash
syntaur todo bundle show <bundle-id> <scope flags>
```

The `Status:` line should now read `completed (N/N done)`. If it reads
`mixed`, some members were not in the expected state — surface to the user.

## Step 6: Decide bundle disposition

The CLI leaves the bundle record intact after `complete` for historical
reference. The user has two options:

- Leave the bundle intact (default). `bundle list` will keep showing it
  with `completed` derived status. Plan + worktree remain on disk.
- Dissolve via `syntaur todo bundle dissolve <bundle-id>` — clears each
  member's `bundleId` back to `null` and removes the bundle from
  `bundles/index.md`. Member status / planDir / branch / worktreePath are
  preserved.

Recommend leaving it intact unless the user explicitly wants to recycle
the worktree / branch for unrelated work.

## Step 7: Report to user

- Bundle id.
- Number of newly-completed members vs already-done.
- Path to the shared summary appendix (if written).
- Derived status from `bundle show`.
- Suggested next: continue, dissolve, or grab a different bundle.

## Step 8: Mirror skills (if you also edited the skill file)

If this session also touched `skills/<name>/SKILL.md`, run:

```bash
npm run mirror-skills
```
