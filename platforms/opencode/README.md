# OpenCode Integration (Reference Only)

OpenCode does not have a persistent plugin system like Claude Code or Codex. Syntaur integrates with OpenCode via **adapter files** generated into your project directory.

## How it works

OpenCode discovers skills from `SKILL.md` files in several directories and reads `AGENTS.md` at the project root. Syntaur generates an `AGENTS.md` and optional `opencode.json` to teach OpenCode the Syntaur protocol.

## Setup

Generate adapter files for a specific assignment:

```bash
syntaur setup-adapter opencode --project <project-slug> --assignment <assignment-slug>
```

This creates:
- `AGENTS.md` — Protocol instructions and assignment context
- `opencode.json` — Optional config with instruction pointers

## Skill discovery paths

OpenCode searches these locations (project-local, walking up to git root):
- `.opencode/skills/<name>/SKILL.md`
- `.claude/skills/<name>/SKILL.md`
- `.agents/skills/<name>/SKILL.md`

Global paths:
- `~/.config/opencode/skills/<name>/SKILL.md`
- `~/.claude/skills/<name>/SKILL.md`
- `~/.agents/skills/<name>/SKILL.md`

## SKILL.md format

```yaml
---
name: my-skill
description: What this skill does (1-1024 chars)
---

Markdown body with skill instructions.
```

- `name`: 1-64 chars, lowercase alphanumeric with single hyphens (`^[a-z0-9]+(-[a-z0-9]+)*$`)
- `description`: required, 1-1024 characters

## Reference template

See `adapters/opencode.json.template` in this directory for the config format.

## Docs

- https://opencode.ai/docs/skills/
