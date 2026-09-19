---
name: run-playbook
description: >-
  Load a Syntaur playbook's full content on demand and follow its directives for
  the rest of the relevant work. Use when the user wants to "run the X playbook",
  "apply the X playbook", "follow the X playbook", or "load the X playbook" — or
  asks which playbooks are available. Playbooks live at `~/.syntaur/playbooks/`
  and define behavioral rules for agents; this skill resolves one by name/slug
  against the derived manifest and applies it. Read-only — never writes playbook files.
license: MIT
metadata:
  author: prong-horn
  version: "1.0.0"
---

# Run Playbook

Resolve a Syntaur playbook by name or slug, load its full content, and follow
its directives. Playbooks are behavioral rules for AI agents stored at
`~/.syntaur/playbooks/<slug>.md`. Cross-template playbooks are normally injected
by the UserPromptSubmit prompt hook (`syntaur session context`); this skill loads
the **full** text of one playbook so you can deliberately apply it mid-session.

## When NOT to use this skill

- The user wants to **create, edit, enable, disable, or delete** a playbook —
  use the dashboard Library instead. This skill is read-only and must **NEVER**
  write the derived manifest or any playbook file.
- The user just wants the current ticket's stage guidance — run `syntaur show`
  and follow **Stage** and **Next**; cross-template playbooks are already in the
  prompt hook block when enabled.

## Step 1: Parse the argument

Take the playbook name or slug from the argument (e.g. `commit-discipline`,
`Commit Discipline`, `commit`).

If the argument is **empty or ambiguous** (could match more than one playbook),
do not guess. List every enabled playbook file under `~/.syntaur/playbooks/`
(excluding `manifest.md`) with name, slug, description, and `when_to_use`, then
ask the user which one to run. Stop until they pick.

## Step 2: Resolve the playbook

List enabled playbooks by reading `~/.syntaur/playbooks/*.md` (skip `manifest.md`
and any slug listed in `config.md` `playbooks.disabled`). Match the user's
argument **case-insensitively** against:

1. the frontmatter slug,
2. the display name, or
3. the filename stem.

If nothing matches, suggest the closest entries and stop — **never invent a slug**
or read a file that is not an installed playbook.

## Step 3: Load the playbook

Read the full `~/.syntaur/playbooks/<slug>.md` file. Note its frontmatter
(`name`, `slug`, `description`, `when_to_use`, `tags`) and read the **entire**
markdown body — that body is the set of directives.

## Step 4: Apply the playbook

Treat the playbook body as behavioral directives that **take precedence over
default conventions** for the remainder of the relevant work (on top of the
ticket's stage instructions from `syntaur show`). Keep following them for the
rest of the session's work on this topic, not just the next action.

## Step 5: Report to User

Confirm:

- Which playbook was loaded — display name, slug, and absolute path.
- A one-line summary of what it now governs (from its `when_to_use` / first
  directives), e.g. "Now applying **Commit Discipline**: small, logical commits
  tied to plan tasks."
