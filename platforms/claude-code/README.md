# Claude Code Plugin

Syntaur plugin for Claude Code. Installed automatically during `syntaur setup`.

## What's included

- **Skills:** grab-assignment, plan-assignment, complete-assignment, create-project, create-assignment, syntaur-protocol
- **Agents:** syntaur-protocol (background)
- **Hooks:** write boundary enforcement (PreToolUse)
- **Commands:** track-session
- **References:** protocol docs

## Manual install

```bash
syntaur install-plugin
```

## Plugin structure

```
platforms/claude-code/
├── .claude-plugin/plugin.json   # Plugin manifest
├── skills/                      # Skill definitions (SKILL.md per skill)
├── hooks/                       # PreToolUse hooks for write boundary enforcement
├── commands/                    # Slash commands
├── agents/                      # Agent definitions
└── references/                  # Protocol reference docs
```

## Docs

- https://code.claude.com/docs
- Plugin authoring: https://code.claude.com/en/create-plugins
