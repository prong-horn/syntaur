# Syntaur Agent Cockpit — Design Spec

- **Date:** 2026-07-01
- **Status:** Approved design (pre-implementation)
- **Topic:** Full mouse-driven fullscreen TUI ("agent cockpit") for Syntaur

## 1. Summary

Build a resident, fullscreen terminal UI for Syntaur — an **agent cockpit** — that lets a user browse projects/assignments, launch agents, and **monitor and attach to live agent sessions** without leaving the terminal. It mirrors the interaction quality of Claude Code's fullscreen TUI (alternate-screen rendering + mouse support), and is built on the Ink/React stack Syntaur already uses.

This is **not** a terminal-native clone of the web dashboard. It is a focused cockpit for the `browse → launch → monitor → attach` loop, which is the workflow a terminal is uniquely good at.

## 2. Goals / Non-goals

### Goals (v1)
- Fullscreen resident TUI invoked as **`syntaur tui`**.
- Mouse support: click to select/expand/collapse, click action buttons, scroll panes.
- Browse projects → assignments in a tree (reusing existing `browse` components).
- Read assignment detail (status, acceptance criteria, plan, recent progress, workspace).
- Live session monitoring: which agents are running, liveness, assignment binding, and a live transcript tail.
- Launch an agent for an assignment into a **tmux** window (with graceful fallback when tmux is absent).
- Attach to / detach from a running session via tmux.
- Keyboard-first parity: everything doable by keyboard; mouse is additive.

### Non-goals (deferred beyond v1)
- In-TUI editing of assignments/plans/progress.
- Dashboard feature parity (inbox, memories, resources, settings, saved views).
- Graph / dependency visualizations.
- Multi-session transcript grid (watching N transcripts at once).
- Rich agent-specific transcript pretty-printing (v1 renders a generic tail).

## 3. Framework decisions & rationale

- **Stay on Ink (React for the terminal).** Syntaur already ships an Ink TUI (`ink@6.8.0`, `react@19`, `ink-text-input`) in `src/tui/`, and Claude Code itself is Ink. No framework change.
- **Reject OpenTUI** despite its nicer built-in mouse/`ScrollBox`/`Diff`: its native Zig renderer requires **Bun or Node 26.3+ with `--experimental-ffi`**, a non-starter for an npm-distributed, `npm-link`ed CLI, and it would mean rewriting existing Ink code for zero framework payoff.
- **Bump Ink `6.8` → `7`.** Concrete, justified reasons:
  - **Alternate-screen rendering** (second screen buffer, restored on exit) — the fullscreen / flat-memory foundation, equivalent to Claude Code's "no-flicker" mode.
  - **`useBoxMetrics`** — measure a component's rect at runtime; the backbone of mouse hit-testing.
  - **`useWindowSize`** — responsive layout that re-renders on terminal resize.
  - Improved keyboard input handling (`key.escape` vs `key.meta`, backspace/delete disambiguation).
- **Mouse is code we own**, not a dependency. Neither Ink 6.8 nor Ink 7 provides native mouse. `ink-mouse` demonstrates the right approach (ref-based hit regions) but was **archived May 2026** with real gaps (no right/middle click, elements not at origin, Windows CMD). We vendor a small, tested mouse layer inspired by its ref model.

## 4. Reuse map (what already exists)

| Need | Reuse |
| --- | --- |
| Project/assignment data | `src/dashboard/api.ts` (`listProjects`, `getProjectDetail`, `getAssignmentDetail`, board queries) |
| Markdown parsing | `src/dashboard/parser.ts` |
| Shared types | `src/dashboard/types.ts` (`AssignmentBoardItem`, `ProjectSummary`, `AgentSession`, …) |
| Tree UI | `src/tui/components/TreeView.tsx`, `TreeItem.tsx`, hooks `useProjects`, `useTreeState`, `useSearch` |
| Status colors | `src/tui/colors.ts` |
| Agent argv + prompt + context.json | `src/tui/launch.ts` (`buildAgentArgv`, `resolveLaunchPrompt`, context marker) |
| Session state / liveness | `src/dashboard/session-db.ts` (`sessions`: `status`, `pid`, `pid_started_at`, `activity`, `transcript_path`) + `engagement` edge (session↔assignment) |
| File watching | `chokidar` (already a dependency) |

## 5. Architecture

```
src/commands/tui.ts            # command registration + bootstrap (parallels browse.ts)
src/tui/
  cockpit/
    Cockpit.tsx                # app shell: layout, focus/routing, global keymap
    LeftRail.tsx               # live-sessions list + project/assignment tree
    DetailPane.tsx             # assignment detail | focused-session transcript tail
    StatusBar.tsx              # keybinding hints + clickable action buttons
    layout.ts                  # responsive breakpoints (via useWindowSize)
  mouse/
    tracking.ts                # enable/disable SGR 1006 mouse tracking on stdout
    parse.ts                   # pure: stdin escape bytes -> MouseEvent {x,y,button,action}
    registry.ts                # hit-test registry: rect -> handler (fed by useBoxMetrics)
    components.tsx             # <Clickable>, <Scrollable>
    hooks.ts                   # useClick(ref), useScroll(ref), useMousePosition()
  sessions/
    feed.ts                    # pure: read session-db -> LiveSession[] (status/liveness/binding)
    transcript.ts              # tail transcript_path (chokidar) -> lines; generic renderer
  tmux/
    detect.ts                  # `which tmux` once at startup
    launch.ts                  # tmux new-window running buildAgentArgv() output
    attach.ts                  # suspend TUI -> tmux attach/select-window -> resume
  components/ hooks/ colors.ts # existing browse pieces, reused
```

