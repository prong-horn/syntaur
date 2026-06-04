# Syntaur extension for pi / OpenClaw (Tier-3)

A self-contained pi-coding-agent extension that brings Syntaur's Tier-3 enforcement parity (the same
behavior the Claude Code / Codex plugins have) to **pi** and **OpenClaw** (which runs on
pi-coding-agent):

- **Write-boundary enforcement** — a `tool_call` handler blocks edits/writes outside the active
  assignment's boundaries (assignment dir, project `resources/`+`memories/` excluding derived `_*`
  files, and the workspace root), mirroring `platforms/claude-code/hooks/enforce-boundaries.sh`.
- **Session cleanup** — a `session_shutdown` handler marks the dashboard session `stopped`.
- **Slash commands** — `doctor-syntaur` runs `syntaur doctor`; the rest (`grab-assignment`,
  `log-progress`, `complete-assignment`, `save-session-summary`, `resume-session`, `set-workspace`,
  `track-session`) point the agent at the installed Tier-1 skill of the same name.

## Install

`syntaur setup --target pi` (or `--target openclaw`) copies this directory into the agent's extension
dir:

- pi → `~/.pi/agent/extensions/syntaur/`
- OpenClaw → `~/.openclaw/extensions/syntaur/`

pi auto-discovers `*/index.ts` extensions there (loaded via jiti). `syntaur doctor` reports Tier-3
install status.

## Notes & caveats

- **OpenClaw assumption:** per the cross-agent design memo, OpenClaw runs on `pi-coding-agent` and
  loads the same extension format, so it reuses this exact source (only the install dir differs). If a
  given OpenClaw build diverges to its own plugin system, only the install target needs repointing.
- The boundary decision logic (`isWriteAllowed`, `extractWritePath`, `loadContext`) is exported and
  unit-tested in Syntaur's `src/__tests__/pi-extension.test.ts`.
- Fail-open: if there is no `.syntaur/context.json` or the tool call isn't a write, the extension
  allows it — exactly like the bash hooks.
