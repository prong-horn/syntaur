---
name: syntaur-protocol
description: >-
  Use when the user mentions Syntaur, tickets, ~/.syntaur/, ticket.md,
  .syntaur/context.json, templates, or syntaur show. Run show and follow it.
license: MIT
metadata:
  author: prong-horn
  version: "2.1.0"
---

# Syntaur Protocol

Run `syntaur show <ID>` (or `syntaur show` when an engagement is open) at the start of work and after every lifecycle verb. Read the rendered summary: follow **Stage** and **Next**.

Edit only `ticket.md` and the files `show` lists whose writer is `agent`. Use the **Commands** line for CLI-mediated files (for example `syntaur log`, `syntaur progress log`, `syntaur show`).

Never edit files `show` does not list. Never write `project.md`, `_index-*.md`, `manifest.md`, or another ticket's folder. Log-role files (`journal.md`) are append-only via `syntaur log -t <type>` — never edit directly. Workspace files stay inside the ticket's configured worktree.
