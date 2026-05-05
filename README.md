# Syntaur

Syntaur is a local project and assignment workflow for coding agents. It ships a CLI, a dashboard, a Claude Code plugin, and a Codex plugin.

## Requirements

- Node.js 20+
- `npm` 7+ (ships with Node 20); `npx` is used for zero-install runs

---

## Install

Two supported install styles. Both pull the same package from npm; the only difference is whether the `syntaur` binary lives on your `$PATH` or inside npm's cache.

### Option A — `npx` (no global install)

Best for trying Syntaur once, or for users who don't want anything on their `$PATH`.

```bash
npx syntaur@latest           # first run: initializes ~/.syntaur/ and walks setup
npx syntaur@latest dashboard
npx syntaur@latest doctor
```

Every `npx syntaur@latest <cmd>` resolves against the npm registry (so you stay up to date), then runs from the cache at `~/.npm/_npx/<hash>/`. The CLI is not on your `$PATH` — you must type `npx syntaur@latest ...` each time.

### Option B — Global install

Best for day-to-day use. You can run `syntaur ...` directly.

```bash
npm install -g syntaur
syntaur                        # first run: initializes ~/.syntaur/ and walks setup
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

## First-Run Setup

The first time you run `syntaur` or `npx syntaur@latest`, it walks through:

1. Initialize `~/.syntaur/` (config, SQLite session registry, playbooks dir)
2. Offer to install the Claude Code plugin (copies vendored protocol skills into `~/.claude/skills/` too)
3. Offer to install the Codex plugin (copies vendored protocol skills into `~/.codex/skills/` too)
4. Ask where those plugins should live, with sensible defaults based on your machine
5. Offer to launch the dashboard

Run setup explicitly any time:

```bash
syntaur setup                 # or: npx syntaur@latest setup
```

Non-interactive setup (useful in dotfile bootstrap scripts):

```bash
syntaur setup --yes
syntaur setup --yes --claude
syntaur setup --yes --codex
syntaur setup --yes --dashboard
```

---

## What Gets Installed Where

A full install (CLI + both plugins + skills) touches the following locations:

| Location | What lives there | Managed by |
|---|---|---|
| `~/.syntaur/` | Your data: `projects/`, `assignments/`, `playbooks/`, `config.md`, `syntaur.db` | You (via CLI). Never deleted by `syntaur uninstall` unless `--all` is passed. |
| `~/.syntaur/npx-install.json` | Remembers your answer to the "install globally?" prompt | CLI |
| `~/.npm/_npx/<hash>/` | npx-cached copy of the `syntaur` package | npm |
| `$(npm root -g)/syntaur/` | Globally-installed copy of the `syntaur` package | `npm install -g` |
| `~/.claude/plugins/.../syntaur/` | Claude Code plugin directory (slash commands, hooks, agent, marketplace entry) | `syntaur install-plugin` |
| `~/.claude/skills/<skill>/` | Protocol skills (11 of them, including `save-session-summary`) | `npx skills add prong-horn/syntaur` OR `syntaur install-plugin --force-skills` (skipped by default when the plugin is enabled) |
| `~/.claude/plugins/marketplaces/<name>/plugins/syntaur/skills/` | Plugin-loaded skills (preferred path when the plugin is enabled) | `syntaur install-plugin` mirrors `<repo>/skills/` here |
| `~/.codex/plugins/syntaur/` (or chosen dir) | Codex plugin directory (commands, hooks, mirrored skills) | `syntaur install-codex-plugin` |
| `~/.codex/skills/<skill>/` | Protocol skills (when not using the plugin path) | `npx skills add prong-horn/syntaur -a codex` OR `syntaur install-codex-plugin --force-skills` |
| `~/.agents/plugins/marketplace.json` | Codex marketplace entry | `syntaur install-codex-plugin` |
| `<repo>/.syntaur/context.json` | Per-workspace agent context (current assignment, session id, transcript path) | Written by the `grab-assignment` skill and SessionStart hooks |

### Plugin install paths

Syntaur remembers the plugin install locations you choose in `~/.syntaur/config.md`. For Claude Code, Syntaur will detect the machine's local plugin marketplace when one exists and recommend installing into that marketplace's `plugins/` directory.

Interactive install (prompts for paths):

```bash
syntaur install-plugin
syntaur install-codex-plugin
```

Explicit paths:

```bash
syntaur install-plugin --target-dir ~/.claude/plugins/marketplaces/user-plugins/plugins/syntaur
syntaur install-codex-plugin \
  --target-dir ~/plugins/syntaur \
  --marketplace-path ~/.agents/plugins/marketplace.json
```

Setup accepts the same overrides:

```bash
syntaur setup \
  --claude --claude-dir ~/.claude/plugins/marketplaces/user-plugins/plugins/syntaur \
  --codex  --codex-dir  ~/plugins/syntaur \
  --codex-marketplace-path ~/.agents/plugins/marketplace.json
