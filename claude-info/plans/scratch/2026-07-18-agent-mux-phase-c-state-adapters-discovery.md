# Agent Multiplexer Phase C — State Adapters + Attention States + tmux Removal — Discovery Findings

## Metadata
- **Date:** 2026-07-18
- **Complexity:** large
- **Tech Stack:** TypeScript ESM, Node >= 20 (`package.json:69-71`), commander CLI, Ink 7 + React 19 TUI, node-pty + @xterm/headless 6 + @xterm/addon-serialize, better-sqlite3, chokidar ^4 (declared dep, `package.json:77`), vitest 3 + ink-testing-library, tsup build. Worktree: `/Users/brennen/syntaur/.worktrees/agent-mux-state-adapters`, branch `agent-mux-state-adapters`.

## Objective

Give every daemon-hosted agent session a derived attention state (`working`/`blocked`/`done`/`failed` + `needs` text) via per-agent-kind adapters (claude hook spool, codex notify+log, generic screen heuristics), surface it end-to-end in `state.json`/`timeline.jsonl` and the cockpit's ⚠ rows/sorting, remove the agent-mux tmux tier entirely, and close Phase B's two launch-correlation residuals with a pending-launch reservation.

## User's Request (acceptance criteria)

1. `AgentAdapter` interface with `deriveState({screen, hookEvents, procAlive, exitCode, outputIdleMs})` per research doc §3.2.
2. claude adapter: SessionStart/Stop/Notification/PermissionRequest hooks write NDJSON events to a spool dir the daemon watches; permission prompts → `blocked` + `needs` within one poll cycle.
3. codex adapter: notify-hook events + session log + screen heuristics → working/blocked/done.
4. generic adapter: screen-text heuristics (approval prompts, output-silence idle timers, exit codes), bias toward `working`; misclassification never crashes.
5. `state.json`/`timeline.jsonl` reflect adapter-derived states; cockpit ⚠ rows, sorting, and `needs` text driven by them end-to-end for all three agent kinds.
6. `src/tui/tmux/` removed with its detect path; docs updated; pre-existing tmux-launched sessions degrade gracefully (listed stale, no crash).
7. Fixture-driven adapter tests: captured screens + hook event streams → expected states, incl. false-positive guards.
8. Pending-launch reservation closing Phase B's two residuals (hook-race duplicate row; probe-can't-prove-a-non-landing), without reintroducing the rejected insert-before-dispatch trap.

## Research Doc Contract (§3.2, verbatim)

`claude-info/plans/2026-07-08-agent-multiplexer-research.md:53-64`:

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

Adapter dispositions (research doc :67-69): claude = hook-driven NDJSON spool (cmux pattern); codex = notify hook + session JSONL + screen heuristics; generic/pi = screen heuristics only, "misclassification degrades to 'working', never crashes." Jobs-dir contract (:43-44): `~/.syntaur/jobs/<short>/state.json` holds "state, needs, agent kind, assignment binding"; `timeline.jsonl` alongside. tmux removal mandate (:103): "**Decision (2026-07-08): we are moving off tmux** … remove it once the daemon proves out (target: end of Phase C…)". Risk note (:129): heuristics "bias toward 'working'; only strong patterns flip to blocked/needs; adapters override."

## Codebase Overview

_(Sections below filled from four explorer sweeps + direct reads; every claim carries file:line.)_

### Daemon layer (adapter integration seams) — Explorer 1

**Screen buffer (`src/daemon/pty-host.ts`):**
- `ScreenBuffer` interface (:79-84): `{write(data, cb?), resize(cols, rows), snapshot(): {data: string; cols: number; rows: number}, dispose()}`. `createScreenBuffer(cols, rows, scrollback = DEFAULT_SCROLLBACK)` (:87-101) wraps `new Terminal({cols, rows, scrollback, allowProposedApi: true})` + `SerializeAddon`; `snapshot()` = `serializer.serialize()` → **ANSI, not plaintext**. The `Terminal` instance is closure-private — `term.buffer.active.getLine(i).translateToString()` is unreachable today. **Adapters need a new plaintext projection method added to `ScreenBuffer`** (extend `createScreenBuffer` to expose e.g. `text(): string[]` via the buffer API) or must re-parse ANSI (worse). `DEFAULT_SCROLLBACK = 1000` (:27).
- `pty.onData` handler (:311-318): `screen.write(data)` + `{t:'out'}` base64 frames to live pty clients; pending clients get `client.scheduler?.bump()`. This is the single point every output byte crosses — where a `lastDataAt` stamp and a re-armable derive scheduler hook in.
- `scheduleQuiescentSnapshot(onFire, {idleMs?, capMs?})` (:105-146): idle 100ms / cap 400ms (:28-29), but it is **one-shot** (`done` latches) and per-attach only. **No `lastDataAt` timestamp exists anywhere; no continuous idle scheduler exists.** `outputIdleMs` must be computed from new state recorded in `onData` (deps.now seam exists: `now?: () => number`, `PtyHostDeps:183`).

**rv path (`pty-host.ts`):**
- `rvClients = new Set<SocketLike>()` (:248). `handleRvConnection` (:391-399) sends exactly one `{t:'state', record: stateRecord('working')}` on connect. `finalizeExit(exitCode, signal)` (:405-455) writes final `JobState` (with `lastScreen: snap.data`) via `writeJobState` (:418), `appendTimeline({event:'exited', code, signal})` (:419), then sends `{t:'settled', record: stateRecord(state, exitCode, signal)}` to every rv client (:434-435) and ends sockets. **These are the ONLY two rv emissions and the ONLY two writeJobState calls** (initial `working` at :280-281 with `{event:'spawned'}`; terminal at :418-419). No mid-life state broadcast, no `blocked` producer anywhere. `stateRecord` factory (:283-292) builds `{short, state, pid, cols, rows, updatedAt, exitCode?, exitSignal?}`.
- `toState(exitCode, signal)` (:209-212): signal → `'stopped'`, code 0 → `'done'`, else `'failed'`.
- exitCode/procAlive during life: no `procAlive` var — just `let exited = false` (:246) + `pendingExit` fast-child buffer (:402-403,464); exitCode flows as a `finalizeExit` parameter, never a field.
- `PtyHostDeps` (:176-188): injectable `ptyFactory, bindSocket, createScreen, writeJobState, appendTimeline, procStart, now, idleMs, capMs, onExit`. `PtyHostConfig` (:162-174) carries `agent: string`, `argv`, `sessionId?: string | null`, `scrollback?`.

