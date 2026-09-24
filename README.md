# Syntaur

Syntaur is a local project and ticket workflow for coding agents. It ships a CLI, a dashboard, and a six-skill pack for Claude Code.

## Requirements

- Node.js 20+
- `npm` 7+ (ships with Node 20); `npx` is used for zero-install runs

---

## Install

Two supported install styles. Both pull the same package from npm; the only difference is whether the `syntaur` binary lives on your `$PATH` or inside npm's cache.

### Option A — `npx` (no global install)

Best for trying Syntaur once, or for users who don't want anything on their `$PATH`.

```bash
npx syntaur@latest           # first run: initializes ~/.syntaur/ and prints the set-up steps
npx syntaur@latest dashboard
npx syntaur@latest doctor
```

Every `npx syntaur@latest <cmd>` resolves against the npm registry (so you stay up to date), then runs from the cache at `~/.npm/_npx/<hash>/`. The CLI is not on your `$PATH` — you must type `npx syntaur@latest ...` each time.

### Option B — Global install

Best for day-to-day use. You can run `syntaur ...` directly.

```bash
npm install -g syntaur
syntaur                        # first run: initializes ~/.syntaur/ and prints the set-up steps
syntaur dashboard
```

To upgrade: `npm install -g syntaur@latest`.

### Option C — Upgrade from `npx` to global

If you start on `npx`, the CLI notices and offers to install globally on the first interactive run:

```
You're running syntaur via npx. Install it globally for faster startup?
  1) Yes — install now
  2) Maybe later — just start it for now
  3) Never — don't ask again
```

- **1** runs `npm install -g syntaur` for you and records the decision in `~/.syntaur/npx-install.json`.
- **2** does nothing permanent; you'll be asked again on the next `npx` run.
- **3** writes `decision: never` to that same state file so the prompt never reappears.

The prompt is automatically suppressed when:

- stdin or stdout isn't a TTY (piped commands, CI)
- the invocation is a meta command (`--help`, `--version`, `help`)
- `SYNTAUR_SKIP_INSTALL_PROMPT=1` is set
- `~/.syntaur/npx-install.json` already records a decision

To re-trigger the prompt after you've dismissed it, delete the state file:

```bash
rm ~/.syntaur/npx-install.json
```

If you're already globally installed and later run a newer `npx syntaur@latest`, the CLI instead offers to upgrade your global install to match.

---

## Set up

After installing the CLI (`npm install -g syntaur` or `npx syntaur@latest`), run these steps in order:

1. **`syntaur init`** — creates `~/.syntaur/` (config, SQLite session registry, playbooks, built-in ticket templates), initialises a git repository with `.gitignore`, and installs `home-commit.sh` plus a daily auto-commit scheduler (use `--no-auto-commit` to skip the scheduler).
2. **`npx skills add prong-horn/syntaur -g -a claude-code`** — installs the six protocol skills into `~/.claude/skills/`. Optional: `-a codex` or `-a cursor` for other harnesses (ACP chat participants do not need skills).
3. **`syntaur hooks install`** — copies hook scripts to `~/.syntaur/hooks/` and wires SessionStart, PostToolUse, and UserPromptSubmit in `~/.claude/settings.json` (backs up the previous `hooks` key to `~/.syntaur/hooks.backup.json`).
4. **`syntaur statusline install`** *(optional)* — installs the syntaur status line in Claude Code settings.
5. **`syntaur dashboard`** — open the local web UI.

`init` prints reminders for steps 2–4 when you have not run them yet.

---

## What Gets Installed Where

