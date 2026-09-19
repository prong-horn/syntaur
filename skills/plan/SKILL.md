---
name: plan
description: >-
  Create or version a Syntaur implementation plan via the CLI. Use when planning
  a ticket, writing plan.md, versioning the plan after implementation, or running /plan.
license: MIT
metadata:
  author: prong-horn
  version: "3.0.0"
---

# Plan

Run `syntaur show <ID>` and follow **Stage**, **Next**, and **Commands**. All writes go through CLI verbs.

## Create or version

From backlog / planning stage:

```bash
syntaur plan create <ID> --project <slug>
```

After an implemented plan needs a new revision:

```bash
syntaur plan version <ID> --project <slug>
```

Use `--by <name>` when audit attribution matters. Never run `syntaur approve` (human only).

## Read

Follow planning **Stage** instructions: `project.md`, `ticket.md`, journal, `depends_on` context (`syntaur show <dep> --log -t decision`).

## Write plan.md

Include objective, decisions, tasks (files + tests), verify steps, and risks. Iterate until independent review has no high or medium findings.

Log accepted decisions and human calls:

```bash
syntaur log <ID> -t decision "<body>" --project <slug>
syntaur log <ID> -t question "<body>" --project <slug>
```

Edit only paths `show` lists with `writer: agent`.
