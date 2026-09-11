---
name: doctor-syntaur
description: Diagnose and help recover from common Syntaur bad states
arguments:
  - name: args
    description: "Optional flags: --verbose, --only <check-id>"
    required: false
---

# /doctor-syntaur

Thin wrapper that invokes the `doctor-syntaur` skill via the Skill tool. Runs `syntaur doctor --json`, interprets the report, and offers remediation within write boundaries.

Arguments: $ARGUMENTS

If the skill is not installed, tell the user to run `syntaur install-plugin`.
