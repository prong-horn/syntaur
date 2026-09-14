---
id: spike
version: 1
builtin: spike@1
description: Time-boxed research with findings deliverable; no plan or review stage.
whenToUse: Research, design exploration, or spikes with a written outcome.
workspace: none
defaultPriority: medium
stages:
  - id: backlog
    instructions: Define the spike question in the objective.
  - id: in_progress
    instructions: Investigate and write findings.md. Notes go in notes.md.
    agent: cursor
    auto: true
  - id: done
    instructions: findings.md must be non-empty before syntaur done.
files:
  - path: findings.md
    role: deliverable
    writer: agent
    createOn: in_progress
    description: Research findings and recommendation; this is the handoff artifact for spikes.
  - path: notes.md
    role: notes
    writer: agent
    createOn: ticket-creation
    description: Scratch notes during investigation.
gates:
  done: [deliverable-present]
---

Built-in template; copy the directory to customise
