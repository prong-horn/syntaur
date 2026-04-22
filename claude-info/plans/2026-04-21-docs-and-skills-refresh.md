# Docs + Skills Refresh for v0.3.2

**Date:** 2026-04-21
**Scope:** Catch the public-facing docs and plugin skills up to everything that's
landed since v0.2.0 — the mission→project rename, v0.3.x session-id integrity,
transcript_path tracking, and the fs-migration safety net.

## Why

- Landing page `docs.html` (`~/syntaur-landing/docs.html`) and `index.html`
  still use pre-v0.2.0 "mission" terminology — commands, paths, JSON examples,
  frontmatter fields. A new user reading the published docs will type
  `syntaur create-mission` and hit a dead command.
- `track-session` reference in docs is missing `--session-id` and
  `--transcript-path` flags that are now required / recommended.
- `.syntaur/context.json` example still says `missionSlug`, `missionDir`.
- No mention of standalone assignments, comments, progress, workspaces,
  agent sessions, playbooks — all shipped in v0.2.0 / v0.3.x.
- Plugin skills are clean for the `mission` → `project` rename (v0.2.0
  already touched them), but need a final sweep for v0.3.x features:
  create-assignment should document `--one-off` and `--type`, syntaur-protocol
  should reflect current state, plan-assignment's `## Todos` superseding
  pattern should be explicit, complete-assignment should reference the
  SessionEnd hook + transcript path.

## Out of scope

- Unrelated WIP changes already in the landing working tree
  (`main.ts`, `shared.ts`, `style.css`, `tailwind.config.ts`,
  `vite.config.ts`, `index.html` sections unrelated to mission terminology).
  Touch only what this refresh needs.
- Writing brand-new marketing copy. Update existing copy to accuracy; don't
  rewrite the landing page.
- Screenshot updates — mentioned in references/ but not in scope.

## Plan

### Landing page (`/Users/brennen/syntaur-landing`)

1. **`docs.html` rename pass** — replace every occurrence of mission→project
   terminology in user-facing text, code blocks, tables, and JSON examples:
   - `syntaur create-mission` → `syntaur create-project`
   - `--mission <slug>` → `--project <slug>`
   - `~/.syntaur/missions/` → `~/.syntaur/projects/`
   - `mission.md` → `project.md`
   - `Missions` / `mission` in prose → `Projects` / `project`
   - `missionSlug`, `missionDir` fields in the context.json example →
     `projectSlug`, `projectDir`
   - Remove references to per-project `agent.md` / `claude.md` (removed in
     v0.2.0; repo-level CLAUDE.md / AGENTS.md + `~/.syntaur/playbooks/` fill
     that role). Replace with a brief note that legacy files are tolerated.
2. **`docs.html` CLI reference refresh** — update the commands table:
   - `syntaur track-session` signature now includes `--session-id <real-id>`
     (required) and `--transcript-path <path>` (optional). Add a line of prose
     explaining session_id must come from the agent runtime.
   - Add `syntaur init` if missing, `syntaur comment`, `syntaur request` if
     missing.
   - Add `--one-off` as a flag on `create-assignment` with a short note
     pointing to standalone assignments.
3. **`docs.html` file-structure + assignment-files pages** — refresh to show:
   - `~/.syntaur/projects/<slug>/` (not missions)
   - Assignment companion files: `progress.md`, `comments.md`, `plan.md`,
     `scratchpad.md`, `handoff.md`, `decision-record.md`.
   - `## Todos` section in `assignment.md` with the "supersede prior plan
     todo" pattern.
4. **`docs.html` context.json page** — rewrite the example to reflect the
   v0.3.x shape: `projectSlug`, `projectDir`, `assignmentSlug`,
   `assignmentDir`, `workspaceRoot`, `title`, `branch`, `grabbedAt`,
   `sessionId` (real), `transcriptPath`.
5. **Add a short "Agent Sessions" callout** somewhere discoverable (probably
   on `dashboard` or `claude-code-plugin` page): explains that sessions are
   tracked in `~/.syntaur/syntaur.db`, keyed on real agent session IDs, and
   link back to raw transcripts.
6. **`index.html` marketing copy** — mission → project in prose only. Leave
   unrelated WIP alone. 14 occurrences to handle.
7. **`download.html`** — verify no stale command examples; update if needed.

### Plugin skills (`platforms/claude-code/skills`, `platforms/codex/skills`)

`mission` terminology was already cleaned by v0.2.0 — verified by grep. The
remaining gaps are v0.3.x feature documentation:

1. **`create-assignment/SKILL.md` (both platforms)** — ensure the skill
   documents:
   - `--one-off` for standalone assignments (no project).
   - `--type <feature|bug|refactor|research|chore>` for classification.
   - Where standalone assignments live (`~/.syntaur/assignments/<uuid>/`).
2. **`plan-assignment/SKILL.md` (both)** — ensure the plan-todos-supersede
   pattern is explicit:
   - Pick next unused `plan-v<N>.md` filename.
   - Append a linked todo in `## Todos`.
   - Mark any prior active plan todo as superseded
     (`- [x] ~~Execute [old plan](./plan.md)~~ (superseded by plan-v<N>)`).
   - Never delete superseded todos.
3. **`complete-assignment/SKILL.md` (both)** — verify:
   - Handoff section is present.
   - Decision-record usage is referenced.
   - The SessionEnd hook auto-marks the session as stopped; the skill should
     note that `/track-session` or grab-assignment is what registered it.
4. **`syntaur-protocol/SKILL.md` (both)** — single-page protocol reference.
   Sanity-check that it mentions:
   - Projects (not missions).
   - Standalone assignments at `~/.syntaur/assignments/<uuid>/`.
   - Comments, progress as separate append-only files.
   - Decision records.
   - Workspaces (optional field in project.md).
   - Real agent session IDs (no synthetic UUIDs).
5. **`platforms/{claude-code,codex}/references/protocol-summary.md`** —
   quick-reference card. Same sanity check as #4.
6. **`platforms/{claude-code,codex}/references/file-ownership.md`** —
   ownership table (who writes what). Sanity-check for v0.3.x file set:
   `project.md`, `assignment.md`, `plan*.md`, `progress.md`, `comments.md`,
   `scratchpad.md`, `handoff.md`, `decision-record.md`, `_status.md`
   (derived), indexes.

### Verification + release

1. `cd /Users/brennen/syntaur-landing && npm run build` — confirm landing
   still builds.
2. `grep -iE "mission" docs.html index.html` on the landing repo — should
   report zero matches in public text (code comments, image filenames may
   remain).
3. From the main syntaur repo: `grep -iE "mission|Mission" platforms/**/*.md` —
   should remain zero (it already is).
4. Commit both repos separately; push.

## Out-of-band work reserved for a future pass

- Image/screenshot updates (the `bg-*.png`, `docs-*.png` files reference old
  UI state).
- A proper CHANGELOG.md on the main repo mapping v0.1 → v0.2 → v0.3.x.
- New docs pages for playbooks and workspaces if discoverability is poor
  after this pass.