### Layout (fullscreen)
- **Left rail** — top: **Live Sessions** (status dot, agent, assignment, liveness, tokens); below: projects → assignments **tree**. Click to select; scroll to navigate.
- **Main pane** — context-sensitive: assignment detail (status, acceptance criteria, plan, recent progress, workspace) **or** the focused session's **live transcript tail** + session meta.
- **Bottom bar** — keybinding hints + **clickable** action buttons (Launch / Attach / Plan…). Buttons disable/grey when unavailable (e.g. Attach with no tmux).
- Collapses to a single column below a width threshold (`useWindowSize`).

## 6. Data flow

### Monitor (always works, tmux-independent)
1. `sessions/feed.ts` polls `session-db` every ~1–2s → `LiveSession[]` with status, `pid`/`activity` liveness, and assignment via the `engagement` edge.
2. On focusing a session, `sessions/transcript.ts` tails its `transcript_path` (chokidar watch → push updates) and renders a generic line tail. Agent-specific formats (Claude JSONL vs codex/pi) render raw in v1.

### Launch (tmux preferred, hand-off fallback)
1. Select assignment → pick agent (reuse agent selection).
2. Reuse `launch.ts` to resolve worktree/cwd, write `context.json`, and build argv via `buildAgentArgv()` + `resolveLaunchPrompt()`.
3. **tmux present:** `tmux/launch.ts` runs the argv in a detached `tmux new-window`. Cockpit stays resident; the new session surfaces in the feed once its `track-session` hook registers it.
4. **tmux absent:** fall back to today's behavior — `stdio:'inherit'` spawn + exit into the agent (cockpit ends).

### Attach (tmux only)
- Enter/click a live session → `tmux/attach.ts` suspends the Ink app (leave alt-screen, disable mouse tracking), runs `tmux attach`/`select-window`, and on detach re-enters alt-screen + re-enables mouse. No tmux → action disabled with a tooltip.

## 7. Error handling & edge cases
- **No tmux:** cockpit fully functional for browse + monitor; Launch falls back to hand-off; Attach disabled. Detected once at startup.
- **Terminal without mouse (some SSH/emulators):** mouse tracking degrades silently to keyboard-only; nothing blocks on mouse.
- **Terminal resize:** `useWindowSize` re-renders; hit-test rects recomputed from `useBoxMetrics`.
- **Alternate-screen restore:** always restore original screen + disable mouse tracking on exit, crash, and during attach hand-off (avoid leaving the terminal in mouse-reporting mode).
- **Stale/dead sessions:** liveness derived from `pid` + `pid_started_at` + `activity`; dead-but-not-closed sessions rendered as stale, not live.
- **Missing/unreadable `transcript_path`:** show "no transcript available", never crash the pane.
- **Large trees:** viewport clipping already exists in `TreeView`; add virtualization only if measured slow (YAGNI otherwise).

## 8. Testing strategy
- **Mouse layer** (`parse.ts`, `registry.ts`): pure and fully unit-testable — feed escape byte sequences → assert `MouseEvent`s; feed rects + a click → assert the hit handler fires. No terminal needed.
- **tmux layer**: behind an interface with a `spawnFn` seam (mirrors `launch.ts`'s existing test hook) — assert exact tmux argv without spawning tmux.
- **Session feed**: pure over an in-memory/temp session-db — assert liveness/binding derivation.
- **Transcript tail**: feed synthetic file writes → assert emitted lines.
- **Component smoke**: `ink-testing-library` render of Cockpit with mocked `api.ts`/feed → assert regions render and keymap dispatches.

## 9. v1 acceptance criteria
1. `syntaur tui` opens a fullscreen alternate-screen app and restores the terminal cleanly on exit.
2. Left rail shows the project/assignment tree (keyboard + mouse navigation) and a Live Sessions list.
3. Selecting an assignment shows its detail in the main pane.
4. Live sessions show correct liveness; focusing one tails its transcript.
5. Launching an agent with tmux present creates a detached tmux window and the cockpit stays resident; without tmux it falls back to hand-off.
6. Attach/detach works with tmux; the button is disabled without tmux.
7. Mouse: click-select, click-expand/collapse, click action buttons, scroll panes.
8. Keyboard parity for every mouse action; no regression to the existing `browse` command.

## 10. Risks / open questions
- **Mouse portability** across terminal emulators and SSH — mitigated by silent keyboard fallback; validate on the terminals actually used.
- **Transcript formats differ per agent** (Claude JSONL, codex, pi) — v1 renders generic tail; pretty-printing deferred.
- **tmux version differences** in `new-window`/`attach` flags — pin to widely-supported syntax; test on the local tmux.
- **Ink 7 upgrade** may touch the existing `browse` TUI — verify `browse` still renders after the bump (it stays as-is otherwise).
- **Suspend/resume around attach** must be airtight to avoid corrupting terminal state.
