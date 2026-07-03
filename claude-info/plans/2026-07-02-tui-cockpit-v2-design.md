# Syntaur TUI Cockpit v2 — Design Spec

- **Date:** 2026-07-02
- **Status:** Draft (pending user review)
- **Assignment:** `syntaur-meta/tui-cockpit-v2`
- **Predecessor:** `claude-info/plans/2026-07-01-syntaur-tui-cockpit-design.md` (v1, shipped as PR #24)

## 1. Summary

Cockpit v1 shipped solid plumbing — SGR mouse parsing/hit-testing, tmux launch/attach with careful terminal-state handling, session liveness, all unit-tested — but an unusable presentation. v2 keeps the plumbing and rebuilds everything the user sees, plus one launch-path change: **Claude-based agents launch and attach via Claude Code's native background-agent system** (`claude --bg` / `claude agents --json` / `claude attach`, verified on v2.1.200) instead of the hand-rolled tmux path, which remains for non-Claude agents and as fallback.

The cockpit's one job: answer **"what are my agents doing, and which one needs me?"** — then let the user act (attach, launch) in one click.

## 2. Diagnosis of v1 (why this rebuild)

1. **Raw JSONL transcript dump.** `DetailPane` tails the transcript file verbatim. Claude JSONL is hook dumps, base64 signatures, one-line JSON blobs — negative information occupying 90% of the screen. "Pretty-printing" was deferred as polish; it is actually the core monitoring feature.
2. **Sessions labeled by UUID.** Rail rows render `claude 7ee52a51` although the session record carries `projectSlug`, `assignmentSlug`, `description`, `activity`.
3. **No curation.** Every session ever recorded is listed (feed.ts's `liveOnly()` exists, unused); dozens of dead rows bury the live ones and push the Projects tree off-screen — permanently, because nothing scrolls.
4. **No scrolling or clipping.** Wheel events are parsed but never consumed; long lines wrap (no `wrap` control), breaking pane layout and the one-row-per-item math mouse hit-testing depends on.
5. **Mouse architecture dictated aesthetics.** Hit rects are hand-computed in `layout.ts`, decoupled from what Ink renders, so any chrome (a border = 1-cell inset) desyncs clicks — chrome was banned instead of insetting the rects. Result: no panel separation, no title bars, no selected-row highlight.
6. **Inconsistent interaction.** Mouse works on the session list + action bar but not the tree; Tab toggles a "focus" whose only cue is a header color.

## 3. Goals / Non-goals

### Goals (v2)
- Transcript pane renders **parsed, readable turns** — never raw JSON.
- Session rows labeled by **work, not UUID**, with attention states surfaced (`waiting: permission prompt`).
- **Scroll + clip everywhere** (wheel, PgUp/PgDn, j/k); Projects tree always reachable.
- **Panel chrome**: bordered panes with title bars, inset-aware hit rects, visible buttons, selected-row highlight.
- **One interaction model**: everything clickable is keyboardable and vice versa, tree included.
- **Native Claude background agents** for launch/monitor/attach when the agent is Claude and the installed CLI supports it; tmux retained otherwise.

### Non-goals (unchanged from v1)
- In-TUI editing of assignments/plans; dashboard feature parity; dependency graphs; multi-transcript grid.
- Rich rendering for every agent format on day one — Claude JSONL first; codex/pi parsers can follow behind the same interface (fallback below applies meanwhile).

## 4. What stays (reuse map)

| Layer | Status |
| --- | --- |
| `mouse/parse.ts`, `mouse/registry.ts`, `mouse/tracking.ts`, `MouseContext` | unchanged (wheel events finally get a consumer) |
| `tmux/launch.ts`, `tmux/attach.ts` | unchanged; now the non-Claude / fallback path |
| `sessions/feed.ts` + `dashboard/session-liveness` | kept; **enriched** with `claude agents --json` data |
| `sessions/transcript.ts` (tailFile) | kept as the byte-level tail; renderer consumes it |
| `buildLaunchPlan` / `launch.ts` argv+prompt machinery | kept; `--bg` path reuses prompt + cwd resolution |
| `layout.ts` | extended: frame rect vs. 1-cell-inset content rect |
| Suspend/mouse-re-arm wrappers in `Cockpit.tsx` | reused verbatim for `claude attach` |

## 5. Design

### 5.1 Transcript renderer (`src/tui/transcript-render/`)

Per-agent parsers behind one interface:

```ts
interface TranscriptRenderer {
  /** Feed raw JSONL lines (from tailFile); returns display rows to append. */
  push(lines: string[]): DisplayRow[];
}
type DisplayRow = { text: string; style: 'user' | 'assistant' | 'tool' | 'meta' | 'error' };
```

- **`claude.ts`** parses Claude Code JSONL events:
  - user message → `❯ <prompt text>` (bold), truncated to a few rows
  - assistant text → wrapped paragraph rows (readable, the only wrapped content)
  - `tool_use` → one-liner `⏺ Bash: npm test` / `⏺ Edit: DetailPane.tsx` (name + salient input field)
  - `tool_result` → collapsed: first line + `(+N lines)`, dim
  - dropped entirely: thinking blocks, signatures, hook attachments/system reminders, sidechain (`isSidechain: true`) events, token/meta noise
- **`fallback.ts`**: for unknown formats, scan tail for the last N assistant/text-bearing events; if nothing parseable, show `(unsupported transcript format — attach to view)`. Never raw JSON.
- **Now-line derivation:** the renderer also exposes `lastActivity(): string | null` — e.g. `editing DetailPane.tsx`, `running npm test`, `responding…` — consumed by the session rail row.

Parsers are pure (lines in → rows out) and unit-tested against fixture JSONL captured from real sessions.

### 5.2 Session rail

Row format (truncated to rail width):

```
▸ LIVE (3)
  ● claude  tui-cockpit-v2      editing DetailPane.tsx   2m
  ◐ claude  fitsync/api-auth    ⚠ permission prompt      8m
  ● codex   yt-research         running tests            1m
▸ RECENT (38)          ← collapsed by default, capped list when expanded
```

- **Label resolution:** `assignmentSlug` → `projectSlug/assignmentSlug` → `description` → basename of session `path`/`cwd`. Never a bare UUID.
- **Attention state:** sessions whose native state is `waiting`/`blocked` render `⚠ <waitingFor>` in yellow and sort to the top of LIVE. This is the headline signal.
- **Sorting:** waiting → working (by recency) → idle; RECENT collapsed group holds dead sessions (click/Enter to expand, capped at ~20 with `…and N more`).
- **Selected row:** inverse-video highlight; keyboard ↑/↓ moves it; click sets it. Same selection model as the tree.

### 5.3 Scrolling + clipping (`src/tui/mouse/scroll.ts` + hook)

- `useViewport(regionId, contentLength, viewHeight)` → `{ offset, onWheel, keys }`; wheel events routed by the existing registry to the region under the cursor; PgUp/PgDn/j/k apply to the focused pane.
- All list-like panes (rail, tree, transcript) render `content.slice(offset, offset + viewHeight)`.
- Single-row items render with `wrap="truncate"` so one item = one row, guaranteed — restoring the invariant hit-testing needs. Only assistant transcript paragraphs pre-wrap **at parse time** into multiple explicit rows (so row math still holds).
- Scroll position indicator (`▲ 12 more` / `▼ 84 more`) in the pane title or last row, dim.
- Transcript pane auto-follows the tail unless the user has scrolled up; any new-content jump is suppressed until they hit End/scroll to bottom (standard log-viewer behavior).

### 5.4 Panel chrome (mouse-safe)

- `layout.ts` produces per-pane `{ frame: Rect, content: Rect }` where `content = inset(frame, 1)`. Ink renders `borderStyle="round"` boxes sized to `frame`; mouse regions register `content`. One inset function, unit-tested, replaces the "no borders ever" rule.
- Pane title in the border row (`─ Sessions ─`), colored when the pane has focus — focus is now structurally visible.
- Action bar: buttons rendered as inverse-video chips (` Launch ` ` Attach ` ` Quit `) with their key hints; disabled = dim, no inverse.
- Status line (launch/attach outcomes) gets a fixed row above the action bar instead of hijacking the Detail title.

### 5.5 One interaction model

- Tree rows become clickable using the same row hit-testing the session list uses (click = select; click on the `▸/▾` glyph = expand/collapse — no double-click machinery). The `useMouseRegions` + `resolveRowIndex` machinery already supports this; v1 just never wired it.
- Keyboard parity table maintained in one place (`keymap.ts`) and rendered as hints in the action bar.
- Tab still cycles focus (rail → tree → detail), but focus is visible via title-bar color + the focused pane consumes PgUp/PgDn/j/k.

### 5.6 Native Claude background agents (launch / monitor / attach)

Verified against Claude Code v2.1.200 (background sessions require ≥ 2.1.139):

- **Capability detection** at startup (like tmux detect): run `claude agents --json`; success ⇒ native path available. Failure/old version ⇒ tmux path for everything, exactly as today.
- **Launch (Claude agents):** `claude --bg --name "<project>/<assignment>" "<launch prompt>"` spawned with `cwd` = resolved worktree. Reuses `buildLaunchPlan`'s cwd/context.json/prompt resolution; only the spawn differs (no tmux window). The supervisor daemon hosts the session; the cockpit stays resident. The session appears in Syntaur's session-db via the existing track-session hook, and in `claude agents --json` immediately.
- **Monitor:** the feed polls `claude agents --json` alongside session-db and joins on `sessionId`. Native fields override derived ones when present: `state` (working/blocked/done/failed/stopped), `status` (idle/busy/waiting), `waitingFor`. This upgrades liveness from pid-guessing to supervisor truth and powers the ⚠ attention rows.
- **Attach (Claude sessions):** `claude attach <shortId>` wrapped in the existing `runWithMouseSuspended` + `suspendTerminal` sandwich (identical to tmux attach). Detach (`←`/`/exit`/Ctrl+Z in the child) returns to the cockpit. Works with **no tmux installed at all**.
- **Non-Claude agents (codex, pi, …):** unchanged tmux launch/attach.
- **Coexistence:** a session launched via tmux (or pre-v2) still monitors/attaches through the tmux path; the join simply won't find it in `claude agents --json` with a short id. Launcher choice is per-session, recorded in the feed row.

## 6. Data flow

1. Poll loop (unchanged 1.5s cadence): `loadSessions()` = session-db + liveness **+ `claude agents --json` join**.
2. Selecting a session: `tailFile(transcriptPath)` → `TranscriptRenderer.push()` → viewport-sliced styled rows. Same pipeline for `--bg` sessions — their transcripts land in the same `~/.claude/projects/<munged-cwd>/<sessionId>.jsonl` format.
3. Selecting an assignment: unchanged `AssignmentView` (kept, with chrome + scrolling).
4. Actions: context-sensitive per selection; Launch picks native vs. tmux by agent kind + capability; Attach picks `claude attach` vs. `tmux attach` by how the session is reachable.

## 7. Error handling & edge cases

- **`claude agents --json` fails mid-flight** (daemon restart, CLI upgrade): keep last-known native states for ≤1 poll, then degrade rows to session-db liveness; never crash the poll loop.
- **`--bg` launch fails** (old CLI, missing prompt): surface in status line, fall back to tmux path if available, else hand-off (current behavior).
- **JSONL parse errors / format drift** (transcript format is internal, not guaranteed stable): renderer treats unparseable lines as skippable, counts them, and if >50% of the tail is unparseable flips to the fallback renderer. A format change can never bring back the wall-of-JSON.
- **Attach to a dead-but-listed session:** native `state` gates the Attach action (only live states `working`/`blocked`); tmux path keeps its `tmuxSessionExists` gate.
- **Tiny terminals:** single-column layout keeps borders; below ~50 cols drop borders (chrome, not correctness) — inset function returns frame unchanged and hit rects follow automatically.
- **Terminal-state safety:** unchanged v1 guarantees (mouse re-arm in `finally`, alternate-screen restore on crash/exit).

## 8. Testing strategy

- **Transcript parsers:** fixture JSONL files (real captured sessions: claude, codex, malformed) → assert styled rows + `lastActivity`. Pure, no terminal.
- **Viewport/scroll:** pure hook logic — offsets, follow-tail, clamping.
- **Inset/layout:** rect arithmetic unit tests (frame vs. content, tiny-terminal degradation).
- **Native-agents feed:** `claude agents --json` behind a `execFn` seam (mirrors tmux tests) — fixture JSON → assert join, state precedence, degradation on error.
- **Launch dispatch:** assert exact `claude --bg` argv (name, prompt, cwd) without spawning; same pattern as existing tmux argv tests.
- **Component smoke:** ink-testing-library renders with mocked feed — selected-row highlight, collapsed RECENT group, ⚠ row ordering, action enable/disable.
- Existing v1 tests for mouse parse/registry/tmux keep passing untouched.

## 9. Acceptance criteria

Mirror of `assignment.md`:

1. Transcript pane renders parsed readable turns for Claude JSONL; unknown formats fall back to last assistant messages — never raw JSON.
2. Session rows human-labeled with activity + recency; selected row highlighted; waiting sessions surfaced with ⚠ and sorted first; dead sessions collapsed behind RECENT.
3. Every pane scrolls (wheel + keys) and clips; Projects tree reachable regardless of session count.
4. Bordered panes with title bars; hit rects account for insets; visible action buttons.
5. Mouse/keyboard parity everywhere, tree included.
6. Claude agents launch via `claude --bg`, monitored via `claude agents --json` join (state/waitingFor surfaced), attached via `claude attach` — with tmux fallback for non-Claude agents and older CLIs.

## 10. Risks / open questions

- **Transcript + `agents --json` formats are internal** (docs say structure not guaranteed). Mitigated by fixture-driven parsers, the >50%-unparseable fallback flip, and feed degradation to session-db liveness.
- **`--bg` sessions inherit directory permission settings** — a restrictive dir means sessions park at `waiting: permission prompt`. That's desired visibility (⚠ row), but launch UX may later want a permission-mode override flag.
- **Assistant-paragraph pre-wrapping** must re-wrap on terminal resize (row cache keyed by pane width).
- **Peek without attach** (`claude logs <id>`) overlaps with our transcript tail; not used in v2 (our renderer is richer), noted for future.