| Location | What lives there | Managed by |
|---|---|---|
| `~/.syntaur/` | Projects, tickets, `templates/`, `playbooks/`, `config.md`, `syntaur.db`. Scratch tickets live under `projects/scratch/` (`SCR` prefix). | You (via CLI) |
| `~/.syntaur/.git` | Git history for the home (created by `syntaur init`) | `syntaur init` |
| `~/.syntaur/home-commit.sh` | Daily auto-commit script | `syntaur init` |
| `~/Library/LaunchAgents/com.syntaur.home-commit.plist` | macOS scheduler for `home-commit.sh` (when auto-commit is enabled) | `syntaur init` |
| `~/.syntaur/hooks/` | Session hook shell scripts copied by `syntaur hooks install` | `syntaur hooks install` / `uninstall` |
| `~/.claude/settings.json` | Three Syntaur hook entries and optional `statusLine` | `syntaur hooks` / `syntaur statusline` |
| `~/.claude/skills/<name>/` | Six protocol skills (`syntaur-protocol`, `grab`, `plan`, `done`, `log`, `worktree`) | `npx skills add prong-horn/syntaur` |
| `~/.syntaur/npx-install.json` | Remembers your answer to the "install globally?" prompt | CLI |
| `~/.npm/_npx/<hash>/` | npx-cached copy of the `syntaur` package | npm |
| `$(npm root -g)/syntaur/` | Globally-installed package | `npm install -g` |
| `<repo>/.syntaur/context.json` | Workspace marker (ticket id, worktree paths, session id) | `grab` / `worktree` skills and SessionStart hook |

---

## Working a ticket

Open the dashboard, open a ticket, and use its **Chat** tab. Sending a
message there spawns a real coding agent in the ticket's worktree — the
dashboard server speaks the Agent Client Protocol to a `claude-agent-acp` or
`codex-acp` adapter it owns — and renders the work as a conversation: streaming
replies, tool cards with diffs and command output, a plan checklist, inline
permission prompts, and per-turn cost. Several agents can share one chat and
hand work to each other by `@mention`.

Before coding (or from a terminal), run `syntaur show <id>` — it is the agent
guide: stage instructions, which files to edit, the **Next** lifecycle step, and
CLI commands. Chat injects the full rendered `show` text as standing context on
the first turn.

```bash
syntaur dashboard
npm i -g @agentclientprotocol/claude-agent-acp   # or …/codex-acp
```

See [docs/ticket-chat.md](docs/ticket-chat.md) for agent definitions,
routing, hand-offs, **stage-owned one-turn dispatch**, and where the data lives.

### Stage handoff

Template stages may declare an `agent` or `reviewer` target with optional `auto`.
When you enter a stage, the dashboard may run **one** exact-target agent turn
for that stage (automatic when `auto: true`, or after **Hand to** when manual).
Ordinary **Chat** stays available at every stage — stage dispatch does not
replace multi-turn work in chat.

- `syntaur start <id> --agent <id>` — one-use dispatch recipient override only
  (not audit attribution); use `--by <name>` on lifecycle verbs for the event log
- `syntaur start <id> --no-dispatch` (and the same flag on other stage move verbs)
  — record the stage without automatic handoff when you run your own implementer
- Offline dispatch leaves the stage move intact; recover from the ticket page
- A `completed` receipt means the agent turn ended, not that review passed or the
  ticket is done

Create separate agent definitions in the dashboard **Library** when you want
different models on the same harness — for example implementer `cursor` with
model `composer-2.5` and reviewer `reviewer` with harness `cursor` and model
`cursor-grok-4.6-high`. Reviewers record verdicts with
`syntaur log <ID> -t review --agent <id> --verdict approve|changes --open high=<n>,medium=<n>`.

Syntaur used to launch an agent into a terminal for you — an "Open in agent"
button, a `syntaur://` deep link, a transcript scanner and a PTY daemon. All of
it was removed in v1.0; see the
[release note](docs/releases/v1.0.md) if you are upgrading an existing install.

## Lifecycle verbs (v2)

Tickets move through fixed **stages** via explicit CLI verbs. `blocked` and `parked` are **flags** (reason strings), not stages.

