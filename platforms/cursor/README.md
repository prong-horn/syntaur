# Cursor Integration (Reference Only)

Cursor does not have a native plugin system like Claude Code or Codex. Syntaur integrates with Cursor via **adapter files** generated into your project directory.

## How it works

Cursor reads `.cursor/rules/*.mdc` files with YAML frontmatter. Syntaur generates these files to teach Cursor the Syntaur protocol for a specific ticket.

## Setup

Generate adapter files for a specific ticket:

```bash
syntaur setup-adapter cursor --project <project-slug> --ticket <ticket-id>
```

This creates:
- `.cursor/rules/syntaur-protocol.mdc` — Protocol rules (always active)
- `.cursor/rules/syntaur-ticket.mdc` — Ticket-specific context

## .mdc file format

```yaml
---
description: Rule description
globs: "**/*"
alwaysApply: true
---

Markdown content with instructions for the agent.
```

- `alwaysApply: true` means the rule is always active (not scoped to specific files)
- Files go in `.cursor/rules/` directory

## Reference template

See `adapters/syntaur-protocol.mdc` in this directory for the template format.

## Docs

- https://cursor.com/docs/plugins
