---
name: syntaur-protocol
description: >-
  Use when the user mentions Syntaur, tickets, ~/.syntaur/, ticket.md,
  .syntaur/context.json, stage instructions, or syntaur show. Run show and follow it.
license: MIT
metadata:
  author: prong-horn
  version: "3.0.0"
---

# Syntaur Protocol

Run `syntaur show <ID>` (or `syntaur show` when an engagement is open) at the start of work and after every lifecycle verb. Read **Stage**, **Next**, and **Commands** — the UserPromptSubmit hook injects the current stage block, so trust it over memory.

Edit only `ticket.md` and files `show` lists with `writer: agent`. Use CLI verbs for log-role files (`syntaur log -t <type>`); never edit `journal.md` directly.

**Lifecycle:** `--by <name>` attributes audit events on lifecycle verbs, plan create/version, and flag verbs. On `start` only, `--agent <id>` is a one-use dispatch recipient (not audit attribution). `assign --agent`, `log --agent`, and `track-session --agent` keep their usual meanings.

**Stage handoff:** stages may declare `agent` or `reviewer` with optional `auto`. Reviewers record verdicts with `syntaur log <ID> -t review --agent <id> --verdict approve|changes --open high=<n>,medium=<n>` when the template allows.

Never edit files `show` does not list. Never write `project.md`, indexes, or another ticket's folder. Workspace work stays inside the ticket's configured worktree.
