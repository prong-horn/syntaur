---
name: run-playbook
description: >-
  Load a Syntaur playbook's full content on demand and follow its directives for
  the rest of the relevant work. Use when the user wants to "run the X playbook",
  "apply the X playbook", "follow the X playbook", or "load the X playbook" — or
  asks which playbooks are available. Playbooks live at `~/.syntaur/playbooks/`
  and define behavioral rules for agents; this skill resolves one by name/slug
  against the manifest and applies it. Read-only — never writes playbook files.
license: MIT
metadata:
  author: prong-horn
  version: "1.0.0"
---

# Run Playbook

Resolve a Syntaur playbook by name or slug, load its full content, and follow
its directives. Playbooks are behavioral rules for AI agents stored at
`~/.syntaur/playbooks/<slug>.md` and indexed by the derived
`~/.syntaur/playbooks/manifest.md`. They are normally only auto-injected as a
one-line summary via the UserPromptSubmit hook; this skill loads the **full**
text of one playbook so you can deliberately apply it mid-session.

## When NOT to use this skill

- The user wants to **create, edit, enable, disable, or delete** a playbook —
  use the `syntaur create-playbook` / `enable-playbook` / `disable-playbook` /
  `delete-playbook` CLI commands instead. This skill is read-only and must
  **NEVER** write `manifest.md` or any playbook file.
- The user just wants the one-line summary of all playbooks — that is already
  auto-injected each turn; only run this skill when they want the full content
  applied.

## Step 1: Parse the argument

Take the playbook name or slug from the argument (e.g. `commit-discipline`,
`Commit Discipline`, `commit`).

If the argument is **empty or ambiguous** (could match more than one playbook),
do not guess. Read `~/.syntaur/playbooks/manifest.md` and present every
available playbook — Name, slug, the one-line description, and the
`_When to use_` line — then ask the user which one to run. Stop until they pick.

## Step 2: Resolve the playbook

Read `~/.syntaur/playbooks/manifest.md`. It is the **enabled-only** index
(disabled playbooks are excluded), so it is the correct list to resolve against.
Each entry looks like:

```markdown
- **[Commit Discipline](commit-discipline.md)** — Make small, logical commits …
  _When to use: When making git commits during assignment work_
```

The slug is the link target stem (`commit-discipline` from `commit-discipline.md`).
Match the user's argument **case-insensitively** against:

1. the slug (link target stem),
2. the display Name, or
3. the filename.

If nothing matches, suggest the closest manifest entries (by name/slug
similarity) and stop — **never invent a slug** or read a file that is not in
the manifest.

## Step 3: Load the playbook

Read the full `~/.syntaur/playbooks/<slug>.md` file. Note its frontmatter
(`name`, `slug`, `description`, `when_to_use`, `tags`) and read the **entire**
markdown body — that body is the set of directives.

## Step 4: Apply the playbook

Treat the playbook body as behavioral directives that **take precedence over
default conventions** for the remainder of the relevant work (consistent with
how playbooks are described in the `syntaur-protocol` skill). Keep following
them for the rest of the session's work on this topic, not just the next action.

## Step 5: Report to User

Confirm:

- Which playbook was loaded — display name, slug, and absolute path.
- A one-line summary of what it now governs (from its `when_to_use` / first
  directives), e.g. "Now applying **Commit Discipline**: small, logical commits
  tied to plan tasks."
