---
title: Plugin / Skills Split — Option 2
date: 2026-04-22
status: draft
---

# Plugin / Skills Split (Option 2)

Make `syntaur-skills` the single source of truth for protocol knowledge (skills) and shrink the `syntaur` npm package / Claude Code plugin / Codex adapter to platform-specific concerns only (slash commands, hooks, agents, CLI). Eliminate the duplicate-skill collision a user hits when installing both today.

## Goal

After this plan lands:

- `syntaur-skills` (github.com/prong-horn/syntaur-skills) ships the 6 agent-agnostic skills: `syntaur-protocol`, `grab-assignment`, `plan-assignment`, `complete-assignment`, `create-assignment`, `create-project`. It is the only place those skills live.
- `syntaur` npm package vendors a frozen copy of those skills via git submodule at `vendor/syntaur-skills/`. `syntaur setup` uses this vendored copy to install skills for the user's agent (Claude Code or Codex). No duplicates on disk.
- Claude Code slash commands (`/grab-assignment`, `/plan-assignment`, `/complete-assignment`, `/create-assignment`, `/create-project`) live in the `syntaur` plugin and are thin wrappers that invoke the corresponding skill via the Skill tool.
- Claude Code plugin still ships its platform-specific pieces: hooks, `syntaur-expert` agent, `/doctor-syntaur`, `/track-server`, `/track-session`.
- Codex adapter still ships its platform-specific pieces: `track-session` skill, `syntaur-operator` agent, `resolve-session.sh`, `hooks.json`.
- A user who runs `npx skills add prong-horn/syntaur-skills` in addition to installing the plugin ends up with the same single set of skills — no name collisions, no duplicate activation.

## Context

Today `syntaur/platforms/claude-code/skills/` and `syntaur/platforms/codex/skills/` both contain full copies of the protocol skills (5 and 6 respectively), and the standalone `syntaur-skills` repo has yet another copy. The Claude Code versions under `platforms/claude-code/skills/` additionally carry slash-command-style frontmatter (`argument-hint`, `allowed-tools`) while living in a `skills/` directory — a minor taxonomy bug that this plan resolves.

The standalone repo at `/Users/brennen/syntaur-skills` was refreshed on 2026-04-22 to protocol v2.0 + v0.3.x parity (commit `3f0b55f`), so content-wise it is the most up-to-date. This plan adopts it as the source of truth and deletes duplicates elsewhere.

## Non-goals

- No rewrite of skill content — the syntaur-skills versions are already current.
- No change to the protocol (v2.0 stays).
- No changes to `track-session` CLI / API semantics — only the Claude-Code-side slash command wrapper.
- No Cursor / OpenCode support changes.
- No landing-page screenshot refresh.

## Tasks

### 1. Add `syntaur-skills` as a git submodule under `vendor/`

Add `git@github.com:prong-horn/syntaur-skills.git` at `vendor/syntaur-skills`, pinned to the current `main` (commit `3f0b55f` or newer). Commit the `.gitmodules` entry. Document in README how to update (`git submodule update --remote --merge vendor/syntaur-skills`).

Reason for submodule over npm dep: skills are markdown, not JS; pinning by commit is simpler than versioning an npm package; users get the exact bytes we tested against.

### 2. Update `package.json` to include `vendor/syntaur-skills/skills/**` in `files`

So `npm publish` bundles the skills with the CLI. Add a `prepack` step that verifies the submodule is checked out (fail early if someone runs `npm publish` without initializing submodules).

### 3. Delete duplicated skills from the plugin

- Remove `platforms/claude-code/skills/{grab-assignment,plan-assignment,complete-assignment,create-assignment,syntaur-protocol}/`. Keep `platforms/claude-code/skills/` as an empty dir only if something else needs it; otherwise delete the dir entirely.
- Remove `platforms/codex/skills/{grab-assignment,plan-assignment,complete-assignment,create-assignment,syntaur-protocol}/`. Keep `platforms/codex/skills/track-session/` (Codex-specific).

Verify nothing in the plugin references these paths (grep for `platforms/claude-code/skills/` and `platforms/codex/skills/` under `src/` and `platforms/`).

### 4. Create Claude Code slash command wrappers

Under `platforms/claude-code/commands/`, add a directory per wrapper (`grab-assignment/`, `plan-assignment/`, `complete-assignment/`, `create-assignment/`, `create-project/`), each with `<name>.md`. Frontmatter uses the real slash-command schema (`name`, `description`, `arguments`, not `allowed-tools`). Body is ~5 lines:

```
Invoke the `grab-assignment` skill with the arguments below, then follow its instructions.

Arguments: $ARGUMENTS
```

