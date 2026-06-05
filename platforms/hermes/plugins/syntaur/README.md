# Syntaur plugin for Hermes Agent (Tier-3)

A self-contained Python plugin that brings Syntaur's Tier-3 enforcement to **Hermes Agent**, mirroring
the Claude Code / Codex bash hooks:

- **`pre_tool_call`** — detects writes (Hermes snake_case tools: `patch`, `write_file`, `edit_file`,
  `create_file`, `apply_patch`) outside the active assignment boundary and **logs + best-effort blocks**
  them. Boundary logic in `boundary.py` mirrors `platforms/claude-code/hooks/enforce-boundaries.sh`.
- **`on_session_end`** — marks the Syntaur dashboard session `stopped`.
- **Slash commands** — `doctor-syntaur` runs `syntaur doctor`; the rest point at the installed Tier-1
  skill of the same name.

## Install

`syntaur setup --target hermes` copies this directory into `~/.hermes/plugins/syntaur/` (or
`$HERMES_HOME/plugins/syntaur/`). Hermes auto-discovers `plugin.yaml` plugins there. `syntaur doctor`
reports Tier-3 install status.

## Layout

```
syntaur/
├── plugin.yaml    # manifest: name, version, provides_hooks
├── __init__.py    # register(ctx): registers the hooks + commands
└── boundary.py    # pure write-boundary logic (unit-tested via python3)
```

## Caveats

- **Blocking is best-effort (version-dependent).** Hermes documents `pre_tool_call` primarily as a
  fire-and-forget observer; some versions allow a return value to block. This plugin returns a deny
  signal AND logs every violation to stderr + `~/.syntaur/tier3-violations.log`, so enforcement is
  observable even if a given Hermes build ignores the block. Verify hard-block behavior against your
  live Hermes runtime.
- Hooks never raise (the Hermes handler contract) — all bodies are wrapped in try/except.
- `boundary.py` is unit-tested for real (executed via `python3`) in Syntaur's
  `src/__tests__/hermes-plugin.test.ts`.