| Stage | Meaning | Typical verb |
|-------|---------|--------------|
| `backlog` | Not started | `syntaur new` |
| `planning` | Plan being written | `syntaur plan create` |
| `ready` | Plan approved | `syntaur approve` |
| `in_progress` | Active work | `syntaur start` |
| `review` | Awaiting review | `syntaur review` |
| `done` | Completed | `syntaur done` |
| `dropped` | Abandoned | `syntaur drop` |

Flag verbs: `syntaur block`, `unblock`, `park`, `unpark`. Reopen terminal tickets: `syntaur reopen`. Add `--by <name>` on any lifecycle verb, plan create/version, or flag verb to attribute the action in the audit log (`human` by default). On `start` only, `--agent <id>` selects a one-use stage dispatch recipient — not the audit actor. Run `syntaur show <id>` for the **Next** hint, **Agent:** handoff status, and gate checks.

## Common Commands

```bash
syntaur dashboard
syntaur project new "My First Project"
syntaur new "Implement feature" --project my-first-project
syntaur history <id> --project <slug>
syntaur doctor
```

To remove the CLI, see [Uninstall](#uninstall) (`syntaur hooks uninstall`, `syntaur statusline uninstall`, `npm uninstall -g syntaur`).

### Search

`syntaur search <query>` runs full-text search across ticket markdown — `ticket.md`, latest plan, `journal.md` (log role), legacy `progress.md`, scratchpads, and related sidecars until migrated. Archived items are excluded unless you pass `--all`.

Typed records (progress, decisions, handoffs, Q&A, reviews) append via `syntaur log -t <type>` to the template log role (`journal.md` on modern templates). `syntaur progress log` aliases `-t progress`. Legacy tickets can merge sidecars with `syntaur migrate journal`.

```bash
# Search across everything
syntaur search "rate limit"

# Narrow to one project and specific file kinds
syntaur search "stripe webhook" --project my-api --in plans,handoff

# Return structured JSON (path, project, ticket, fileKind, score, snippet, line, section, route)
syntaur search "authentication flow" --json --limit 5
```

Key flags: `--project <slug>`, `--template <list>`, `--status <list>`, `--in <fileKinds>` (singular or plural names accepted), `--all`, `--limit <n>` (default 20), `--semantic`, `--json`.

The dashboard's visible Search button runs the same search and deep-links results to the matching ticket's `?tab=<kind>` pane and `#section` anchor. The `--semantic` flag activates the semantic provider when available; v1 falls back to full-text search via fuse.js.

The dashboard has six destinations: **Needs me** (`/inbox`), **Board** (`/board`), **Ticket** (`/t/:id`), **Sessions** (`/sessions`), **Library** (`/library`), and **Settings** (`/settings`). Board history defaults to active tickets and tickets completed or dropped in the last 30 days; its History controls can show all tickets or older terminal tickets without changing ticket files. Archived projects live in the Board's project panel and can be restored there. Their tickets are shown read-only in the panel and are excluded from the active board feed. Ticket and board metrics show lifetime recorded cost and distinct session count; an unknown or incomplete cost is labelled rather than displayed as zero. Usage details are on Sessions, and playbooks, agents, and read-only template summaries are in Library. Settings links to this README.

Fixed keyboard shortcuts are `g n` Needs me, `g b` Board, `g s` Sessions, `g l` Library, `g ,` Settings, and `n` new ticket. Shortcuts pause while typing or using a dialog; navigation chords time out after one second.

See [`docs/cli.md`](docs/cli.md) for the full reference.

### Timeline

`syntaur timeline <ticket>` shows the per-ticket audit event log — stage moves (`moved`), flags (`flagged`/`unflagged`), plan approval (`plan-approved`), log entries (`logged`), dispatches (`dispatched`), and retemplates (`retemplated`), newest first. The same events appear live on the dashboard **Activity** tab.

```bash
# Show the event log for a ticket
syntaur timeline add-oauth --project my-api

# Filter to stage moves since a date, return JSON
syntaur timeline add-oauth --project my-api \
  --type moved --since 2026-06-01T00:00:00Z --json
```

Key flags: `--project <slug>`, `--since <date>`, `--type <list>` (comma-separated), `--limit <n>` (default 50), `--json`.

### Needs me inbox

`syntaur inbox` is the CLI read-only view of the same reply queue the dashboard **Needs me** page shows: unanswered chat questions and grace-filed cards, plans awaiting approval, and tickets in review — tier order (live cards first), then oldest-first within each category group in the terminal output. Each item prints the exact action command (or Open chat URL for chat rows). The CLI does not offer inline replies; use the dashboard queue for that. The dashboard defaults to the last 14 days (badge follows); use `--max-age` and `--show-snoozed` in the terminal. Snoozes from **Not now** are stored under `~/.syntaur/inbox-snoozes.json` and hide rows everywhere until they expire, lift, or you unsnooze.

```bash
# Show everything awaiting your attention
syntaur inbox

# Filter to a category or project
syntaur inbox --type review,question
syntaur inbox --project my-api

# Emit structured JSON (InboxResult with items[], counts, total)
syntaur inbox --json
```

Key flags: `--project <slug>`, `--type <list>` (comma-separated; `question`, `review`, `plan-approval`), `--limit <n>`, `--json`.

The dashboard **Needs me** page is the live reply queue — tiered order (live cards pinned first), inline actions, browser notifications for new chat rows, project filter, and a nav badge equal to the unfiltered total.

### Migrate events (retired in v1.0)

The standalone `syntaur migrate-events` command is retired. Event backfill from legacy ticket frontmatter now runs as part of `syntaur migrate v2` step **`statuses`** (dry-run by default; `--apply` to write).

Key flags: `--apply`, `--dir <path>` (project directory override).

Any of these can be prefixed with `npx syntaur@latest` if you chose not to install globally.

---

## Protocol Skills

Canonical source: `<repo>/skills/<name>/SKILL.md`. The pack ships six skills:

| Skill | Contract |
|---|---|
| `syntaur-protocol` | Run `syntaur show`; follow Stage/Next; trust the UserPromptSubmit stage block |
| `grab` | Claim a ticket, bind workspace, register the session |
| `plan` | `syntaur plan create` / `plan version`; write `plan.md` via CLI |
| `done` | Criteria, handoff, `review` then `done` |
| `log` | Typed `syntaur log` entries (never edit `journal.md` directly) |
| `worktree` | `syntaur worktree create` and workspace marker |

**Install path (only):**

```bash
npx skills add prong-horn/syntaur -g -a claude-code
```

Upgrade skills after a Syntaur release:

```bash
npx skills update
```

`syntaur doctor` checks `skills.installed` (all six under `~/.claude/skills/`), `hooks.installed`, `git.home-repo`, and `git.auto-commit`.

---

## Upgrade

| Install style | Command |
|---|---|
| Global | `npm install -g syntaur@latest` or `syntaur update` |
| npx | `npx syntaur@latest ...` consults the registry; clear cache with `rm -rf ~/.npm/_npx` if needed |

After upgrading the CLI package, refresh hooks and skills:

```bash
syntaur hooks install    # or let `syntaur update` run it for you
npx skills update
```

---

## Uninstall

```bash
syntaur hooks uninstall
syntaur statusline uninstall
npx skills remove prong-horn/syntaur    # or remove the six dirs under ~/.claude/skills manually
npm uninstall -g syntaur
```

That removes Claude settings entries, hook scripts, skills, and the CLI. It does **not** delete ticket data under `~/.syntaur/`.

To remove data as well (irreversible — back up first):

```bash
rm -rf ~/.syntaur
```

---

## Fresh Reinstall Without Losing Data

```bash
cp -a ~/.syntaur ~/.syntaur.backup-$(date +%Y%m%d)   # optional
syntaur hooks uninstall
syntaur statusline uninstall
npx skills remove prong-horn/syntaur
npm uninstall -g syntaur
npm install -g syntaur@latest
syntaur init --force    # only if you need to recreate config scaffolding; projects are untouched
npx skills add prong-horn/syntaur -g -a claude-code
syntaur hooks install
syntaur doctor
```

Projects, tickets, and `syntaur.db` under `~/.syntaur/` are unchanged unless you delete that directory.

---

## Troubleshooting

Run `syntaur doctor` (or `syntaur doctor --json` for agents). Checks include `hooks.installed`, `skills.installed`, `git.home-repo`, `git.auto-commit`, and `structure.legacy-leftovers` when pre-v2 install files remain.

Common issues:

- **Pre-v2 leftovers after upgrade** — `syntaur migrate cleanup` then `syntaur migrate cleanup --apply` (see [cli.md](./docs/cli.md#syntaur-migrate-cleanup) and [v1.0 upgrade](./docs/releases/v1.0.md)).

- **SQLite schema errors** (`no such column: project_slug` / `assignment_slug` on `sessions` or `events`) — you are on a pre-v2 database or a partial migration. Back up `~/.syntaur`, upgrade to 1.0, and run `syntaur migrate v2 --apply` (v2 homes key `engagement` and `events` by `ticket_id` only).
- **Skills missing** — `npx skills add prong-horn/syntaur -g -a claude-code`; then `syntaur doctor --only skills.installed`.
- **Hooks missing or stale** — `syntaur hooks install` (re-run after upgrade). If the old marketplace plugin is still enabled, doctor warns about duplicate hooks — run `syntaur migrate cleanup --apply` or remove the plugin per [v1.0 cutover](./docs/releases/v1.0.md).
- **Session stays `active` after closing the terminal** — without SessionEnd, pipe the session id to stop: `printf '{"session_id":"<id>"}' | syntaur session stop --from-hook`. Otherwise the dashboard maintenance loop closes rows idle past `session.idleSweepHours` (default 6 h) on its first tick after start and every 45 s, and a ticket reaching `done` closes the sessions engaged on it.
- **`npx syntaur` keeps asking to install globally** — choose "3) Never", or `export SYNTAUR_SKIP_INSTALL_PROMPT=1`.

## Development

```bash
git clone git@github.com:prong-horn/syntaur.git
cd syntaur
npm install
npm run build
npm run typecheck
npm run test:ci-like
```

`npm run test:ci-like` runs the full suite with PATH reduced to the Node toolchain (plus `jq`), an empty `HOME`, and `SYNTAUR_HOME` unset — the same gate the release workflow uses. For a quick local loop without that isolation, `env -u SYNTAUR_HOME npm test` still works.

Skills live at `<repo>/skills/` (six `SKILL.md` files). Hook scripts live at `<repo>/hooks/`. Local skill testing: `npx skills add <path-to-clone> -g -a claude-code`.

## Release Publishing

This repo publishes to npm and the skills index on GitHub Pages from GitHub Actions.

Release flow (on the release branch after gates pass: typecheck, `npx tsc -p tsconfig.tests.json --noEmit`, build, `npm run test:ci-like`, `npm run test:ci-like -- test:dashboard`, dashboard build):

```bash
npm version <bump> -m "chore: release %s"
git checkout main && git merge --ff-only <release-branch>
git push origin main
git push origin v<version>
```

Watch `.github/workflows/publish.yml` on the tag push: the `release` job runs validation and `npm publish` (OIDC); the `pages` job builds `scripts/build-skills-index.mjs` and deploys `.well-known/agent-skills/` to Pages.

One-time npm setup:

- package: `syntaur`
- GitHub repo: `prong-horn/syntaur`
- workflow filename: `publish.yml`

You can configure the trusted publisher either in the npm package settings UI or with npm CLI `11.10+`:

```bash
npx npm@^11.10.0 trust github syntaur --repo prong-horn/syntaur --file publish.yml -y
```

After trusted publishing is working, npm recommends switching the package publishing access to `Require two-factor authentication and disallow tokens`.