```

---

## Common Commands

```bash
syntaur dashboard
syntaur create-project "My First Project"
syntaur create-assignment "Implement feature" --project my-first-project
syntaur doctor
syntaur uninstall
syntaur uninstall --all
```

Any of these can be prefixed with `npx syntaur@latest` if you chose not to install globally.

---

## Protocol Skills

All Syntaur skills live at `<repo>/skills/<name>/SKILL.md` — one canonical source. The full set ships with the package and includes:

`syntaur-protocol`, `grab-assignment`, `plan-assignment`, `complete-assignment`, `create-assignment`, `create-project`, `manage-statuses`, `clear-assignment`, `track-session` (Claude Code agent session registration), `track-server` (tmux dev-server tracking).

There are three install paths, all backed by the same `<repo>/skills/`:

### 1. `npx skills add` — primary, cross-agent (recommended)

Works for Claude Code, Codex, Cursor, OpenCode, Gemini CLI, Cline, Copilot, and ~50 others via the [skills.sh](https://skills.sh) ecosystem CLI:

```bash
# All agents detected on your machine, all syntaur skills:
npx skills add prong-horn/syntaur

# Subset:
npx skills add prong-horn/syntaur --skill grab-assignment

# Specific agents only:
npx skills add prong-horn/syntaur -a claude-code -a codex
```

The skills.sh CLI handles per-agent target paths automatically. No syntaur CLI required.

### 2. Claude Code plugin — convenience for Claude users

Enable the `syntaur` plugin via Claude Code's `/plugin` UI (after the marketplace is registered). Skills are declared inline in the plugin manifest, so enabling the plugin loads them — no separate `~/.claude/skills/` install required.

`syntaur install-plugin` puts the plugin in your local user-plugins marketplace (or any marketplace you've configured) and registers it with Claude Code's `known_marketplaces.json` so it shows up in `/plugin`. Pass `--enable` to flip it on in `settings.json` automatically:

```bash
syntaur install-plugin --enable
```

### 3. `syntaur install-plugin` — power-user / CI path

Provides the full syntaur CLI (track-session, install-statusline, dashboard, doctor, etc.) plus the plugin. By default the plugin path provides the skills — global install into `~/.claude/skills/` is skipped when the plugin is enabled, so the same skill never registers twice. Override knobs:

```bash
syntaur install-plugin --skip-skills          # plugin only; never write ~/.claude/skills
syntaur install-plugin --force-skills         # write skills globally even if the plugin is enabled
syntaur install-plugin --enable               # auto-enable in settings.json after install
syntaur install-plugin --target-dir <path>    # specific marketplace plugin dir
SYNTAUR_PLUGIN_TARGET=<path> syntaur install-plugin   # env override (CI)
syntaur uninstall-skills --all                # remove the syntaur skills from both ~/.claude/skills and ~/.codex/skills
```

`uninstall-skills` is safe: it only removes a skill directory if its `SKILL.md` `name:` matches one we ship, so a user-authored skill with the same dir name is preserved.

### Avoiding duplicates across paths

`syntaur doctor` includes a `skills.dedup` check that flags when the syntaur plugin is enabled AND syntaur skills are also installed globally (which would register the same skill twice). It also checks that `marketplace.json` and `known_marketplaces.json` agree about where the syntaur plugin lives. Run it after switching install paths:

```bash
syntaur doctor --only skills.dedup
syntaur doctor --only integrations.claude-marketplace-registered
```

Symlinks created by `npx skills add` are recognized and never overwritten by the syntaur CLI.

---

## Upgrade

| Install style | Command |
|---|---|
| Global | `npm install -g syntaur@latest` |
| npx | Nothing to do — `npx syntaur@latest ...` always consults the registry. To force a refetch: `rm -rf ~/.npm/_npx` |
| Mixed | `syntaur` (global) stays pinned; `npx syntaur@latest` uses whatever's live. The CLI will prompt to upgrade the global install when the npx version is newer. |

When you upgrade, skills under `~/.claude/skills/` and `~/.codex/skills/` are NOT automatically re-copied. Either:

- **`npx skills add prong-horn/syntaur` users**: run `npx skills update` to pull the latest.
- **Plugin users**: enable / re-enable the plugin in `/plugin`. The plugin manifest references `<plugin-target>/skills/` directly, which is repopulated by `syntaur install-plugin`'s build-time mirror.
- **`syntaur install-plugin` users**: re-run the command. It'll skip any skill you've edited unless you pass `--force-skills`.

---

## Uninstall

Two levels, matching the install. **Neither deletes your projects or assignments unless you explicitly pass `--all`.**

### Standard uninstall — keep your data

```bash
syntaur uninstall
```

Removes:

- Claude Code plugin directory + marketplace entry
- Codex plugin directory + marketplace entry
- Pointers to those locations in `~/.syntaur/config.md`

Preserves: `~/.syntaur/` (projects, assignments, syntaur.db, playbooks, config), all skills under `~/.claude/skills/` and `~/.codex/skills/`, and the `syntaur` CLI itself.

To also remove the installed protocol skills:

```bash
syntaur uninstall-skills --all
```

To also uninstall the CLI:

```bash
npm uninstall -g syntaur     # if globally installed
rm -rf ~/.npm/_npx           # if you want to clear npx cache too
```

### Full uninstall — delete everything including data

```bash
syntaur uninstall --all
```

Removes everything above **plus** `~/.syntaur/` (projects, assignments, database, playbooks, config). If your config points project storage somewhere outside `~/.syntaur`, Syntaur will warn and leave that external directory alone — you're responsible for removing it yourself.

---

## Fresh Reinstall Without Losing Data

If you want to completely reset the installation while keeping all projects and assignments:

```bash
# 1. Safety backup (optional but recommended)
cp -a ~/.syntaur ~/.syntaur.backup-$(date +%Y%m%d)
# or: syntaur backup   (if you've configured the GitHub backup)

