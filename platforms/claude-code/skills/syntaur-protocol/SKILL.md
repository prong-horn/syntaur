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

Run `syntaur show <ID>` (or `syntaur show` when an engagement is open) at the start of work and after every lifecycle verb. Read the rendered summary: follow **Stage** and **Next**. **Agent:** reports stage dispatch status; **Handoff:** is the latest log handoff entry — separate concerns.

Edit only `ticket.md` and the files `show` lists whose writer is `agent`. Use the **Commands** line for CLI-mediated files (for example `syntaur log`, `syntaur progress log`, `syntaur show`).

**Lifecycle flags:** `--by <name>` on lifecycle verbs, plan create/version, and flag verbs attributes the action in the audit log (`human` by default). On `start` only, `--agent <id>` is a one-use stage dispatch recipient override — not audit attribution. `assign --agent`, `log --agent`, and `track-session --agent` keep their existing meanings.

**Stage handoff:** template stages may declare `agent` or `reviewer` with optional `auto`. Entering a stage may queue one exact-target dashboard turn (automatic when `auto: true`). Ordinary chat remains available at every stage. A completed dispatch receipt means the agent turn ended, not that review passed or the ticket is done. Reviewers record verdicts with `syntaur log <ID> -t review --agent <id> --verdict approve|changes --open high=<n>,medium=<n>` when the template log role allows it.

Never edit files `show` does not list. Never write `project.md`, `_index-*.md`, `manifest.md`, or another ticket's folder. Log-role files (`journal.md`) are append-only via `syntaur log -t <type>` — never edit directly. Workspace files stay inside the ticket's configured worktree.
