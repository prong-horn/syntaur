# Syntaur Audit Report

**Date:** 2026-06-16  
**Scope:** Full codebase review (`src/`, `dashboard/src/`, CLI, server, TUI)  
**Auditor:** pi (Codex agent)

---

## 10 Bugs

| # | File | Bug | Impact | Suggested Fix |
|---|------|-----|--------|---------------|
| **1** | `src/dashboard/api-write.ts` (`extractFrontmatter`) | The regex `^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$` cannot parse YAML values containing colons, multi-line strings, nested fields, or quoted scalars. This causes `POST /api/projects` and `POST /api/projects/:slug/assignments` validation to reject or misread valid frontmatter. | Valid projects/assignments are rejected; values with colons are truncated | Replace the hand-rolled regex parser with the existing `parseAssignmentFrontmatter` or `extractFrontmatter` from `src/dashboard/parser.js`, which already handles quoted scalars and nested maps. |
| **2** | `src/dashboard/api-write.ts` (`setTopLevelField`) | The multiline regex `/^(${key}:)\s*.*$/m` matches the key at the start of **any** line in the file, not just inside frontmatter. If the markdown body contains a line like `archived: true` inside a code block, it gets corrupted on every patch. | Markdown body content is silently corrupted on edits | Anchor the regex to the frontmatter block only — match `---\n…\n---` and restrict key replacements to lines between the delimiters. |
| **3** | `src/utils/session-id.ts` (`resolveFromAncestorMarkers`) | When a runtime marker lacks `procStart`, the pid-reuse guard is skipped entirely. An old/stale marker file without that field is trusted even if the PID was recycled by a completely different process. | Wrong session resolution; can attach cleanup hooks to the wrong transcript | Fail closed: if a marker exists but `procStart` is absent, require a live `ps` match or fall through to the next layer rather than trusting the marker. |
| **4** | `src/dashboard/api-write.ts` (`handleWorktreeCreate`) | Uses `spawnSync` for multiple git preflight checks (`rev-parse`, `check-ref-format`, `rev-parse --verify`). These block the Node event loop, stalling all concurrent requests during worktree creation. | Server becomes unresponsive under concurrent load | Replace `spawnSync` with `async` `spawn` + Promise wrappers, or queue worktree creation on a worker thread / dedicated async queue. |
| **5** | `src/tui/launch.ts` (`buildAgentArgv`) | When `resolveFromShellAliases: true`, it launches `$SHELL -i -c '…'`. The `-i` (interactive) flag sources `.bashrc`/`.zshrc`, which can print unwanted output, run slow initialization, or fail entirely if the rc file has interactive-only commands. | Agent launch failures or garbled output | Use `-l` (login shell) instead of `-i`, or add a documented env var (`SYNTAUR_SHELL_NONINTERACTIVE=1`) that strips `-i`. |
| **6** | `src/dashboard/server.ts` (WebSocket) | `wss.on('connection', …)` accepts any connection with no origin check, authentication, or token validation. If the server binds to `0.0.0.0` on a shared network, anyone can connect and receive real-time project/assignment/session updates. | Information leakage; real-time data exposed to network neighbors | Add an `Origin` whitelist check, or require a short-lived token in the WS handshake query string derived from the server's PID start time. |
| **7** | `src/utils/git-worktree.ts` (`listWorktrees`) | Returns `[]` on **any** git failure (corrupted repo, permission denied, missing `.git`). Callers assume "no worktrees" and may recreate or overwrite existing state. | Data loss risk from hidden worktrees | Distinguish failure modes: throw on permission errors; return `null` (distinguishable from `[]`) when git is unavailable; log warnings for non-ENOENT failures. |
| **8** | `src/commands/ls.ts` (`runLs`) | Hardcodes `defaultProjectDir()` instead of reading the configured `defaultProjectDir` from `readConfig()`. If the user moved their projects directory, `ls` scans the wrong location and returns stale/empty results. | CLI inconsistency; broken for custom project roots | Replace the two hardcoded `defaultProjectDir()` calls with `(await readConfig()).defaultProjectDir`. |
| **9** | `dashboard/src/hooks/useWebSocket.ts` | `ws.onclose` always reconnects after 2 seconds regardless of the close code. A normal close (`1000`), policy violation (`1008`), or auth failure (`1008`) triggers an infinite reconnection loop. | Client battery/CPU drain; log spam | Check `event.code` inside `onclose`; only reconnect for `1001` (going away) or `1011` (server error). For `1000` or `1008`, stop retrying and surface an error toast. |
| **10** | `src/commands/doctor.ts` (`doctorCommand`) | When `~/.syntaur/` doesn't exist and `--json` is passed, it emits `{"version": "1.0", "error": "…"}` instead of the standard report shape with `summary` and `checks`. JSON consumers expecting the normal schema crash. | Breaks programmatic doctor parsers | Emit the full `DoctorReport` shape with `summary: { pass:0, warn:0, error:1, skipped:0 }` and a synthetic `checks` array containing the root-missing error. |

---

## 10 UX Improvements

