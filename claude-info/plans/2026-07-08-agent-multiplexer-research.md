# Syntaur Agent Multiplexer — Research & Design Sketch

- **Date:** 2026-07-08
- **Status:** Research (pre-assignment). **Direction confirmed 2026-07-08:** move off tmux (kept only as a transitional fallback during migration, then removed); TUI stays on the Ink/React stack (ink 7 + react 19 — the same architecture Claude Code uses).
- **Topic:** An agent-agnostic background-session daemon ("mini-multiplexer") for Syntaur, modeled on Claude Code's Agent View architecture, managing *all* agents (claude, codex, pi, …) under one supervisor with the Ink cockpit + web dashboard on top.
- **Predecessors:** `2026-07-01-syntaur-tui-cockpit-design.md` (v1), `2026-07-02-tui-cockpit-v2-design.md` (v2, in review)

## 1. How Claude Code actually does it (verified on this machine, v2.1.205)

Reverse-engineered live: process table, `lsof`, `~/.claude/daemon.log`, decompiled binary strings, plus official docs (code.claude.com/docs/en/agent-view). It is **not tmux** — it's a purpose-built three-layer system:

| Layer | Mechanism | Evidence |
| --- | --- | --- |
| **Supervisor daemon** | `claude daemon run`, spawned on demand, detached (macOS: wrapped in `launchctl asuser` to survive terminal/SSH close). Binds a Unix control socket, speaks newline-delimited JSON: `dispatch`, `attach`, `subscribe`, `resize`, `kill`. Windows: same protocol over named pipes. | PID parented to launchd; `/tmp/cc-daemon-501/<id>/control.sock`; `claude daemon status/logs` |
| **PTY-host per session** | `claude bg-pty-host --bg-pty-host <sock> <cols> <rows> -- <agent argv>` — one process per background session, owning a **real pseudo-terminal** (`/dev/ptmx` master; worker gets `/dev/ttysNNN` as stdio). Exposes the PTY over `pty/<id>.sock`; a second `rv/<id>.sock` ("rendezvous") carries structured state. | `lsof` on host + worker; socket tree under `/tmp/cc-daemon-501/<id>/` |
| **Spare pool** | Pre-booted `claude bg-spare` workers parked behind `claim.sock`s; dispatch claims one instead of cold-starting Node. | daemon.log: `bg claimed-spare a9b52786 (slash)` |

**Attach** is mechanically a PTY byte-pipe (like `tmux attach`) with two twists: on attach the daemon *resizes the PTY to the attacher's exact dimensions* and replays a ~1MB ring buffer of recent output, then asks the worker (its own Ink app, so it cooperates) to fully repaint. **The dashboard list never touches the PTY** — it uses `subscribe` on the rendezvous socket to stream structured state patches.

**Persistence:** conversation truth is the JSONL transcript; per-job `~/.claude/jobs/<id>/state.json` + `timeline.jsonl` hold status/needs/respawnFlags. A restarting daemon **adopts** still-live pty-hosts from a roster file (`bg adopt: adopted=2 respawned=0 dead=0`), respawns upgraded ones, reaps orphans. Memory-pressure-aware retirement of settled workers.

## 2. The generalization problem

The daemon + pty-host + socket layers are **already agent-agnostic** — a PTY doesn't care what runs inside it. Exactly two pieces depend on the worker being Claude, and both have generic replacements:

1. **Repaint on attach.** Claude replays a raw ring buffer and asks its own app to redraw. Arbitrary agents can't be asked. **Generic fix: keep a headless terminal emulator in the pty-host** (`@xterm/headless` + `@xterm/addon-serialize`) so the host always holds the *current rendered screen*, not a byte log. On attach: resize PTY → kernel delivers `SIGWINCH` → every full-screen TUI redraws itself anyway (that's the free, universal repaint) → serialize the emulator screen as the snapshot. This is precisely how VS Code implements terminal persistence/reconnect (its ptyHost process), and how tmux works internally. Proven, boring tech.
2. **Structured state.** Claude workers self-report (`state.json`, waiting/needs). Other agents need **adapters** — and this is where Syntaur has a moat: it is already in the state business (session-db, `track-session` hooks, engagement edges, assignment bindings).

