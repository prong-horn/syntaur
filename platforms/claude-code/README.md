# Claude Code Plugin

Syntaur plugin for Claude Code. Installed automatically during `syntaur setup`.

## What's included

- **Skills:** grab-assignment, plan-assignment, complete-assignment, create-project, create-assignment, syntaur-protocol, resume-session
- **Agents:** syntaur-protocol (background)
- **Hooks:** session-start, session-end, session-touch (PostToolUse / UserPromptSubmit). Write boundaries are documentation-enforced in Claude Code (the Codex plugin enforces them with a PreToolUse hook).
- **Commands:** track-session, resume-session
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
├── hooks/                       # Session lifecycle hooks (no write-boundary PreToolUse hook)
├── commands/                    # Slash commands
├── agents/                      # Agent definitions
└── references/                  # Protocol reference docs
```

## Docs

- https://code.claude.com/docs
- Plugin authoring: https://code.claude.com/en/create-plugins
