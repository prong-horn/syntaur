# Claude Code statusLine for the syntaur plugin (lite)

**Goal:** Ship a `statusLine` in the syntaur Claude Code plugin that renders
`<branch> · <worktree-tail> · <assignment> · <sessionId>` whenever a Claude
Code session is active. Lives under `platforms/claude-code/`; ships
automatically via `syntaur install-plugin` (the installer recursively copies
the whole plugin tree, no allowlist).

## Files

### CREATE: `platforms/claude-code/hooks/statusline.sh`
- `#!/usr/bin/env bash` + `set -o pipefail 2>/dev/null || true`.
- `command -v jq >/dev/null 2>&1` guard — if missing, emit a degraded line
  (e.g. `(syntaur: jq missing)`) and `exit 0`.
- `INPUT=$(cat)` once; extract `session_id`, `cwd`, `workspace.current_dir`
  with `jq -r '.field // empty'`.
- Resolve git state against `CWD`:
  - `BRANCH=$(git -C "$CWD" rev-parse --abbrev-ref HEAD 2>/dev/null)`
  - If `BRANCH == HEAD` or empty, fall back to `git rev-parse --short HEAD`.
  - `WORKTREE=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null)` — use
    its basename only (short form).
- Resolve active assignment:
  - Read `$CWD/.syntaur/context.json` (if present) with `jq -r` for
    `projectSlug`, `assignmentSlug`, `assignmentDir`.
  - If `assignmentDir` is populated, cheap-read title from `$ASSIGNMENT_DIR/assignment.md`
    with `awk '/^title:/{sub(/^title: *"?/,""); sub(/"?$/,""); print; exit}'`.
  - Format:
    - Project-nested: `projectSlug/assignmentSlug — title`
    - Standalone (projectSlug null/empty): `standalone/<uuid-prefix> — title`
      (take first 8 chars of `assignmentSlug` for terseness).
    - None: emit nothing for the assignment segment.
- Format session id: take last 8 characters of `session_id` (full UUIDs are
  noisy; prefix is enough to disambiguate).
- Emit a single line. Always `exit 0` — never fail the terminal.
- Join segments with ` · ` and suppress empty segments gracefully.

### MODIFY: `platforms/claude-code/.claude-plugin/plugin.json`
- Add top-level `statusLine` block:
  ```json
  "statusLine": {
    "type": "command",
    "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/statusline.sh"
  }
  ```
- Use `${CLAUDE_PLUGIN_ROOT}` per the existing convention in `hooks/hooks.json`.

### CREATE: `src/__tests__/hook-statusline.test.ts`
- Mirror `src/__tests__/hook-session-start.test.ts` structure.
- `beforeEach`: `mkdtemp` sandbox, `git init`, `git commit --allow-empty -m init`,
  optionally create `.syntaur/context.json` inside the sandbox with known
  projectSlug/assignmentSlug + assignmentDir pointing at a fixture
  `assignment.md` with `title: "Demo Assignment"`.
- Cases:
  1. Non-git cwd, no context.json → outputs only sessionId suffix (suppressing
     branch/worktree/assignment gracefully).
  2. Git cwd, no context.json → outputs branch + worktree basename + sessionId.
  3. Git cwd, project-nested context.json → outputs all 4 parts, assignment
     segment = `projectSlug/assignmentSlug — Demo Assignment`.
  4. Git cwd, standalone context.json (`projectSlug: null`,
     `assignmentSlug: <uuid>`) → `standalone/<prefix> — <title>`.
  5. jq missing: PATH stripped so `command -v jq` fails → degraded output,
     still `exit 0`.
- Spawn with `spawnSync('bash', [hookPath], { input: JSON.stringify({...}) })`.
- Assert `res.status === 0` on every case.

### CREATE: `src/__tests__/fixtures/statusline-assignment.md` (if needed)
- Small frontmatter-only fixture with `title: "Demo Assignment"` used by the
  standalone + project-nested cases. May inline the fixture in the test file
  instead (simpler — write assignment.md into the sandbox in `beforeEach`).
  Go with inline to avoid a second file.

## Validation

- `npx vitest run src/__tests__/hook-statusline.test.ts` — all 5 cases green.
- `npx vitest run` — full suite still green.
- `npm run build` — backend build clean (no new code paths touched in src/).
- Manual: source the installed plugin (via `syntaur install-plugin --link` or
  restart Claude Code after a normal install); verify the bar renders with
  branch + session id when opened in a syntaur worktree.

## Out of scope
- README update in `platforms/claude-code/README.md` (caller didn't request).
- Adding the dashboard port / agent model / transcript path to the line.
- Color or unicode icons — keep it plain ASCII for maximum terminal
  compatibility.
