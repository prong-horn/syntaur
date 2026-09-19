---
name: log
description: >-
  Append typed Syntaur log entries via syntaur log. Use for progress, decisions,
  handoffs, questions, answers, reviews, or notes — never edit journal.md directly.
license: MIT
metadata:
  author: prong-horn
  version: "3.0.0"
---

# Log

Run `syntaur show <ID>` and follow **Stage**, **Next**, and **Commands**. Append only through the CLI.

```bash
syntaur log <ID> "<body>" -t <type> [--project <slug>]
```

**Types:** `progress` (work state), `decision` (accepted choices), `handoff` (session handoff), `question` (needs human), `answer` (use `--answers <iso>`), `review` (`--verdict approve|changes` and `--open high=<n>,medium=<n>`), `note` (misc).

**Options:** `--attach <path>` (repeatable images), `--agent <id>` attribution.

Never edit `journal.md` directly. Use the type that matches what you are recording.