**Supervisor (`src/daemon/supervisor.ts`):**
- `toSession(ds)` (:164-184): `readJobState(ds.short)` **fresh from disk on every list call** (:166); `state = live ? (js?.state ?? 'working') : (js?.state ?? 'stopped')` (:167) where `live = sessionLive(ds)` = `processIdentity(hostPid, hostPidStartedAt) !== 'dead'` (:145-150). The daemon holds NO in-memory state field (`DaemonSession` :78-93 is immutable metadata). **Consequence: an adapter that writes `state.json` atomically surfaces through `{op:'list'}` within one poll with zero supervisor changes** — but note :167 masks disk state to the liveness gate only when state.json is absent; a live host's disk `blocked` flows straight through.
- `list()` (:265-267): `{ok: true, sessions: [...sessions.values()].map(toSession)}`.
- `handleSubscribe` (:512-544): relays rv frames re-wrapped as `{ok: true, record: frame.record}` (:539) — **the `t:` discriminator is dropped** (known residual); subscribers can't tell `state` from `settled`. Phase C must preserve `t` if subscribe is used for transitions.
- Agent kind: `const agent = req.agent ?? inferAgent(req.argv)` (:205); `inferAgent` (:95-98) = basename(argv[0]) minus `.js/.mjs/.cjs/.sh`, default `'shell'`; passed to the host as `--agent` (:216), parsed in `pty-host-run.ts:43`, stored in `DaemonSession.agent`, `JobState.agent`, `RosterEntry.agent`. **Free-form string, no enum — adapter registry must fall back to generic for unknown values.**

**Types (`src/daemon/types.ts`):** `SessionState = 'working'|'blocked'|'done'|'failed'|'stopped'` (:10 — `blocked` exists, nothing produces it). `Session` (:13-35) has `agent: string` (:17), `sessionId: string | null` (:29 — "Reserved for the Phase B session-db join"), `exitCode?/exitSignal?`; **no `needs` field**. `JobState extends Session` (:38-52) adds `updatedAt, daemonId, ptySock, rvSock, hostPid, hostPidStartedAt, lastScreen?`. `StateRecord` (:121-130). `RvFrame = {t:'state', record} | {t:'settled', record}` (:194-196). Dispatch op (:99-109): `{op:'dispatch', argv, cwd?, name?, env?, agent?, cols?, rows?, sessionId?}`.

**Jobs (`src/daemon/jobs.ts`):** `readJobState(short): JobState | null` (:13-19, null on corrupt); `writeJobState(state: JobState): void` (:22-28, tmp + `renameSync` atomic); `appendTimeline(short, {event, at?, ...}): void` (:31-38, `appendFileSync` one NDJSON line, stamps `at` if omitted); `listJobShorts()` (:41-49), `readAllJobStates()` (:52-59).

**Paths (`src/daemon/paths.ts`):** `jobsDir()` :79, `jobDir(short)` :83, `jobStatePath` :87, `jobTimelinePath` :91 — jobs dir today holds exactly `state.json` + `timeline.jsonl`; the hook spool is a net-new sibling under `jobDir(short)`. Honors `SYNTAUR_HOME`. `ensureDir0700` (:153-183) hardened (symlink/owner/mode checks, throws `SyntaurError`).

**Protocol (`src/daemon/protocol.ts`):** `encodeFrame` (:26), `isFrameObject` (:33), `createLineDecoder<T>(maxPendingBytes = 32MiB)` (:56, :23): skips blank lines and silently skips unparseable JSON lines (:67-73), strips `\r`, StringDecoder-safe for partial UTF-8, `FrameOverflowError` on oversized unterminated line (:76-79). Streaming chunk decoder — a spool consumer feeds file bytes through `push()` itself.

**Liveness (`src/daemon/liveness.ts`):** `processIdentity(pid, expectedStart, deps): 'alive'|'dead'|'unknown'` (:46-58); destructive actions require `'dead'`.

**Barrel (`src/daemon/index.ts:3-19`):** does NOT export `writeJobState`, `appendTimeline`, `jobTimelinePath`, `createScreenBuffer`, `scheduleQuiescentSnapshot`, `ScreenBuffer`, `PtyHostDeps` — new `src/daemon/adapters/` needs direct module imports or new barrel exports.

**Test harness (`src/daemon/__tests__/pty-host.test.ts`):** `fakePty()` (:18-48, `emit(d)`/`fireExit(code, signal)`, pid 12345), `fakeSocket()` (:50-71, `frames()` NDJSON parse), `fakeBind()` (:73-81), `fakeScreen()` (:83-98, plain-string snapshot — the seam adapter tests reuse for scripted screens), `baseConfig()` (:102-113), `SYNTAUR_RUNTIME_DIR` redirect (:185-196), `boot(over)` DI helper (:200-218), fake timers via `vi.useFakeTimers` + `advanceTimersByTime` (:141-142, 232+). Real `createScreenBuffer` fed ANSI bytes asserted with `.toContain` (:117-136).

**chokidar:** dep declared; imported only at `src/tui/sessions/transcript.ts:1` (`chokidar.watch(path, {ignoreInitial: true})` :51 — single-file watch precedent) and `src/dashboard/watcher.ts:1` (comments note chokidar 4 dropped glob support — filter literal paths). Not used in `src/daemon/` yet.

### Cockpit attention surface (⚠ end-to-end) — Explorer 2

**Hop 1 — daemon → feed entry (`src/tui/syntaurd/feed-source.ts`):** `SyntaurdFeedEntry` (:5-13) = `{sessionId, short, state: SessionState, name: string | null, agent: string}` — **no `waitingFor`/`needs`**. `makeSyntaurdSessionSource` (:34-49) polls `{op:'list'}` via `queryDaemon` with `LIST_TIMEOUT_MS = 1000` (:23, per-query timeout, non-spawning), maps `{sessionId, short, state, name ?? null, agent}` verbatim (:46), skips entries without a string sessionId; throw/`!ok` → `null` (probe failure ≠ empty; caller holds last-known ≤1 poll).

