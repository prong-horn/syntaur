---
id: quick
version: 1
builtin: quick@1
description: Two-stage card for small chores; no template files.
whenToUse: Small tasks that do not need plan, log, or review; replaces todo-store chores.
workspace: none
defaultPriority: low
stages:
  - id: backlog
    instructions: Do the work described in the objective, then syntaur done.
  - id: done
    instructions: Terminal.
files: []
gates:
  done: []
---

Built-in template; copy the directory to customise
