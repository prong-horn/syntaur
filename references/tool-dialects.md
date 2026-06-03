# Cross-agent tool dialects & agent-id mapping

Syntaur ships its skills **verbatim** to every agent (no build-time tool-name
rewriting), exactly as the Agent Skills ecosystem (skills.sh) does across 56
agents. This works because Syntaur skills are overwhelmingly **`syntaur <cmd>`
CLI-driven** — they tell the agent to run `syntaur grab-assignment`,
`syntaur start`, etc., not to call raw `Read`/`Edit`/`Bash` tools — so each
agent's native tool dialect is largely irrelevant to whether a Syntaur skill
works.

For reference, the tool dialects of the agents Syntaur targets:

| Agent | Tool dialect | Notes |
|-------|--------------|-------|
| Claude Code | `Read` / `Edit` / `Bash` (PascalCase) | native plugin path |
| Codex | own toolset | native plugin path + AGENTS.md adapter |
| Pi | `read` / `edit` / `bash` (lowercase) | reads `AGENTS.md` or `CLAUDE.md` |
| OpenClaw | `read` / `edit` / `bash` (built on Pi) | workspace `AGENTS.md` / `SOUL.md` |
| Hermes Agent | `read_file` / `patch` / `terminal` (snake_case, toolset-gated) | reads `SOUL.md` / context files |
| Cursor | editor tools | `.cursor/rules/*.mdc` |
| OpenCode | own toolset | `AGENTS.md` + `opencode.json` |

If a future skill leans heavily on raw tool calls, prefer phrasing instructions
in terms of the **action** ("read the file", "run the command") rather than a
specific tool name, and document any agent-specific caveat here rather than
forking the skill.

## Syntaur target id ↔ skills.sh / Agent Skills agent id

Syntaur's registry (`src/targets/registry.ts`) uses short Syntaur ids; the
Agent Skills ecosystem (`npx skills add --agent <id>`) uses its own ids, which
differ for some agents. `skillsShAgentId` on each descriptor holds the mapping:

| Syntaur id | skills.sh agent id | global skills dir |
|------------|--------------------|-------------------|
| `claude`   | `claude-code`      | `~/.claude/skills` |
| `codex`    | `codex`            | `~/.codex/skills` |
| `cursor`   | `cursor`           | `~/.cursor/skills` |
| `opencode` | `opencode`         | `~/.config/opencode/skills` |
| `pi`       | `pi`               | `~/.pi/agent/skills` |
| `openclaw` | `openclaw`         | `~/.openclaw/skills` |
| `hermes`   | `hermes-agent`     | `$HERMES_HOME/skills` (default `~/.hermes/skills`) |

> **Hermes caveat:** `npx skills add --agent hermes-agent` always installs to
> `~/.hermes/skills`, ignoring `$HERMES_HOME`. When `$HERMES_HOME` points
> elsewhere, `syntaur setup --target hermes` additionally performs an offline
> copy into `$HERMES_HOME/skills` so the real dir is covered.