## 3. Proposed architecture

```
syntaur daemon run                    # supervisor: on-demand, detached, control.sock,
                                      # roster + adoption, NDJSON protocol
syntaur pty-host --sock <p> <c> <r> -- <agent argv>
                                      # node-pty + @xterm/headless + serialize;
                                      # one per session, survives daemon restarts

/tmp/syntaur-<uid>/<daemonId>/
  control.sock                        # dispatch / list / kill / daemon ops
  pty/<short>.sock                    # attach: snapshot + bidirectional raw bytes, resize
  rv/<short>.sock                     # subscribe: state record + patches + settled

~/.syntaur/jobs/<short>/state.json    # state, needs, agent kind, assignment binding
~/.syntaur/jobs/<short>/timeline.jsonl
```

### 3.1 Session model (superset of what session-db already stores)

`{ short, agent: 'claude'|'codex'|'pi'|…, argv, cwd, worktreePath, project/assignment binding, state: working|blocked|done|failed|stopped, tempo, needs?: string, tokens?, transcriptPath?, pid, procStart }` — `state`/`needs` power the cockpit's ⚠ attention rows and the dashboard.

### 3.2 Agent adapters

```ts
interface AgentAdapter {
  id: string;
  buildArgv(launch: LaunchPlan): string[];         // exists today (buildAgentArgv)
  transcript?(s: Session): TranscriptSource;        // claude JSONL today; codex ~/.codex/sessions
  deriveState(x: {
    screen: ScreenText;        // rendered text from the headless emulator — not byte soup
    hookEvents?: HookEvent[];  // where the agent supports hooks
    procAlive: boolean; exitCode?: number;
    outputIdleMs: number;
  }): Partial<SessionState>;
}
```

- **claude:** hook-driven — SessionStart/Stop/Notification/PermissionRequest hooks writing NDJSON events into a spool dir the daemon watches (exactly the cmux pattern already running on this machine; `track-session` is halfway there). Highest-fidelity state for free.
- **codex:** `notify` hook for turn-completion events + session JSONL + screen heuristics.
- **generic/pi:** screen heuristics only — and they're better than they sound because the emulator gives the *actual rendered screen*: match approval prompts (`(y/n)`, `Allow …?`, `❯` idle REPL prompt), output-silence timers for idle, exit code for done/failed. Tunable per agent; misclassification degrades to "working", never crashes.

### 3.3 Attach flow (generic repaint)

