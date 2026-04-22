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
| `~/.claude/skills/<skill>/` | Protocol skills (six of them) | `syntaur install-plugin` copies from the vendored `syntaur-skills` |
| `~/.codex/plugins/syntaur/` (or chosen dir) | Codex plugin directory (`track-session` skill, hooks) | `syntaur install-codex-plugin` |
| `~/.codex/skills/<skill>/` | Protocol skills (same six) | `syntaur install-codex-plugin` copies from the vendored `syntaur-skills` |
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

The six protocol skills (`syntaur-protocol`, `grab-assignment`, `plan-assignment`, `complete-assignment`, `create-assignment`, `create-project`) are maintained in a separate agent-agnostic repo — [`prong-horn/syntaur-skills`](https://github.com/prong-horn/syntaur-skills) — and vendored into this repo as a git submodule at `vendor/syntaur-skills/`.

`syntaur install-plugin` and `syntaur install-codex-plugin` automatically copy them into `~/.claude/skills/` or `~/.codex/skills/`. Per-skill copy behavior:

- **Target absent** → skill is installed.
- **Target matches the vendored version byte-for-byte** → no-op.
- **Target differs (you edited it)** → skill is preserved and you get a warning. Pass `--force-skills` to overwrite.

To manage the skills without touching the plugin:

```bash
syntaur install-plugin --skip-skills         # install plugin, leave ~/.claude/skills alone
syntaur install-plugin --force-skills        # overwrite any user-edited skills
syntaur uninstall-skills --all               # remove the 6 skills from both dirs
syntaur uninstall-skills --claude            # only ~/.claude/skills
syntaur uninstall-skills --codex             # only ~/.codex/skills
```

`uninstall-skills` is safe: it only removes a skill directory if its `SKILL.md` `name:` field matches one of the six protocol skills we ship. A user-authored skill that happens to share a directory name is left alone.

For non-Claude, non-Codex agents (Cursor, OpenCode, etc.), install the skills directly from the standalone repo:

```bash
npx skills add prong-horn/syntaur-skills
```

Installing both the `syntaur` plugin AND `npx skills add prong-horn/syntaur-skills` on the same machine is safe — the names match exactly, and per-file detection prevents double-install.

---

## Upgrade

| Install style | Command |
|---|---|
| Global | `npm install -g syntaur@latest` |
| npx | Nothing to do — `npx syntaur@latest ...` always consults the registry. To force a refetch: `rm -rf ~/.npm/_npx` |
| Mixed | `syntaur` (global) stays pinned; `npx syntaur@latest` uses whatever's live. The CLI will prompt to upgrade the global install when the npx version is newer. |

When you upgrade, the vendored skills under `~/.claude/skills/` and `~/.codex/skills/` are NOT automatically re-copied. Run `syntaur install-plugin` / `syntaur install-codex-plugin` again to refresh them (it'll skip any you've edited unless you pass `--force-skills`).

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
- **Plugin installed but Claude Code doesn't see slash commands** — re-run `syntaur install-plugin` and restart Claude Code. Check `~/.claude/plugins/marketplaces/` has a `user-plugins` (or equivalent) marketplace entry.
- **Skills missing in Claude Code after plugin install** — verify `ls ~/.claude/skills/` shows the six protocol skills. If empty, re-run `syntaur install-plugin --force-skills`.
- **`npx syntaur` keeps asking to install globally** — choose "3) Never", or `export SYNTAUR_SKIP_INSTALL_PROMPT=1`.
- **Want to revert the global install to the published version** — `npm run untry` in the syntaur repo, which runs `npm unlink -g syntaur && npm install -g syntaur@latest`.

## Development

```bash
git clone git@github.com:prong-horn/syntaur.git
cd syntaur
git submodule update --init --recursive  # clones vendor/syntaur-skills
npm install                               # postinstall hook re-runs submodule init if needed
npm run typecheck
npm test
npx vitest run src/__tests__/adapter-templates.test.ts
```

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
