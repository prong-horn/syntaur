# Codex Plugin

Syntaur plugin for OpenAI Codex. Installed automatically during `syntaur setup`.

## What's included

- **Skills:** syntaur-protocol, create-mission, create-assignment, grab-assignment, plan-assignment, complete-assignment, track-session
- **Hooks:** write boundary enforcement, session cleanup
- **Commands:** track-session
- **Agents:** syntaur-protocol (background)
- **References:** protocol docs

## Manual install

```bash
syntaur install-codex-plugin
```

## Plugin structure

```
platforms/codex/
├── .codex-plugin/plugin.json    # Plugin manifest
├── skills/                      # Skill definitions (SKILL.md per skill)
├── hooks.json                   # Hook definitions
├── commands/                    # Slash commands
├── agents/                      # Agent definitions
├── scripts/                     # Hook scripts
├── references/                  # Protocol reference docs
└── adapters/                    # AGENTS.md template for per-project adapter setup
```

## Marketplace

The Codex plugin is registered via a marketplace.json file:
- Personal: `~/.agents/plugins/marketplace.json`
- Repo: `$REPO_ROOT/.agents/plugins/marketplace.json`

## Docs

- https://developers.openai.com/codex/plugins
- Plugin authoring: https://developers.openai.com/codex/build-plugins