Skill names used in the wrappers must match the `name:` field in the skills repo exactly. Grep confirms: `grab-assignment`, `plan-assignment`, `complete-assignment`, `create-assignment`, `create-project`, `syntaur-protocol` (no wrapper for `syntaur-protocol` — it's knowledge, not an action).

### 5. Install skills during `syntaur setup` — Claude Code path

In `src/commands/setup.ts` (or wherever the Claude Code branch lives), after plugin install, copy `vendor/syntaur-skills/skills/*` to `~/.claude/skills/`. Skip any target that already exists unless `--force`. Emit one line per installed skill.

Resolve the submodule path relative to the CLI's own install dir using `fileURLToPath(import.meta.url)` and walk up to the package root (same pattern used in `src/utils/paths.ts`).

### 6. Install skills during `syntaur setup` — Codex path

Same operation, different target: `~/.codex/skills/`. Do not touch `platforms/codex/skills/track-session/` — that stays part of the adapter and is handled by the existing `install-codex-plugin.ts` flow.

### 7. Add `syntaur uninstall-skills` (cleanup helper)

New CLI subcommand that removes the 6 protocol skills from `~/.claude/skills/` and/or `~/.codex/skills/` (by matching the `name:` field in each `SKILL.md` frontmatter against our known list, so we never delete a user-authored skill that happens to share a directory name). Flags: `--claude`, `--codex`, `--all` (default: prompt).

### 8. Update `install-plugin.ts` and `install-codex-plugin.ts` to call the skill installer

Chain: after plugin / adapter install succeeds, call the new skill installer from task 5/6. On uninstall, chain to `uninstall-skills` (with a prompt — user may have manually edited a skill).

### 9. Add integration test: fresh setup produces no duplicates

New test `src/__tests__/setup-skills-install.test.ts`:
- Creates a temp `~/.claude/` and `~/.codex/` inside `tmpdir()`.
- Runs the skill installer for each agent.
- Asserts each skill appears exactly once in the target dir.
- Re-runs the installer and asserts it's idempotent (no error, no double-copy).
- Runs with a pre-existing skill of the same name + different content, asserts it's preserved (not overwritten without `--force`).

### 10. Update `syntaur setup --cursor` / `--opencode` paths

These don't have skills today; leave as-is but document that they need manual `npx skills add prong-horn/syntaur-skills`. Add a note in the setup-adapter output for non-Claude / non-Codex frameworks.

### 11. Update READMEs and landing docs

- `syntaur` repo README: document the new layout (skills vendored via submodule, plugin = slash commands + hooks).
- `syntaur-skills` README: add a "Shipped with syntaur" section explaining that `syntaur setup` installs these automatically, manual `npx skills add` is only for non-Claude / non-Codex agents.
- `syntaur-landing/docs.html`: install section should say `npm install -g syntaur && syntaur setup` — skills come along. Drop any "also run `npx skills add`" language.

### 12. Version bump + release

- Bump `syntaur` package.json to `0.4.0` (breaking: plugin no longer ships protocol skills internally; users upgrading need the skill install step to run).
- Migration note for existing users: if they had the old `platforms/claude-code/skills/` symlinked into their plugin dir, Claude Code will just stop seeing those skills. `syntaur setup` on 0.4.0 will install the vendored copies to `~/.claude/skills/`. No data lost. Document this in CHANGELOG.
- Tag + push; CI publishes to npm.
- Tag `syntaur-skills` `v1.1.0` (matches the per-skill `metadata.version` bump already done on 2026-04-22) so the submodule pin is a stable reference.

## Verification

- `syntaur setup` on a clean `~/.claude/` installs 6 skills, zero duplicates.
- `syntaur setup` on a clean `~/.codex/` installs 6 skills, zero duplicates. The `track-session` skill stays as part of the Codex adapter (distinct dir).
- Installing the plugin and then running `npx skills add prong-horn/syntaur-skills` produces no duplicates (names match exactly; `npx skills add` refuses or overwrites — either is fine).
- Claude Code `/grab-assignment <project>` fires the skill and the skill runs to completion.
- Codex agent (no slash commands) still auto-activates `grab-assignment` on prompt "grab the X assignment".
- `syntaur uninstall` cleans up both plugin + skills.
- All existing tests pass; new idempotency test passes.

## Resolved decisions

- **Overwrite semantics (Q1):** don't rely on `npx skills add --force`. The installer in task 5/6 detects the three cases itself:
  1. Target absent → copy.
  2. Target present and byte-identical to vendored → no-op.
  3. Target present and differs → skip + warn. `--force-skills` on `syntaur setup` is the opt-in overwrite.
- **Submodule init (Q2):** end-user npm installs bundle the skill files directly via the `files` glob (task 2), so no runtime `git submodule update` ever happens from an installed package. For contributor clones, add a check in `npm run build` (or a `prepare` script) that runs `git submodule update --init --recursive` if `vendor/syntaur-skills/skills/` is missing. At runtime, `syntaur setup` asserts the directory exists and errors cleanly with "reinstall syntaur" if not.
- **`track-session` placement (Q3):** stays platform-specific. The Codex `track-session` skill keeps its current home at `platforms/codex/skills/track-session/` (it knows Codex rollout paths). The Claude Code slash command `/track-session` stays at `platforms/claude-code/commands/track-session/`. `syntaur-skills` does not ship a unified `track-session` — cross-platform branching in an agent-agnostic skill would violate the repo's purpose.
- **Submodule location (Q4):** `vendor/syntaur-skills/` inside the `syntaur` repo. `syntaur-skills` remains its own standalone GitHub repo with independent tags, issues, and the public `npx skills add prong-horn/syntaur-skills` install path. The submodule just lets the `syntaur` npm package vendor a known-good commit.

## Rollout order

1. Tasks 1–2 (submodule + packaging).
2. Tasks 5–6 (installer logic) with tests but skills still duplicated.
3. Task 9 (tests pass).
4. Task 3 (delete duplicates) — only after installer is proven.
5. Task 4 (slash command wrappers).
6. Tasks 7–8 (uninstall + chain).
7. Tasks 10–11 (docs).
8. Task 12 (release).
