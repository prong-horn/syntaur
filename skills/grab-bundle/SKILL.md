---
name: grab-bundle
description: >-
  Claim a Syntaur todo bundle (a lightweight container grouping 2+
  scope-mate todos under a shared plan and worktree, with no full
  assignment overhead). Use when the user wants to start working on a
  todo bundle: "claim bundle b:xxxx", "work on the auth-cleanup bundle",
  or after creating one via `syntaur todo bundle new`.
license: MIT
metadata:
  author: prong-horn
  version: "1.0.0"
---

# Grab Bundle

Claim a Syntaur todo bundle and set up the current workspace. The bundle
contract is lighter than an assignment — no lifecycle transitions, no
progress.md, no handoff/decision-record/acceptance criteria. Member todos
keep their own `start` / `complete` lifecycle; the bundle just owns the
shared `planDir`, `branch`, `worktreePath`, and `repository`.

## Input

One or two positional arguments:

- A bundle id (with or without `b:` prefix) — required if multiple bundles
  exist in the current scope.
- Scope flags: `--workspace <slug>`, `--project <slug>`, or `--global`
  (default).

If no id is given, run `syntaur todo bundle list <scope flags>` and ask
the user to pick.

## Pre-flight check

First check whether this session already has an active assignment via its open
engagement (`syntaur session resume --json`):

- If it reports an active assignment, warn the user: "You already have an active
  assignment. Grabbing a bundle will rebind this session. Proceed?" — stop if no.

Then read `.syntaur/context.json` (a workspace marker) in the current working
directory for bundle bookkeeping:

- If it already contains different bundle fields (`bundleId` set to a
  different id), warn: "Context is bound to bundle b:<old>. Switch to b:<new>?"
  — stop if no.
- A context.json holding only workspace-marker / `sessionId` fields is expected;
  proceed and merge bundle fields on top.

## Step 1: Load the bundle

```bash
syntaur todo bundle show <bundle-id> <scope flags>
```

Note its scope, member todos, slug, planDir (if any), branch (if any),
worktreePath (if any), and repository.

## Step 2: Read the bundle's plan (if present)

If `planDir` is set, read `<planDir>/plan.md` (and any `plan-v<N>.md` —
prefer the highest version). This is the shared implementation plan for
the whole bundle.

## Step 3: Read each member todo

For each `[t:<id>]` listed in the bundle, run
`syntaur todo list --status open` (and `--status in_progress` and
`--status blocked`) under the same scope, OR read the checklist markdown
directly. Note the description, current status, and any session
fingerprint on `in_progress` members.

## Step 4: Write bundle context.json

Merge bundle fields into `<workspaceRoot>/.syntaur/context.json` — never
overwrite. Required fields:

```json
{
  "bundleId": "<bundle.id>",
  "bundleSlug": "<bundle.slug or null>",
  "bundleScope": "<workspace|project|global>",
  "bundleScopeId": "<scopeId>",
  "todoIds": ["<id1>", "<id2>", "..."],
  "planDir": "<planDir or null>",
  "branch": "<branch or null>",
  "worktreePath": "<worktreePath or null>",
  "repository": "<repository or null>",
  "boundAt": "<ISO 8601>"
}
```

NO assignment fields. The `resolveAssignmentTarget` discriminator at
`src/utils/assignment-target.ts` will throw a clean error if any assignment
flow misfires inside a bundle worktree.

If the bundle already has a worktreePath set and the user is NOT inside it,
suggest `cd <worktreePath>` before continuing.

## Step 5: Report to user

Summarize:

- Bundle id (b:xxxx) + slug.
- Scope + scopeId.
- Number of members + their descriptions + statuses.
- Plan file path (if any).
- Branch + worktreePath (if any).
- Repository (if any).
- Suggested next step:
  - `/plan-bundle` if no plan exists yet
  - `/bundle-worktree --branch <name>` if no worktree exists yet
  - `/complete-bundle` if every member is done