1. Client connects to `pty/<short>.sock` with `{cols, rows}` → host resizes PTY + emulator → SIGWINCH makes the app redraw at the new size.
2. Host serializes the emulator screen (plus capped scrollback) → snapshot to client.
3. Raw bytes stream both ways; client input → PTY; last-attacher-wins sizing (Claude's policy).
4. Detach = socket close; nothing to clean up in the worker.

No prefix key, no status bar, no chrome — the cockpit suspends Ink (existing `runWithMouseSuspended` sandwich from v2, verbatim) and becomes a dumb pipe, same as `claude attach`.

### 3.4 Browser attach — the feature Claude Code doesn't have

The dashboard already ships `express` + `ws`. Bridge `pty/<short>.sock` ↔ WebSocket ↔ **xterm.js** in the dashboard page — the serialize snapshot format is native to xterm.js because it *is* the same emulator. One session, attachable from the TUI cockpit **and** the browser, backed by one daemon. This alone justifies owning the multiplexer instead of renting tmux.

### 3.5 Resilience (steal Claude's patterns wholesale)

- pty-hosts are independent detached processes → daemon crash/upgrade never kills sessions; new daemon **adopts** from the roster (verify pid + procStart), reaps orphaned sockets.
- macOS: spawn daemon via `launchctl asuser <uid>` so it lands in the GUI session and survives SSH/terminal close.
- Respawn-on-resume only where the agent supports it (`claude --resume <jsonl>`, codex resume); generic agents settle to `failed` with the serialized last screen kept for post-mortem in `timeline.jsonl`.
- **Skip the spare pool** in v1 — it exists because Claude's Node boot is slow and pre-authable; arbitrary agents aren't. Note as a per-agent optimization later.

## 4. Why not just tmux? (honest comparison)

tmux *is* this architecture prewritten (server daemon + PTYs + internal screen emulator + attach). v1/v2 already use it. Reasons to own the layer instead:

| Concern | tmux | Owned daemon |
| --- | --- | --- |
| Structured state (working/blocked/needs) | none — would still need all of §3.2 bolted on outside | native, on the rendezvous socket |
| Attach feel | leaky chrome (status bar, prefix, copy-mode, exit messaging) — the "why doesn't it feel native" gap that motivated this research | dumb pipe + resize-to-attacher; feels like the agent is local |
| Browser terminal | needs control-mode parsing or a side websocket project anyway | ws bridge + xterm.js, same snapshot format |
| Dependency | external install, version drift (v1 pinned flags defensively) | none beyond npm deps |
| State/session join | name-mangling conventions | daemon *is* the session registry; joins session-db directly |

**Decision (2026-07-08): we are moving off tmux.** Keep the tested tmux path only as a transitional fallback during migration (it's already isolated behind `tmux/launch.ts` + `tmux/attach.ts`); remove it once the daemon proves out (target: end of Phase C, when adapters make daemon-managed sessions strictly better than tmux ones). *(Done — Phase C, 2026-07: `src/tui/tmux/` deleted; the ladder is syntaurd → claude-bg → hand-off.)*

## 5. Fit with the existing codebase

| Piece | Disposition |
| --- | --- |
| `buildLaunchPlan` / `buildAgentArgv` / context.json | reused — dispatch payload is exactly its output |
| `sessions/feed.ts` + session-db + liveness | reused — daemon `subscribe` becomes the primary source; session-db stays the durable registry; `claude agents --json` join (v2) stays to surface sessions living in *Claude's* daemon (e.g. `/bg` from a terminal outside Syntaur) |
| `tmux/launch.ts`, `tmux/attach.ts` | fallback path, then deprecated |
| Cockpit attach suspend/resume sandwich | reused verbatim for socket attach |
| `transcript-render/` parsers | unchanged — transcript pane stays renderer-driven; attach is for interaction, not monitoring |
| Dashboard (express + ws) | gains the WS↔pty bridge + xterm.js pane |
| New deps | `node-pty` (prebuilds; native-module precedent: better-sqlite3), `@xterm/headless`, `@xterm/addon-serialize` |

## 6. Phased roadmap

- **A — pty-host + daemon core:** `syntaur pty-host` (node-pty + headless emulator + attach protocol), `syntaur daemon` (dispatch/list/kill, roster, adoption, control socket), jobs dir. CLI smoke: `syntaur bg -- codex …`, `syntaur attach <short>`.
- **B — cockpit integration:** Launch/Attach route through the daemon for all agents; feed subscribes; tmux demoted to fallback.
- **C — adapters + attention:** claude hook spool, codex notify, generic screen heuristics; ⚠ rows powered by daemon state end-to-end.
- **D — browser attach:** ws bridge + xterm.js pane in the dashboard.
- **E — extras:** Windows (conpty via node-pty + named pipes), per-agent warm pools, memory-pressure retirement, `syntaur daemon status/logs`.

## 7. Risks / open questions

- **node-pty native builds** in an npm-linked CLI — prebuilds cover mac/linux/win; better-sqlite3 sets precedent. Validate under `npm link` early (Phase A gate).
- **Emulator memory** per session (~few MB + scrollback) — cap scrollback (Claude caps its ring at 1MB); retire settled sessions' emulators, keep only the serialized final screen.
- **Screen-heuristic false positives** for generic agents — bias toward "working"; only strong patterns flip to blocked/needs; adapters override.
- **Two Claude worlds** (sessions under syntaurd vs Claude's own daemon). Recommendation: launch Claude under syntaurd for uniformity; the v2 `agents --json` join covers the other world read-only. Revisit if Claude's `/bg` handoff becomes something we want to trigger programmatically.
- **Input latency** through host + socket hop — negligible on Unix sockets (Claude Code proves the UX at scale on this exact machine).
- **Security:** socket dirs `0700`, uid-scoped path (`/tmp/syntaur-<uid>/…`), same posture as `cc-daemon-501`.
