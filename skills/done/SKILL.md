---
name: done
description: >-
  Complete a Syntaur ticket through review and done gates. Use when finishing work,
  submitting for review, ticking acceptance criteria, or running /done.
license: MIT
metadata:
  author: prong-horn
  version: "3.0.0"
---

# Done

Run `syntaur show <ID>` and follow **Stage**, **Next**, and **Commands**. All writes go through CLI verbs.

## Criteria and logs

Tick each met item in `ticket.md` **Acceptance Criteria** as you finish it.

```bash
syntaur log <ID> -t progress "final state" --project <slug>
syntaur log <ID> -t handoff "<summary>" --project <slug>
```

Review verdicts are the reviewer's job: `syntaur log <ID> -t review --verdict approve --open high=0,medium=0` (not the implementer's).

## Lifecycle

```bash
syntaur review <ID> --project <slug>
syntaur done <ID> --project <slug>
```

If a gate refuses, fix what **Next** names — never `--force`.

## Cleanup

Remove the workspace marker last: `rm .syntaur/context.json` in the worktree root.
