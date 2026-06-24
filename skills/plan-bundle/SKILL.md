---
name: plan-bundle
description: >-
  Draft a shared implementation plan for the active Syntaur todo bundle.
  Use when the user wants to plan a bundle, write or extend its plan.md,
  or design an approach that covers every member todo together.
license: MIT
metadata:
  author: prong-horn
  version: "1.0.0"
---

# Plan Bundle

Create or extend the bundle's shared plan file. Bundles are non-lifecycle-
bearing containers — their "acceptance" is "every member todo is completed."
The plan must surface this explicitly: there are no acceptance criteria of
the bundle's own to track, only the member todos.

## Step 1: Load context

Read `.syntaur/context.json` (a workspace marker) from the current working
directory. It must contain `bundleId` (a bundle context). If there is no
`bundleId` but the session has an open engagement (an active assignment), stop
and tell the user: "This session is bound to an assignment, not a bundle.
Use `/plan-assignment` instead, or `/grab-bundle <id>` to switch."

Extract `bundleId`, `bundleScope`, `bundleScopeId`, `todoIds`, `planDir`.

## Step 2: Read each member todo

For each `t:<id>` in `todoIds`, read the description from the bundle's
scope checklist:

- workspace scope → `~/.syntaur/todos/<scopeId>.md`
- global scope → `~/.syntaur/todos/_global.md`
- project scope → `~/.syntaur/projects/<scopeId>/todos/<scopeId>.md`

Note each member's current status. Bundled members can be `open`,
`in_progress`, or `blocked` — a `completed` member should not be in a
live bundle (run `syntaur doctor` if you see one).

## Step 3: Create or open the plan file

```bash
syntaur todo bundle plan <bundle-id> <scope flags>
```

This prints the path to the new (or next-version) plan file. First call
creates `plan.md`; subsequent calls create `plan-v2.md`, `plan-v3.md`, etc.
The stub frontmatter includes `bundle:`, `todos:`, `scope:`, `status: draft`.
A `## Members` section listing each member is pre-populated.

## Step 4: Write the plan body

Replace the body of the new plan file with:

1. **Overview** — one paragraph: why these todos are bundled together (a
   shared schema migration, a feature with split FE/BE work, a coordinated
   refactor, etc.).
2. **Tasks** — numbered list. For each task: description, files to
   create/modify, dependencies on other tasks, complexity estimate.
3. **Member Mapping** — for each `t:<id>` member, which numbered task(s)
   complete it. This is the bundle equivalent of an assignment's "Acceptance
   Criteria Mapping" — it tells the implementer "after task N is done,
   member t:<id> can be marked completed."
4. **Risks and Open Questions**.
5. **Testing Strategy**.

Bump `updated:` in the plan frontmatter and flip `status: draft` → `status: in_progress`.

## Step 5: Mirror skills (if you also edited the skill file)

If this session also added or edited any `skills/<name>/SKILL.md`, run:

```bash
npm run mirror-skills
```

This is per `AGENTS.md` — propagates to `platforms/<kind>/skills/`.

## Step 6: Report to user

- Plan file path (absolute).
- Task count.
- Open questions / risks worth flagging up front.
- Suggested next step:
  - `/bundle-worktree --branch <name>` to spin up the shared worktree
  - Otherwise start implementing the first task in-place
