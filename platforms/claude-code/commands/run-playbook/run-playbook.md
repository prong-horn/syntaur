---
name: run-playbook
description: Load a Syntaur playbook's full content and follow its directives (resolves by name/slug against enabled playbooks)
arguments:
  - name: slug
    description: "<playbook name or slug> (omit to list available playbooks)"
    required: false
---

# /run-playbook

Thin wrapper that invokes the `run-playbook` skill via the Skill tool. The skill resolves a playbook by name/slug against enabled files under `~/.syntaur/playbooks/`, loads its full content, and follows its directives. With no argument it lists the available playbooks.
