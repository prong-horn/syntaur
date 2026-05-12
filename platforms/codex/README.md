# Codex Plugin

Syntaur plugin for OpenAI Codex. Installed automatically during `syntaur setup`.

## What's included

- **Skills:** syntaur-protocol, create-project, create-assignment, grab-assignment, plan-assignment, complete-assignment, track-session, save-session-summary, manage-statuses, clear-assignment, replan, resume-session, syntaur-worktree, add-resource, add-memory, list-assignments, log-progress, set-workspace
- **Hooks:** write boundary enforcement, session cleanup
- **Commands:** track-session, save-session-summary, replan, resume-session, syntaur-worktree, add-resource, add-memory, list-assignments, log-progress, set-workspace (Codex has no `PreCompact` event — invoke save-session-summary manually before compaction or session end)
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