**Hop 2 — join (`src/tui/sessions/feed.ts`):** produces `AgentSessionWithLiveness[]` (`src/dashboard/types.ts:773-777`; there is no bespoke SessionFeedEntry). Relevant `AgentSession` fields (`types.ts:753-770`): `activity?: ActivityState | null` (`'working'|'idle'|'awaiting-input'`), `hostedBy?`, `state?: NativeAgentState | null`, `waitingFor?: string | null`, `agentShortId?`, `syntaurdShortId?`, `launcher?`. `LIVE_STATES = new Set(['working','blocked'])` (feed.ts:19). `stateToActivity` (:21-30): working→working, blocked→awaiting-input, else null. `applySyntaurdJoin` (:145-163) stamps `state, syntaurdShortId, activity, isLive, launcher:'syntaurd'` — **never `waitingFor`** (doc comment :137-144 explicitly preserves the claude-view join's `waitingFor`/`agentShortId`; test feed.test.ts:196-208 asserts that preservation). The ONLY `waitingFor` writer is `applyNativeJoin` (:111-135, claude `agents --json` overlay, stamps `waitingFor: d.waitingFor`, `launcher:'claude-bg'`). Join order (:165-176): native first, syntaurd LAST (wins on state/isLive/launcher).

**Hop 3 — claude template source (`src/sessions/agent-view.ts`):** `AgentViewDetailEntry` (:111-118) = `{sessionId, id, name, state: NativeAgentState | null, waitingFor: string | null}`; parsed from `execFile('claude', ['agents','--json'])` stdout (:195-199, 215-219), accepting `waitingFor` or `waiting_for` (:184-187); free-form string, e.g. `"permission prompt"` in tests.

**Hop 4 — rail (`src/tui/cockpit/railTypes.ts`):**
```ts
function isWaiting(s) { return s.waitingFor != null || s.state === 'blocked' || s.activity === 'awaiting-input'; } // :75-77
function resolveActivityText(s, liveActivity) {   // :90-97
  if (s.waitingFor) return `⚠ ${s.waitingFor}`;
  if (isWaiting(s)) return '⚠ awaiting input';
  if (liveActivity) return liveActivity;
  if (isWorking(s)) return 'working';
  if (s.activity === 'idle') return 'idle';
  return null;
}
function liveRank(s) { if (isWaiting(s)) return 0; if (isWorking(s)) return 1; return 2; } // :116-120
```
Glyph/color (:122-135): live+waiting `◐` yellow, live `●` green, else `○` gray. Sort lives in `buildRailRows` (:157-163): live rows by `liveRank` then recency. Rows are built in `LeftRail.tsx:26` (`buildRailRows`), painted at `LeftRail.tsx:142` (glyph) and `:146` (`activityText`, yellow when `isWaiting`) — Cockpit.tsx only passes raw `sessions` into `<LeftRail>` (:460-470).

**Hop 5 — subscription (`Cockpit.tsx:106-127`):** poll loop `loadSessions(...)` every `SESSION_POLL_INTERVAL_MS = 1500` (:35); catch keeps last-known. Attention latency budget = ~1.5s poll + adapter derive time (AC #2 "within one poll cycle" measures against this).

**How `state:'blocked'` renders TODAY for a syntaurd session:** ⚠ lights (via `state==='blocked'` → `isWaiting` true, `activity:'awaiting-input'`), sorts to top, glyph `◐` yellow — but text is always the GENERIC `'⚠ awaiting input'`; the specific-reason branch `` `⚠ ${s.waitingFor}` `` (railTypes.ts:91) is unreachable for daemon rows because nothing sets `waitingFor`. That is precisely the hole `needs` fills. Confirmed by feed.test.ts:186-194 (blocked daemon fixture → isLive true, activity awaiting-input; comment: "Phase A daemons never emit it").

**Existing tests on this path:** railTypes.test.ts:80-87 (waiting→working→idle sort), :89-94 (`'⚠ permission prompt'`, isWaiting true), :104-110 (waitingFor wins over liveActivity); feed.test.ts:64-79 (native join stamps waitingFor), :186-194 (daemon blocked), :196-208 (syntaurd overlap preserves claude waitingFor); LeftRail.test.tsx:264-266 (re-sort to top on becoming waiting); feed-source.test.ts:11-13 asserts the exact entry shape with strict `toEqual` — **adding `needs` breaks this assertion unless updated**.

**`needs` collision check:** no `needs` identifier exists anywhere in src/ code (only comments/user-facing strings) — safe to introduce across daemon `Session` → `SyntaurdFeedEntry` → `AgentSession` → rail.

**Wiring implication (all four hops must change or `needs` silently no-ops):** daemon `Session`/`StateRecord`/`JobState` gain `needs?`; feed-source projection copies it; `applySyntaurdJoin` stamps it (into a new `AgentSession.needs` field or carefully into `waitingFor` — the latter changes the preservation contract asserted at feed.test.ts:196-208); railTypes `isWaiting`/`resolveActivityText` consult it. Note `NativeAgentState` (dashboard/types.ts:724) and daemon `SessionState` (daemon/types.ts:10) are structurally identical but separately declared — the join relies on that coincidence.

### tmux inventory (removal + graceful degradation) — Explorer 3

**Boundary:** two disjoint tmux subsystems. Agent-mux tier = `src/tui/tmux/` + wiring in `src/tui/cockpit/` + `src/commands/tui.ts`. Dev-server tier = `src/dashboard/{scanner,autodiscovery,api,help,types}.ts` + `skills/track-server/` — untouched. The only shared symbol is `checkTmuxAvailable`, DEFINED at `src/dashboard/scanner.ts:154` (definition stays; only the agent-mux call site `src/commands/tui.ts:39` goes).

**Class A — remove/edit (exhaustive):**
- DELETE `src/tui/tmux/{launch.ts (74 ln), attach.ts (29 ln), __tests__/launch.test.ts, __tests__/attach.test.ts}`. Exports lost: `tmuxSessionName`, `buildTmuxLaunchArgv`, `launchInTmux`, `launchInTmuxWithPid`, `tmuxSessionExists`, `ExecFn`, `TmuxLaunchInput(+WithEnv)` (launch.ts); `buildTmuxAttachArgv`, `runTmuxAttach`, `TmuxAttachResult` (attach.ts). Note `TmuxAttachResult` is shape-identical to `actions.ts`'s `ChildOutcome`, which is NOT tmux-owned and stays.
- `src/tui/cockpit/actions.ts`: import :3; `ActionCaps.tmuxAvailable` :19; attach tmux gate :80 (`return caps.tmuxAvailable && session.isLive === true && session.assignmentSlug != null;`); `LaunchDeps.tmuxAvailable` :136 + **REQUIRED** `launchInTmux: typeof LaunchInTmux` :137; `runLaunch` return union `'syntaurd'|'claude-bg'|'tmux'|'handoff'` :193; tmux rung :224-227 (`if (deps.tmuxAvailable) { await deps.launchInTmux({...}); return 'tmux'; }`); ~23 doc-comment lines. Ladder order: syntaurd (:200-207) → claude-bg (:208-223) → tmux (:224-227) → handoff (:228-229). Backend-aware guard :79: `if (session.hostedBy === 'syntaurd' || session.hostedBy === 'claude-bg') return false;` — a `'tmux'`/null row skips it and hits :80.
- `src/tui/cockpit/Cockpit.tsx`: imports :21-22,:32; `CockpitProps.tmuxAvailable` :51 (+ destructure :59); `tmuxSessionName` :174; `tmuxPanePid` :185; deps threading :190; `launchInTmux` closure :216-226 incl. marker plant :224 (`env: {SYNTAUR_LAUNCH_ID: fallbackLaunchId, SYNTAUR_HOSTED_BY: 'tmux'}`); `mode === 'tmux'` status :277; provenance-write block :282-304 (`appendSession` with `hostedBy:'tmux'` :299); handleAttach tmux branch :367-390 (`runTmuxAttach` :383 — the daemon guard :362-365 stays); `buildActions(..., {tmuxAvailable, claudeBgAvailable}, ...)` :398.
- `src/commands/tui.ts`: import :4; `CockpitRenderProps.tmuxAvailable` :12; `checkTmux` dep :20; prop derivation :27; `checkTmux: checkTmuxAvailable` :39.
- Tests: `actions.test.ts` — all 24 `it`s build tmux-shaped `LaunchDeps` (`deps()` helper), 8 assert `'tmux'` mode (L10,46,53,60,68,76,158,172) → full-file rewrite. `actions.test.tsx` — 13 tmux-dependent `it`s (L54,60,72,78,91,114,120,133,148,162,199,218,248); `caps(tmuxAvailable)` helper :31; L148 (daemon rows never fall to the tmux gate) must survive in altered form; `isCleanExit` block :235-256 is generic, keep. `Cockpit.test.tsx` — `vi.mock('../../tmux/launch.js', importOriginal)` :52-54 + `vi.mock('../../tmux/attach.js')` :57-58 **fail to load once the module is deleted** (mandatory same-change edit); tmux `it`s L164, 252-320, 529, 563, 607, 630, 710, 739 (the last four assert tmux NOT taken — survive conceptually). `src/commands/__tests__/tui.test.ts` L5,9,16,26 assert checkTmux/tmuxAvailable.

**Class B — keep untouched (dev-server tier):** `src/dashboard/scanner.ts` (:154 definition, :55-58,90,147-175,355,364,458,555-582), `autodiscovery.ts` (:112-170,255-263,310-321; `checkTmuxAvailable()` calls :126,:256), `api.ts:758,960,966`, `help.ts:327,377,450`, `types.ts:694` (`ServersResponse.tmuxAvailable`), `types.ts:697` (`SessionKind = 'tmux'|'process'`), tests `autodiscovery.test.ts` (spy :341), `scanner.test.ts`, `perf-overview.test.ts:160,191,251`, `skills/track-server/`, `platforms/claude-code/commands/track-server/`, `platforms/codex/commands/track-session.md`, `src/templates/codex-agents.ts:41`.

**Class C — keep for graceful degradation:** `src/dashboard/types.ts:727` (`SessionLauncher = 'claude-bg'|'tmux'|'syntaurd'|null`), :730 (`SessionHostedBy = 'syntaurd'|'tmux'|'claude-bg'`); `agent-sessions.ts:383` (`consumeLaunchMarkers` keeps accepting `'tmux'` — an in-flight worker spawned by a pre-upgrade cockpit still has `SYNTAUR_HOSTED_BY=tmux` in env when its hook fires post-upgrade); `agent-sessions.ts:78` (row load passes `'tmux'` through); `session-db.ts:36,321` (`hosted_by TEXT`, no CHECK); `src/tui/cockpit/DetailPane.tsx:237` (renders `hosted: tmux`, pure display); regression tests `launch-correlation.test.ts:183,189,351,363` (prove `'tmux'` provenance round-trips — KEEP, they ARE the graceful-degradation proof); `session-db-migration-v7.test.ts`.

**Class D — comment-only:** `src/tui/claude-agents/launch.ts:25,31`, `capability.ts:13,15`, `attach.ts:17`, `src/tui/mouse/tracking.ts:12,14`, `src/tui/syntaurd/{capability.ts:23, launch.ts:132,191,196, attach.ts:8,24}`, `src/tui/launch.ts:102`, `src/launch/build-launch.ts:99`, `src/daemon/attach-client.ts:10`, `src/commands/session.ts:579`, `README.md:237` (dev-server), `docs/superpowers/{plans,specs}/2026-03-22-server-tracker*` (dev-server). **`docs/agents.md` and `docs/cli.md` contain ZERO tmux mentions** — the docs update in AC #6 is about describing the new state model / removed fallback, not scrubbing tmux text.

**Graceful degradation is structurally already satisfied:** liveness never shells to tmux. `computeIsLive` (`src/dashboard/session-liveness.ts:86-116`): status gate → `process.kill(pid, 0)` + `pid_started_at` recycle check → transcript mtime <5min → default true. Background sweep (`src/sessions/scanner.ts:256-324`) is lsof/mtime only. A `hosted_by='tmux'` row post-removal: loads, shows `hosted: tmux` in DetailPane, goes stale when its pane pid dies, and becomes non-attachable (the only thing that made it attachable was the deleted :80 gate). `feed.test.ts:331` proves persisted hosted_by surfaces with the daemon down.

**Explorer-3 risks:** (1) removing the `'tmux'` union member ripples to `Cockpit.tsx:277,282` — and the ladder change means a no-daemon + no-claude-bg + ineligible-agent launch now lands in in-process HANDOFF instead of tmux (intended UX change, call out in plan); (2) `LaunchDeps.launchInTmux` is required, so its removal touches every `deps()` in tests; (3) delete the attach gate, don't guard it — `'tmux'`/null rows must resolve `attachEnabled` → `false`, and `ActionCaps.tmuxAvailable`/`CockpitProps.tmuxAvailable`/`checkTmux` all become dead together; (4) `importOriginal` on a deleted module throws at suite load; (5) do NOT tighten `consumeLaunchMarkers` validation; (6) keep launch-correlation tmux tests; (7) name collision: `tmuxSessionExists` also exists in `scanner.ts:161` (dev-server, keep) — scope deletions to `src/tui/tmux/` + cockpit imports only.

### Hook mechanics (claude spool + codex notify) — Explorer 4

**Current claude hooks (`platforms/claude-code/hooks/hooks.json`):** registers PostToolUse (matcher `ExitPlanMode`, `type:'prompt'`), PreCompact (`type:'prompt'`), SessionStart (`type:'command'`, `command: "bash ${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh"`, `timeout: 5`), SessionEnd (`session-cleanup.sh`, `timeout: 10`). Timeouts are integers in SECONDS; matcher key is omitted entirely when unfiltered. **No Notification or PermissionRequest hook exists yet.**

**Script pattern to replicate (`platforms/claude-code/hooks/session-start.sh`):** `#!/usr/bin/env bash` + `set -o pipefail 2>/dev/null || true` (:15); `command -v jq >/dev/null 2>&1 || exit 0` (:17); `INPUT=$(cat)` + empty-check (:19-20); `syntaur_bounded()` watchdog (:28-55) — background the CLI with `<&0` explicitly forwarding stdin (backgrounded commands default stdin to /dev/null, :34-37), `( sleep "$deadline"; kill -KILL "$cpid" ) &` hard SIGKILL (stock macOS lacks `timeout`, :41), `wait` + early-reap; owning PID via `ps -o ppid= -p $$` (:77, payload has no pid); re-pipe payload `printf '%s' "$INPUT" | syntaur_bounded 4 session register --from-hook --pid "$PID"` (:85-89, 4s under the 5s budget); ALWAYS `exit 0` (:91). SessionStart stdout contract for injecting context: `{hookSpecificOutput:{hookEventName:"SessionStart", additionalContext:...}}` (:70). `session-cleanup.sh` mirrors it (parses `.cwd`/`.session_id` via `jq -r '.field // empty'`). AGENTS.md:41: `bash -n` on any touched hook script.

**CLI-side parsing (`src/commands/session.ts`):** `interface HookPayload {session_id?; transcript_path?; cwd?}` (:475-479) — exactly three fields consumed; `parseHookPayload` swallows parse errors → null (:481-489); action wrappers always exit 0 (:662-667, :742-746). `runSessionRegister` gates DB write on `session.autoTrack` config (:562-565).

**Claude hook payload evidence (on-machine cached docs, `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/plugin-dev/skills/hook-development/`):** common stdin fields for ALL hooks = `{session_id, transcript_path, cwd, permission_mode, hook_event_name}` (SKILL.md:304-311). `Notification` IS a valid event (`validate-hook-schema.sh:41` VALID_EVENTS); **`PermissionRequest` is NOT in that list** — the on-machine tooling models permission alerts as `Notification` with matchers `permission_prompt` ("Claude needs permission for a tool") and `idle_prompt` ("waiting for input 60+ seconds") per hooks-patterns.md:160-194. The docs list NO Notification-specific stdin fields (message/title unverified). The AC's "PermissionRequest hooks" therefore maps to `Notification`+`matcher:"permission_prompt"` as the evidenced mechanism, with a plan-time probe for whether current Claude Code also exposes a distinct PermissionRequest event.

**Codex:** `platforms/codex/hooks.json` registers PreToolUse (`Write|Edit|MultiEdit` → `./scripts/enforce-boundaries.sh`) + SessionEnd only — no notify entry. The notify mechanism is a **top-level `config.toml` key**, evidenced live at `~/.codex/config.toml:4`: `notify = ["<program>", "turn-ended"]` (array = program + fixed leading args) — separate from the `[hooks]` system. Session logs: `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO8601>-<uuid>.jsonl`; every line `{timestamp, type, payload}`; line 1 `type:"session_meta"` with `payload.id`/`payload.cwd` (matches `platforms/codex/scripts/resolve-session.sh:28-39`, which globs `$SESSIONS_ROOT/*/*/*/rollout-*.jsonl`); subsequent `type:"event_msg"` lines with `payload.type` discriminants (`task_started`, `user_message`, ...). `platforms/SESSION-ID-RESOLUTION.md:126-140`: Codex has no SessionStart hook and exposes no session id/pid on wired hooks — a codex notify hook likely cannot self-attribute a session from stdin unless the notify payload carries the rollout id (unverified).

**Spool/watcher precedent:** `src/tui/sessions/transcript.ts` `tailFile()` (:25-55) — byte-offset delta reads + partial-line carry + `chokidar.watch(path, {ignoreInitial: true})` single-file watch (:51); `src/dashboard/watcher.ts` — chokidar-4 directory watch, glob support removed → filter literal paths/basenames in the handler (:16,67,344 comments); `src/daemon/protocol.ts` `createLineDecoder` for junk-tolerant NDJSON parse of spool lines.

**Attribution design fact:** dispatch already carries an env map into the worker (`buildDispatchRequest` env → supervisor → pty-host child env), which every hook process inherits — the same channel `SYNTAUR_LAUNCH_ID` uses today. The daemon can therefore plant e.g. a spool-dir path or job short at dispatch time so claude hook scripts append to the right `~/.syntaur/jobs/<short>/` spool without any registry lookup.

### Phase B residuals + pending-launch reservation constraints (direct read)

**The two residuals (Phase B plan Deviations, `~/.syntaur/projects/syntaur-meta/assignments/agent-mux-cockpit-integration/plan.md`):**

1. **Hook-wins-the-race duplicate row** (plan.md:3210-3229). Both launch paths dispatch BEFORE inserting the placeholder. If a claude agent's SessionStart hook consumes the markers before that insert, `consumeLaunchMarkers` finds no placeholder, registers under claude's own id, and the later insert adds a second row. Reachable only for `resolveFromShellAliases` claude (Branch A injects `--session-id` so ids are equal and reconcile no-ops — plan.md:3216-3219; `canInjectClaudeSessionId`, `src/tui/syntaurd/launch.ts:55-57`). Self-heals: placeholder carries pty-host pid + `pid_started_at`, scanner sweeps it to `stopped` (plan.md:3220-3222). The reviewer's fix — "a new pending-launch reservation record, i.e. new schema + a new claim protocol" — was explicitly deferred to Phase C (plan.md:3222-3229).
2. **Probe-can't-prove-a-non-landing** (plan.md:3261-3273). `launchSyntaurd`'s ambiguous-dispatch recovery probes `{op:'list'}` by sessionId (`findDispatchedSession`, `src/tui/syntaurd/launch.ts:108-117`); if the daemon spawned the detached pty-host, lost the reply, and then died before the probe, the probe answers "not found" and the ladder degrades — double-launch while the orphaned host runs. Closing it "needs durable per-launch job state that survives daemon death — the same pending-launch reservation" (plan.md:3268-3270). Rejected alternative: never-degrade-when-uncertain "inverts the ladder's degrade-on-failure contract, trading a rare double-launch for a routinely silent one" (plan.md:3270-3273).

**Why insert-before-dispatch was rejected (the trap the reservation must not reintroduce)** — verbatim, `src/tui/syntaurd/launch.ts:194-198` (same text at plan.md:897-901):

```
// WHY not insert-before-dispatch: appendSession opens an engagement in the
// same txn and status is forward-only — a failed dispatch would strand an
// active row (compensating 'stopped' would then block the tmux fallback's
// re-registration of the same identity). Dispatch-first + retry has no such
// trap; the un-registered window is one poll tick.
```

Mechanics behind that: `appendSession` runs upsert + persisted-status read + `reopenEngagementIfMissing` in ONE IMMEDIATE txn (`src/dashboard/agent-sessions.ts:178-267`); status is forward-only — `'completed'` sticks, `'stopped'` only revives via `opts.reviveStopped` on live-process evidence (`agent-sessions.ts:150-154,188-192`). So a pre-dispatch `active` sessions row + failed dispatch → compensating `stopped` → the fallback tier's re-registration of the same sessionId as `active` is refused by the status CASE. **Constraint: the reservation must NOT be an `active` row in `sessions` (and must not open an engagement).** It has to be a separate record with its own lifecycle (claimable / cancellable / expirable) outside the forward-only session-status ladder.

**Current claim protocol the reservation formalizes:**

- Markers planted: `buildDispatchRequest` puts `env: {SYNTAUR_LAUNCH_ID: ctx.sessionId, SYNTAUR_HOSTED_BY: 'syntaurd'}` on the dispatch (`src/tui/syntaurd/launch.ts:41`); tmux fallback plants the same pair with `'tmux'` (`src/tui/cockpit/Cockpit.tsx:224`); native claude tier plants only `SYNTAUR_HOSTED_BY: 'claude-bg'`, deliberately no LAUNCH_ID (`src/tui/claude-agents/launch.ts:61-73`).
- Markers consumed: `consumeLaunchMarkers(realSessionId)` (`src/dashboard/agent-sessions.ts:376-385`) reads both env vars, calls `reconcileLaunchPlaceholder(launchId, realSessionId)`, validates `hostedBy` against `'syntaurd'|'tmux'|'claude-bg'` (:383). Call sites: `runSessionRegister` (`src/commands/session.ts:582`, BEFORE `appendSession` at :584) and `trackSessionCommand` (`src/commands/track-session.ts:142`).
- `reconcileLaunchPlaceholder` (`agent-sessions.ts:289-368`): migrate path re-keys `sessions` + `engagement` rows onto the real id (:322-335); merge path copies `hosted_by`/`pid` write-if-null, closes the placeholder's open engagement (`close_reason='launch-reconcile'` — partial unique index `one_active_per_session` on `ended_at IS NULL`), re-keys history, deletes the placeholder (:337-361). Never throws (:287,363-367).
- **Single-claim is currently EVIDENCE, not a FLAG** (`agent-sessions.ts:305-316`): a placeholder with non-null `transcript_path` OR `original_head_sha` is treated as already-claimed and refused — "Precision limit (accepted): this is claim EVIDENCE, not a claim FLAG; the deterministic form is the pending-launch reservation" (plan.md:3255-3259). The R3 corruption path it guards: markers persist in the worker's env for the session's life, every descendant inherits them, and `consumeLaunchMarkers` runs before `appendSession`, so a subagent's SessionStart or an in-session `track-session --session-id <other>` would re-key the LIVE parent's row (plan.md:3240-3259).
- `launchSyntaurd` full flow (`src/tui/syntaurd/launch.ts:134-229`): generate sessionId → inject `--session-id` if eligible → dispatch → three outcomes (ErrorReply = throw/degrade; rejection = probe-then-adopt-or-degrade; success) → post-dispatch `appendSession` of the placeholder row `{status:'active', hostedBy:'syntaurd', pid: reply.pid, pidStartedAt: captured}` with one bounded retry, `registered:false` on double failure (never throws after dispatch — "a throw would make runLaunch degrade to tmux and double-launch", :190-193).

**Reservation schema landing zone:** `src/dashboard/session-db.ts` — `SCHEMA_VERSION = '7'` (:12), `hosted_by TEXT` in base SCHEMA (:36). Migration pattern = table-rebuild inside one EXCLUSIVE transaction, never `ALTER TABLE ADD COLUMN`; the v6→v7 template is :297-335 (`CREATE TABLE sessions_v7 … INSERT INTO sessions_v7 SELECT … DROP TABLE sessions; ALTER TABLE sessions_v7 RENAME TO sessions; … UPDATE meta SET value = '7'`), guarded by a fresh `schema_version` read (:300-306), wrapped by `runMigrations.exclusive()` (:337). NOTE: a NEW TABLE (e.g. `launch_reservations`) needs no rebuild — only `CREATE TABLE IF NOT EXISTS` + version bump — but the version-gate + exclusive-txn shape stays. Migration test template: `src/__tests__/session-db-migration-v7.test.ts`.

**Requirements a reservation design must satisfy (derived, each traceable to the above):**

1. Written durably BEFORE dispatch (survives daemon death → answers residual 2's "did it land?"), yet is not an `active` sessions row and opens no engagement (Step 4.4 trap).
2. Deterministic single-claim: exactly one registration may claim a launchId — a claim FLAG with compare-and-swap semantics replacing the `transcript_path`/`original_head_sha` evidence heuristic (residual from R3; keep the evidence guard as belt-and-braces or retire it explicitly).
3. Closes residual 1: the hook path finding an unclaimed reservation (which now exists pre-dispatch) must produce ONE row regardless of who wins the insert race.
4. Failed/refused dispatch must cancel or expire the reservation so nothing blocks a retry of the same identity, and abandoned reservations (crash between reserve and dispatch) must not accumulate or render as ghost sessions — needs an expiry/sweep story and must stay invisible to the rail/feed until claimed.
5. The ambiguous-dispatch recovery (`launchSyntaurdInput.findSession` probe) should consult durable evidence that outlives the daemon — reservation state plus the jobs dir (state.json carries the dispatch sessionId if Explorer 1 confirms) — before degrading.
6. `'tmux'` stays valid in `consumeLaunchMarkers`' hostedBy validation (`agent-sessions.ts:383`) and in `SessionHostedBy` for pre-existing rows, even after the tmux tier is deleted (AC #6 graceful degradation).
7. Both consumers (`session.ts:582`, `track-session.ts:142`) and all planting sites route through the one claim helper, mirroring today's shared `consumeLaunchMarkers`.

## Files That Will Need Changes

### Workstream 1 — Adapters + daemon state
| File | Current Purpose | Needed Change |
|------|----------------|---------------|
| `src/daemon/adapters/` (NEW: types + claude + codex + generic + registry) | — | `AgentAdapter` interface per §3.2; three adapters; registry keyed on the free-form `agent` string with generic fallback |
| `src/daemon/types.ts` | Wire/state types | `needs?: string` on `Session`/`JobState`/`StateRecord` (:13-35,:38-52,:121-130); `HookEvent` type; keep `SessionState` as-is (:10) |
| `src/daemon/pty-host.ts` | PTY host: screen buffer, attach, rv, exit | Plaintext projection on `ScreenBuffer` (:79-101, Terminal is closure-private); `lastDataAt` in `onData` (:311-318) → `outputIdleMs`; recurring derive scheduler (the existing `scheduleQuiescentSnapshot` :105-146 is one-shot/per-attach); per-transition `writeJobState`+`appendTimeline` (today only :280-281 spawn + :418-419 exit) + rv fan-out (`rvClients` :248, today only connect :391-399 and settled :434-435); spool watcher for claude; adapter selection via `config.agent` (:162-174) |
| `src/daemon/supervisor.ts` | Roster, list, subscribe | `toSession` (:164-184) picks up `needs` from `readJobState` (disk-read per list — adapter writes surface with no other change); optionally preserve the `t:` discriminator dropped in `handleSubscribe` :539 |
| `src/daemon/paths.ts` | Runtime/jobs paths | Spool path helper under `jobDir(short)` (:83), reuse `ensureDir0700` (:153-183) |
| `src/daemon/jobs.ts` | state.json/timeline.jsonl IO | Possibly spool read helpers (atomic write :22-28 and `appendTimeline` :31-38 reused as-is) |
| `src/daemon/index.ts` | Barrel | Export adapters (+ whatever pty-host seams tests need; barrel currently omits jobs/screen internals :3-19) |
| `platforms/claude-code/hooks/hooks.json` | SessionStart/SessionEnd/PostToolUse/PreCompact | Add Notification (matchers `permission_prompt`/`idle_prompt`), Stop, and (if probe confirms it exists) PermissionRequest — command hooks with seconds-int timeouts |
| `platforms/claude-code/hooks/*.sh` (NEW spool writer[s]) | — | Append NDJSON `{event, at, fields...}` to the spool path planted in env; session-start.sh idioms; `bash -n` |
| `platforms/codex/` (notify script/config) | PreToolUse/SessionEnd hooks only | notify program (config.toml top-level `notify = [program, ...]`) writing turn-events to the spool; docs for wiring it |
| `src/daemon/__tests__/` (NEW adapter fixture tests + pty-host extensions) | harness idioms exist (`fakePty`/`fakeSocket`/`fakeScreen`/`boot`, fake timers) | Fixture-driven: captured screens + hook streams → expected states, false-positive guards |

### Workstream 2 — ⚠ end-to-end (`needs` propagation)
| File | Current Purpose | Needed Change |
|------|----------------|---------------|
| `src/tui/syntaurd/feed-source.ts` | `{op:'list'}` poll → `SyntaurdFeedEntry` (:5-13) | Add `needs` to the entry + projection (:46); update strict `toEqual` in feed-source.test.ts:11-13 |
| `src/tui/sessions/feed.ts` | joins; `applySyntaurdJoin` :145-163 never sets `waitingFor` | Stamp `needs` (decision: new `AgentSession.needs` field vs mapping into `waitingFor` — the preservation contract at :137-144 / feed.test.ts:196-208 constrains the latter) |
| `src/dashboard/types.ts` | `AgentSession` :753-770 | `needs?: string \| null` (no identifier collision repo-wide) |
| `src/tui/cockpit/railTypes.ts` | `isWaiting` :75-77, `resolveActivityText` :90-97, `liveRank` :116-120 | Consult `needs` so daemon rows get specific `⚠ <needs>` text instead of the generic `'⚠ awaiting input'` |
| Tests: `feed.test.ts`, `railTypes.test.ts`, `LeftRail.test.tsx`, `feed-source.test.ts` | existing ⚠/sort assertions | Extend for `needs` across all three agent kinds |

### Workstream 3 — tmux removal
| File | Current Purpose | Needed Change |
|------|----------------|---------------|
| `src/tui/tmux/{launch,attach}.ts` + 2 test files | tmux rung + attach | DELETE (4 files) |
| `src/tui/cockpit/actions.ts` | ladder + attach gate | Remove import :3, `ActionCaps.tmuxAvailable` :19, gate :80 → `return false`, `LaunchDeps` :136-137, `'tmux'` union member :193, rung :224-227; ladder becomes syntaurd → claude-bg → handoff |
| `src/tui/cockpit/Cockpit.tsx` | tmux wiring | Remove imports :21-22,32, prop :51/:59, :174,:185,:190, closure :216-226, status :277, provenance block :282-304, attach branch :367-390 (keep daemon guard :362-365), :398 |
| `src/commands/tui.ts` | composition root | Remove :4,:12,:20,:27,:39 (`checkTmuxAvailable` definition in scanner.ts stays) |
| Tests: `actions.test.ts` (full rewrite), `actions.test.tsx` (13 its + `caps()`), `Cockpit.test.tsx` (`vi.mock` of deleted modules :52-58 breaks suite load), `commands/__tests__/tui.test.ts` | tmux-shaped | Rewrite in the same change |
| KEEP: `dashboard/types.ts:727,730`, `agent-sessions.ts:383`, `DetailPane.tsx:237`, `launch-correlation.test.ts` tmux cases, dev-server tier (class B) | graceful degradation | No change (verify with tests) |
| `docs/agents.md`, `docs/cli.md`, research doc §4 (`claude-info/plans/2026-07-08-...-research.md:103`) | docs | Describe new state model/attention states; note tmux fallback removed (docs currently have zero tmux mentions — additive) |

### Workstream 4 — Pending-launch reservation
| File | Current Purpose | Needed Change |
|------|----------------|---------------|
| `src/dashboard/session-db.ts` | `SCHEMA_VERSION='7'` :12 | v8: new reservation table (base SCHEMA + version-gated migration in the exclusive txn; new table needs only CREATE + bump, template :297-335) |
| `src/dashboard/agent-sessions.ts` | evidence-based claim (:305-316), `consumeLaunchMarkers` :376-385, `reconcileLaunchPlaceholder` :289-368 | Deterministic claim protocol (reserve → claim-once CAS → cancel/expire); keep `'tmux'` in hostedBy validation :383 |
| `src/tui/syntaurd/launch.ts` | dispatch-first + probe (:134-229) | Reserve before dispatch (NOT a sessions row); cancel on definite refusal; ambiguous path consults reservation + durable jobs-dir state (`readAllJobStates` scans state.json which carries `sessionId`) before degrading |
| `src/commands/session.ts:582`, `src/commands/track-session.ts:142` | marker consumers | Route through the claim protocol |
| Tests: `launch-correlation.test.ts`, NEW `session-db-migration-v8.test.ts`, `syntaurd/__tests__/launch.test.ts` | v7 templates exist | Reservation lifecycle + race tests (hook-wins-race → one row; daemon-death ambiguity → no double launch; failed dispatch → retry not blocked) |

## Patterns Discovered

| Pattern | Reference File | Description |
|---------|---------------|-------------|
| Junk-tolerant NDJSON decode | `src/daemon/protocol.ts:56-86` | `createLineDecoder<T>` skips blank/unparseable lines, partial-line carry, overflow guard — reuse for spool parsing |
| Offset tail + single-file chokidar watch | `src/tui/sessions/transcript.ts:12-55` | Byte-offset delta reads + line carry + `chokidar.watch(path, {ignoreInitial:true})` — the spool tailer template |
| chokidar-4 dir watch (no globs) | `src/dashboard/watcher.ts:1,16,26,67,344` | Literal-path filtering in handlers; chokidar 4 dropped glob support |
| Injectable-deps daemon construction | `src/daemon/pty-host.ts:176-188` + `__tests__/pty-host.test.ts:200-218` | `PtyHostDeps` + `boot(over)` DI harness, `fakePty/fakeSocket/fakeScreen`, fake timers — adapter tests slot in here |
| Atomic state write | `src/daemon/jobs.ts:22-28` | tmp + `renameSync`; per-transition writes stay crash-safe |
| Disk-state read-through list | `src/daemon/supervisor.ts:164-184` | `toSession` reads `state.json` fresh per list — adapter writes surface within one poll with zero supervisor changes |
| Table-rebuild migration in exclusive txn | `src/dashboard/session-db.ts:297-337` | Version-gated, crash-atomic; v8 template |
| Write-if-null provenance | `src/dashboard/agent-sessions.ts:202-207` | `COALESCE(NULLIF(col,''), NULLIF(excluded.col,''))` — launch-time facts never clobbered |
| Claim-once guard (evidence form) | `src/dashboard/agent-sessions.ts:305-316` | The heuristic the reservation replaces with a deterministic flag |
| Bounded hook shell-out | `platforms/claude-code/hooks/session-start.sh:28-55` | `syntaur_bounded` SIGKILL watchdog + `<&0` stdin forward + always exit 0 |
| ⚠ attention rendering | `src/tui/cockpit/railTypes.ts:75-97,116-135` | `waitingFor`-first text, `isWaiting` sort rank 0, glyph/color mapping |
| State-source producing state+waitingFor | `src/sessions/agent-view.ts:111-118,184-187` | The claude `agents --json` overlay — template for a source carrying attention text |
| Screen-heuristic seam in tests | `src/daemon/__tests__/pty-host.test.ts:83-98,117-136` | `fakeScreen()` scripted snapshots AND real `createScreenBuffer` fed ANSI bytes |

## CLAUDE.md / AGENTS.md Rules Found

- Repo `AGENTS.md:35-41`: run `npm run typecheck` for TS changes; `bash -n` on any shell hook scripts touched; skills edited only at `skills/<name>/SKILL.md` then `npm run mirror-skills`; Claude plugin text lives in `platforms/claude-code/`, Codex plugin text in `platforms/codex/` (AGENTS.md:9-10,25-31).
- No CLAUDE.md files exist anywhere in the repo (verified this session: `find . -name CLAUDE.md` excluding node_modules → zero hits). `AGENTS.md` at the repo root is the standards file and has been read in full.
- User global rules: plans in `claude-info/plans` (this doc's location); tests — base tsconfig excludes `src/__tests__`, so new test files must be added to `tsconfig.tests.json` `files` and probed with `npx tsc -p tsconfig.tests.json --noEmit` (memory note + Phase B plan.md:3170-3181 confirms the blindspot is real and the gate shipped with zero exclusions).
- Fresh-worktree baseline trap (Phase B progress.md:13): unbuilt `dist/` → ~200 spurious `ERR_MODULE_NOT_FOUND` test failures; `npm run build` first.

## Questions Asked & Answers

| Question | Answer |
|----------|--------|
| (none asked interactively) | The launching agent's brief resolved scope questions up front and forbade re-asking; remaining unknowns are recorded below as plan-time verification tasks rather than user questions. |

## Open Questions / Plan-Time Verification Tasks

Unknowns that could NOT be evidenced from the repo or this machine. None require user input; each becomes a probe-with-fallback in the plan (the Phase B `claude --session-id` probe at plan.md:743 + Deviations:3141-3148 is the template — record the probe output in Deviations, branch accordingly).

1. **Claude `Notification` hook stdin body.** Common fields evidenced (`session_id, transcript_path, cwd, permission_mode, hook_event_name`); Notification-specific fields (message/title/type) are NOT documented in cached docs. Probe live (`claude --debug` hook run or official docs) before parsing beyond the 5; the spool writer can dump the whole stdin object verbatim, deferring interpretation to the adapter — that design makes this unknown non-blocking.
2. **`PermissionRequest` as a distinct event.** Named in the AC and research doc:67, but absent from the on-machine VALID_EVENTS list; permission alerts are evidenced as `Notification`+`matcher:"permission_prompt"`. Plan must register the Notification form as the guaranteed path and probe whether current Claude Code (this machine runs ≥ v2.1.205) also accepts a `PermissionRequest` event — register it additively if so.
3. **`permission_mode` enum** — docs say `ask|allow`, transcript fixture shows `bypassPermissions` (`claude-real.jsonl:4`). Treat as opaque string.
4. **Codex notify payload delivery + schema** — argv-trailing-JSON vs stdin, field names, and whether it distinguishes approval-waits from turn-end. Verify against codex docs / by instrumenting a probe notify program. Design must assume turn-end granularity only, with screen heuristics covering `blocked`.
5. **Codex session attribution** — codex exposes no session id on wired hooks; whether the notify payload carries the rollout id is part of #4. Fallback: the daemon knows the job; attribution comes from the spool path planted in the worker env, not from the payload.
6. **Codex notify config collision** — `~/.codex/config.toml:4` already has a `notify` program on this machine (single-value key, not a list). Wiring syntaur's notify must not clobber a user's existing notify; plan needs a wrapper/chaining answer and must treat notify as optional (heuristics-only degradation).
7. **`needs` carriage decision** (plan-time design, evidence in hand): new `AgentSession.needs` field consulted by railTypes vs. `applySyntaurdJoin` mapping `needs`→`waitingFor` (zero rail changes but amends the join-preservation contract asserted at feed.test.ts:196-208).
8. **Latency budget check**: AC #2 "within one poll cycle" = cockpit's `SESSION_POLL_INTERVAL_MS = 1500` (Cockpit.tsx:35) on top of feed-source's 1000ms list timeout; spool-watch → derive → `writeJobState` must complete well inside that. chokidar watch latency on a single dir is ms-scale — verify in the daemon integration test with real fs events, not fake timers.
9. **Old-row sweep**: confirm with a test that a pre-existing `hosted_by='tmux'` active row whose pid is dead goes stale via `computeIsLive` (`session-liveness.ts:86-116`) and renders without any tmux code present (structurally guaranteed, cheap to prove).

## Reflection (post-exploration)

1. **Understanding:** complete across all five focus areas; every seam has verbatim signatures + line anchors. The three adapter kinds have concrete, evidenced input sources: claude = spool NDJSON via env-planted path; codex = notify (turn-end only) + rollout JSONL + screen; generic = plaintext screen + `outputIdleMs` + exitCode.
2. **Gaps found and disposition:** (a) no plaintext screen projection exists — `createScreenBuffer` must expose one (identified precisely, Terminal is closure-private); (b) no `lastDataAt`/idle timer exists — net-new in `onData`; (c) no mid-life state broadcast — net-new fan-out + per-transition writes; (d) hook payload unknowns — converted to probe-with-fallback plan tasks (Open Questions 1-6), never assumptions; (e) `handleSubscribe` drops `t:` — but list-polling is the cockpit's actual transport, so fixing it is optional hardening, not on the AC critical path.
3. **Patterns to follow:** table above; the strongest constraints are the migration template, the write-if-null provenance idiom, the bounded-hook-script idiom, and the PtyHostDeps DI harness.
4. **Complexity confirmed: large** — 4 workstreams, ~25 files edited + ~6 new modules + 4 deletions, one schema migration, cross-cutting daemon↔TUI↔DB↔platform-hooks changes.
5. **No user questions required:** scope was fixed by the launching brief; all residual unknowns are machine-verifiable probes.

## Exploration Log

| Explorer | Focus Area | Key Findings |
|----------|-----------|--------------|
| Explorer 1 | Daemon seams (pty-host/supervisor/jobs/types/paths/protocol/liveness) | `snapshot()` is ANSI-only, Terminal closure-private → plaintext projection is net-new; no lastDataAt/idle timer; only 2 rv emissions + 2 writeJobState calls exist (spawn `working`, exit settled); `toSession` re-reads state.json per list → adapter writes surface with zero supervisor changes; agent kind is a free-form string via `req.agent ?? inferAgent(argv)`; barrel omits the internals adapters need |
| Explorer 2 | Cockpit ⚠ path end-to-end (feed-source → feed join → railTypes → Cockpit) | `SyntaurdFeedEntry` lacks needs; `applySyntaurdJoin` never sets `waitingFor` (only `applyNativeJoin` does); blocked daemon rows already light generic `⚠ awaiting input` + sort to top — the specific-text branch is unreachable for them; 1.5s poll; strict-shape test at feed-source.test.ts:11-13; no `needs` identifier collision |
| Explorer 3 | tmux inventory A/B/C/D classification + graceful degradation | Two disjoint tmux subsystems; complete A-list with line anchors (4 deletions + actions/Cockpit/tui.ts edits + 4 test files); liveness never shells to tmux → old rows degrade structurally; keep `'tmux'` in types + marker validation + launch-correlation tests; ladder change means ex-tmux launches now land in handoff; `vi.mock` of deleted modules breaks suite load |
| Explorer 4 | Claude hooks + codex notify mechanics | hooks.json shape + seconds timeouts; session-start.sh watchdog idioms; HookPayload = 3 fields; Notification valid with `permission_prompt`/`idle_prompt` matchers, PermissionRequest NOT in on-machine VALID_EVENTS; codex notify = top-level config.toml array, payload schema unverified; rollout JSONL path/shape evidenced; spool watcher precedents (transcript tailFile, dashboard watcher, createLineDecoder) |
| (direct) | Phase B Deviations, reservation constraints, session-db v7 template, marker claim protocol | Both residuals + exact insert-before-dispatch trap quoted; 7 reservation requirements derived; v8 migration path; claim protocol call sites and plant sites enumerated |
