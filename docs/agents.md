# Agent library

Syntaur keeps a flat list of named **agents**. Each agent has a **runner** type
badge — `claude`, `pi`, or `codex` — and launches the same two ways: **standalone**
or **onto an assignment**. Agents enter the list three ways: **discover → register**,
**manual add**, or **create new**. The everyday UX lives on the `/agents` dashboard
surface; `/settings → Agents` keeps only admin config (raw field edit + discovery
settings).

## Discovery

Discovery is a set of individually-toggleable **sources**, each feeding one
"Discovered — click to register" tray:

- **Claude global** — `~/.claude/agents/**/*.md`
- **Claude project** — `<repo>/.claude/agents/**/*.md` (the current workspace repo,
  plus any depth-1 dir under a scan root that has a `.claude/agents/`)
- **Directory scan** — depth-1 directories under the configured **roots**
  (default `~`) that carry a **strong marker**

Sources and roots are configured in **Settings → Agents** (persisted to
`~/.syntaur/config.md` under `agentDiscovery.*`).

### Strong-marker policy

A scanned directory is auto-surfaced **only** when it has one of:

- `.pi/` (⇒ inferred runner `pi`)
- `.mcp.json`
- `.claude/agents/`
- an `AGENTS.md` or `SYNTAUR.md` that carries a [`syntaur:` opt-in](#the-syntaur-frontmatter-opt-in)

A **bare `AGENTS.md`** (no `syntaur:` block) is **not** auto-surfaced — `AGENTS.md`
has become a generic convention in plain code repos, so surfacing every one would
bury the real agents. A bare-`AGENTS.md` directory is still adoptable via
**manual add** (below), or by adding one `syntaur:` line to opt it in.

Inferred runner for a directory candidate: `syntaur.runner` wins; else `.pi/` ⇒ `pi`;
else it defaults to `pi` and is **confirmable when you register it**.

## The `syntaur:` frontmatter opt-in

Optional, but the guaranteed path. Drop a `syntaur:` block into the def file — a
Claude agent `.md`, an `AGENTS.md`, or a standalone `SYNTAUR.md`:

```markdown
---
syntaur:
  name: job-applier
  runner: pi
  description: Applies to jobs end-to-end
---
```

A file carrying it is **always surfaced**, ranked **first** ("recommended"), and
supplies a clean `name` / `runner` / `description`. It is never required —
heuristic marker-scanning still finds strong-marker directories without it. Use the
block form shown above (an indented `syntaur:` mapping); inline forms are not parsed.

## Register & manual add

- **Register** — one click on a discovered candidate persists a thin pointer +
  overlay into the flat list. The on-disk def stays the source of truth for the
  agent's identity content. Directory candidates confirm the runner first.
- **Manual add** — point at a file or folder Syntaur's scan missed (including a
  bare `AGENTS.md` directory). The always-works fallback.

## Create new

`/agents → Create`, or the CLI:

```bash
# A Claude agent → ~/.claude/agents/<slug>.md (or a project dir via --location)
syntaur agents new --name "Researcher" --type claude \
  --model opus --description "Deep research" \
  --instructions "You are a meticulous researcher."

# A directory agent → <location>/<slug>/AGENTS.md (+ syntaur: opt-in)
syntaur agents new --name "Job Applier" --type pi \
  --location ~ --instructions @./prompt.md
```

`--instructions` takes literal text or `@path` to read a file. Syntaur writes a
runner-native def (with a `syntaur:` block so it re-discovers cleanly) and
auto-registers it. The authored def works with the runner directly, outside
Syntaur. `--dry-run` authors without registering.

Rich authoring (MCP servers, tool allow-lists, `.pi/extensions`, multi-runner dirs)
is deferred — v1 scaffolds a minimal, hand-editable def.

## Launch

- **Onto an assignment** — a claude agent runs `--agent <name>` in the worktree; a
  directory agent launches from its own dir with the worktree path injected
  (`@worktree`).
- **Standalone** — a directory agent launches from its dir; a **claude agent
  launches from `standaloneDefaultCwd` (Settings → Agents) or your home directory**.

```bash
syntaur agents launch <id>            # standalone
syntaur agents list                   # shows the runner badge + source
```