| # | File / Feature | Issue | Suggested Fix |
|---|----------------|-------|---------------|
| **1** | `src/tui/App.tsx` (Browse TUI) | No on-screen keyboard hints. Users must discover that `j/k` navigate, `/` searches, `q` quits, and `→/←` expand/collapse by trial and error. | Render a persistent footer/status bar with `↑↓ j/k navigate  / search  Enter launch  q quit` |
| **2** | `dashboard/src/hooks/useToast.ts` | Only one toast exists at a time; critical errors auto-dismiss after 4s with no history or explicit "dismiss" affordance beyond clicking the toast itself. | Support toast stacking (max 3 visible); add a small `×` dismiss button; add a "Notification log" drawer reachable from the top bar. |
| **3** | `dashboard/src/components/QueryInput.tsx` | AQL syntax is powerful but opaque. The input shows inline errors but offers no contextual help, examples, or a quick-reference trigger. | Add a `?` button (or `Ctrl+Space` hotkey) that pops a compact, scrollable AQL syntax reference panel with examples. |
| **4** | `dashboard/src/components/ConfirmDialog.tsx` | During async operations, the confirm button simply says "Working…" with no spinner, progress indicator, or cancellation option. | Replace text with a loading spinner + active verb (e.g., "Archiving…"); disable the cancel button too so the state is unambiguous. |
| **5** | `src/utils/doctor/output-human.ts` | Plain text output with no colors, severity grouping, or visual weight. Errors, warnings, and passes are visually identical in long output. | Use `chalk`/shell colors; sort by severity (error → warn → pass); add `✓`/`⚠`/`✗` glyphs; highlight auto-fixable items. |
| **6** | `src/commands/ls.ts` (`renderTable`) | Titles are hard-truncated at 60 characters with no ellipsis strategy or way to see the full title. Long assignment titles become unreadable. | Add a `--no-truncate` flag; or auto-detect terminal width with `process.stdout.columns` and size columns dynamically. |
| **7** | `src/commands/schedule.ts` (`show` subcommand) | `schedule show <id>` dumps raw JSON with every field. Non-technical users cannot parse trigger state, limits, or attempt history at a glance. | Render a human-readable summary table (next fire, state, limits, recent events) by default; add `--json` for the raw dump. |
| **8** | `src/dashboard/api-write.ts` (`deleteWorkspace`) | When workspace delete returns `409 WorkspaceBlockedError`, the JSON payload includes `blockedBy` arrays but no suggested CLI commands or dashboard actions to resolve it. | Include a `resolution` field: `"Run 'syntaur workspace move' or enable cascade=true"` |
| **9** | `src/tui/launch.ts` (`launchAgent`) | After spawning the agent, there is zero feedback. If the terminal takes 5+ seconds to cold-start, users think nothing happened and may mash the key again. | Print `Launching <agent> in <terminal>…` before spawn; print `Launched (pid: N)` on success; print a clear error with remediation on failure. |
| **10** | `src/commands/status.ts` (`lineDiff`) | `status add/set/remove --dry-run` prints a plain `+`/`-` diff with no syntax highlighting or color. Large status blocks are hard to scan quickly. | Color `+` lines green, `-` lines red, and ` ` lines dim; use bold for changed keys; respect `NO_COLOR` env var. |

---

## Honorable Mentions (Near-Bugs / Edge Cases)

| # | File | Observation | Risk |
|---|------|-------------|------|
| **A** | `src/db/leases-db.ts` (`claimLease` sweep) | The CAS member-free subquery uses `ORDER BY granted_at DESC LIMIT 1` to pick the most recent expired lease. If a member was ever leased, expired, and then the lease row was manually deleted, an older expired lease's `member_gen` could mismatch the current generation and leave the member stuck in `leased`. | Low but non-zero; worth a targeted unit test. |
| **B** | `src/lifecycle/recompute.ts` (`acquireLock`) | The lockfile uses `open(path, 'wx')` for exclusivity, but on some networked filesystems (NFS, CIFS) or containers, `O_EXCL` is not reliably atomic. | Acceptable for single-host use; consider `flock` advisory locking as a secondary guard if multi-host support is ever planned. |
| **C** | `src/dashboard/server.ts` (`app.get('{*path}', …)`) | The SPA fallback handler catches `req.path.startsWith('/assets')` but the `express.static('/assets')` middleware above it already serves `/assets`. The check is harmless but redundant; if the static mount is removed in the future, the fallback would 404 asset requests instead of serving them. | Low; just a maintenance foot-gun. |
| **D** | `src/utils/config.ts` (`parseFrontmatter`) | The hand-rolled YAML parser inside `parseFrontmatter` does not handle YAML flow collections (`{a: b}`), literal blocks (`|`), or folded blocks (`>`). It happens to work for Syntaur's flat config, but any user who pastes a complex value will get silently corrupted data. | Medium; migrating to a real YAML parser (or `js-yaml`) would be safer. |

---

## Quick Wins (Low-Hanging Fruit)

1. **Bug #8** (`ls` hardcoded path) — one-line fix: replace `defaultProjectDir()` with `(await readConfig()).defaultProjectDir`.
2. **UX #1** (TUI keyboard hints) — add a 1-line `<Text dimColor>` footer to `src/tui/App.tsx`.
3. **Bug #10** (doctor JSON shape) — wrap the early-exit error in the standard `DoctorReport` envelope.
4. **UX #6** (`ls` truncation) — respect `process.stdout.columns` instead of the hard `60` limit.
5. **UX #9** (launch feedback) — add two `console.log` / `console.error` calls in `launchAgent`.

---

*End of report.*