# 2. Remove skills from both agent dirs
syntaur uninstall-skills --all

# 3. Remove plugins + marketplace entries (but keep ~/.syntaur/)
syntaur uninstall

# 4. Remove the CLI
npm uninstall -g syntaur          # global install path
rm -f ~/.syntaur/npx-install.json # lets the "install globally?" prompt re-fire

# 5. Fresh install
npm install -g syntaur@latest     # or stay on npx and skip this

# 6. Reinstall plugins + skills
syntaur install-plugin
syntaur install-codex-plugin
syntaur doctor
```

Your projects, assignments, syntaur.db, playbooks, and config.md all survive the cycle. Live agent sessions won't get the new SessionStart hook until you close and reopen them.

---

## Troubleshooting

Run `syntaur doctor` to diagnose inconsistent state (missing files, stale manifests, hook block, schema drift). Pass `--json` for structured output suitable for agents. The `/doctor-syntaur` slash command in the Claude Code plugin wraps it with interactive remediation.

Common issues:

- **"Error: no such column: project_slug"** — pre-v0.2.0 database. Upgrade to the latest `syntaur` (0.3.1+) — the auto-migration runs on next init.
- **Plugin installed but Claude Code doesn't see it** — run `syntaur doctor --only integrations.claude-marketplace-registered`. The most common cause is `~/.claude/plugins/known_marketplaces.json` not registering the marketplace; `syntaur install-plugin` (0.7.0+) writes that registration automatically. Then enable in `/plugin`, or rerun with `--enable`.
- **Skills missing from Claude Code after plugin install** — they live inside the plugin dir's `skills/` (mirrored from `<repo>/skills/` at install time). If the plugin is enabled, the skills auto-load. If you'd rather have them in `~/.claude/skills/` for a non-plugin install, run `syntaur install-plugin --skip-skills=false --force-skills`.
- **Same skill appears twice in Claude Code** — `syntaur doctor --only skills.dedup`. Either disable the plugin or remove the global copies via `syntaur uninstall-skills --claude`.
- **`npx syntaur` keeps asking to install globally** — choose "3) Never", or `export SYNTAUR_SKIP_INSTALL_PROMPT=1`.
- **Want to revert the global install to the published version** — `npm run untry` in the syntaur repo, which runs `npm unlink -g syntaur && npm install -g syntaur@latest`.

## Development

```bash
git clone git@github.com:prong-horn/syntaur.git
cd syntaur
npm install
npm run mirror-skills                     # populate platforms/<kind>/skills/ from <repo>/skills/
npm run build
npm run typecheck
npm test
npx vitest run src/__tests__/install-plugin-marketplace.test.ts
```

Skills live at `<repo>/skills/`. The `mirror-skills` script (also wired up as `prepack`) copies them into each platform plugin dir so plugin manifests' relative `./skills/<name>` paths resolve. Those mirrored copies are gitignored.

Repo-local plugin linking for development:

```bash
npx syntaur@latest install-plugin --link
npx syntaur@latest install-codex-plugin --link
```

## Release Publishing

This repo is set up for npm trusted publishing from GitHub Actions.

Release flow:

```bash
npm version patch
git push origin main
git push origin v$(node -p "require('./package.json').version")
```

The publish workflow lives at `.github/workflows/publish.yml` and only runs on version tags like `v0.1.4`. It checks that the tag matches `package.json`, runs the repo validation, and then publishes to npm using GitHub OIDC instead of a long-lived npm token.

One-time npm setup:

- package: `syntaur`
- GitHub repo: `prong-horn/syntaur`
- workflow filename: `publish.yml`

You can configure the trusted publisher either in the npm package settings UI or with npm CLI `11.10+`:

```bash
npx npm@^11.10.0 trust github syntaur --repo prong-horn/syntaur --file publish.yml -y
```

After trusted publishing is working, npm recommends switching the package publishing access to `Require two-factor authentication and disallow tokens`.
