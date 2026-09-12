---
name: run-playbook
description: Load a Syntaur playbook's full content and follow its directives (resolves by name/slug against the manifest)
arguments:
  - name: args
    description: "<playbook name or slug> (omit to list available playbooks)"
    required: false
---

# /run-playbook

Thin wrapper that invokes the `run-playbook` skill via the Skill tool. The skill resolves a playbook by name/slug against `~/.syntaur/playbooks/manifest.md`, loads its full content, and follows its directives. With no argument it lists the available playbooks.

Arguments: $ARGUMENTS

If the skill is not installed, tell the user to run `syntaur install-plugin`.
