# Agent Multiplexer Phase B — Cockpit Integration — Discovery Findings

## Metadata
- **Date:** 2026-07-15
- **Complexity:** large
- **Tech Stack:** TypeScript (ESM, Node >=20), Ink 7 + React 19 TUI, commander CLI, better-sqlite3, node-pty + @xterm/headless + @xterm/addon-serialize, vitest + ink-testing-library, tsup build

## Objective
Route the Ink cockpit's browse → launch → monitor → attach loop through the Phase-A syntaur daemon for ALL agents, demoting tmux to a transitional fallback, with the session feed joining daemon subscribe state alongside session-db.

## User's Request
Phase B of the agent multiplexer (design doc: `claude-info/plans/2026-07-08-agent-multiplexer-research.md`, §3.3 attach flow, §5 reuse map, §6 Phase B). Acceptance criteria:

1. Cockpit Launch dispatches via the daemon (reusing buildLaunchPlan cwd/context.json/prompt resolution); the cockpit stays resident and the new session appears in the rail via the feed join.
2. Cockpit Attach uses socket attach wrapped in the existing runWithMouseSuspended + suspendTerminal sandwich; works with no tmux installed at all; detach returns to the cockpit cleanly.
3. sessions/feed.ts consumes daemon subscribe state alongside session-db; daemon truth (working/blocked/done/failed/stopped) overrides pid-based liveness when present; degradation to session-db-only when the daemon is down never crashes the poll loop.
4. tmux path used only when the daemon is unavailable or a session predates it; the hosting backend is recorded per session row and visible in the UI.
5. Claude sessions living in Claude Code's own daemon (claude agents --json join from cockpit v2) still surface read-only alongside syntaurd sessions — two sources, one feed.
6. Tests per v2 patterns: launch argv dispatch (seam, no spawn), feed join precedence + degradation fixtures, component smoke with mocked feed.

## Codebase Overview

The cockpit (`src/tui/cockpit/Cockpit.tsx`) is a resident Ink app: capability booleans (`tmuxAvailable`, `claudeBgAvailable`) are probed once at startup in `src/commands/tui.ts` and passed as props; the rail is fed by a 1.5s `loadSessions` poll; Launch runs a pure degradation ladder (`runLaunch` in `actions.ts`: claude-bg → tmux → handoff) over injected deps; Attach routes native-first (`isNativeAttachReachable`) and wraps either `runClaudeAttach` or `runTmuxAttach` in the `runWithMouseSuspended(write, () => suspendTerminal(...))` sandwich, classifying results as `ChildOutcome` via `isCleanExit`.

The feed (`src/tui/sessions/feed.ts`) bases rows on session-db (`listAllSessions`), enriches with pid liveness, then overlays a `claude agents --json` join keyed by `sessionId` — matched rows get `state/waitingFor/agentShortId/launcher:'claude-bg'` stamped per poll (nothing persisted), with null-vs-[] source semantics and a ≤1-poll grace cache for probe failures.

The Phase-A daemon exposes an NDJSON control socket (`dispatch/list/kill/attach/resize/subscribe/status/stop`), per-session pty (`pty/<short>.sock`) and rendezvous (`rv/<short>.sock`) sockets. `src/daemon/client.ts` provides one-shot `ensureDaemon`/`sendRequest`/`daemonRequest` (ensureDaemon AUTO-SPAWNS the daemon on miss); `src/daemon/attach-client.ts` provides the never-rejecting, terminal-restore-first `runAttachClient`. Subscribe is per-session only, relayed from the rv socket with the `state`/`settled` discriminator dropped; there is no whole-daemon stream — a whole-rail view must poll `list`. The daemon Session carries a reserved `sessionId` join key, populated only when the dispatcher supplies it.

The claude-agents tier (`src/tui/claude-agents/{capability,launch,attach}.ts`) is the architectural template for the new syntaurd tier: cached never-reject capability probe, pure eligibility + argv injection + thin exec dispatcher, never-reject attach wrapper, optional `LaunchDeps` fields, composition-root wiring in `tui.ts`.

Design-doc grounding (read directly):
- §3.3: attach = connect to `pty/<short>.sock` with {cols, rows} → host resizes PTY+emulator → SIGWINCH repaint → serialized snapshot → raw byte pipe; detach = socket close. Cockpit suspends Ink via the existing runWithMouseSuspended sandwich "verbatim" and becomes a dumb pipe.
- §5 reuse map: buildLaunchPlan output IS the dispatch payload; feed.ts + session-db stay the durable registry with daemon subscribe becoming the primary source; `claude agents --json` join stays for Claude's-own-daemon sessions; tmux launch/attach isolated behind tmux/launch.ts + tmux/attach.ts as the fallback; transcript-render unchanged.
- §6 Phase B scope: "Launch/Attach route through the daemon for all agents; feed subscribes; tmux demoted to fallback."
- §7: two-Claude-worlds recommendation — launch Claude under syntaurd for uniformity; agents --json join covers the other world read-only.

## Files That Will Need Changes
(refined from scout list with explorer evidence; all paths relative to repo root)

| File | Current Purpose | Needed Change |
|------|----------------|---------------|
| `src/tui/cockpit/Cockpit.tsx` | Resident loop; handleLaunch (`:153-223`), handleAttach (`:228-276`), 1.5s poll (`:95-116`) | Thread syntaurd capability + dispatch dep into runLaunch call; add syntaurd attach branch inside the sandwich; status strings for the new mode |
| `src/tui/cockpit/actions.ts` | Pure ladder `runLaunch` (`:149-177`), `LaunchDeps` (`:110-125`), `isNativeAttachReachable` (`:34-36`), `attachEnabled` (`:49-56`) | New optional deps (`syntaurdAvailable?`, `launchSyntaurd?`, `onSyntaurdLaunchFailure?`) + tier ahead of tmux with claude-bg-style try/catch; new return mode; attach routing/gating for daemon-hosted sessions |
| **NEW** `src/tui/syntaurd/` (capability.ts, launch.ts, attach.ts — mirror of `src/tui/claude-agents/`) | — | Cached never-reject `checkSyntaurdAvailable` probe; dispatch wrapper mapping `AgentLaunchPlan` → `{op:'dispatch', argv:[command,...args], cwd, name, agent?, sessionId?}`; attach wrapper honoring the never-reject `{code, error?}` contract |
| `src/tui/sessions/feed.ts` | `loadSessions` (`:72`), agent-view join (`:80-98`), grace cache (`:29-70`) | Add daemon session source joined by sessionId; daemon state overrides pid liveness (same precedence pattern as agent-view join); null-vs-[] + grace degradation; never auto-spawn the daemon from the poll |
| `src/daemon/client.ts` (or new sibling module) | One-shot `ensureDaemon`/`sendRequest`/`daemonRequest` | Non-spawning list/status source for the feed (resolveDaemon probe without ensureDaemon), and/or a dedicated streaming subscribe client (never-reject, persistent decoder) if per-session streaming is chosen |
| `src/daemon/attach-client.ts` | `runAttachClient` never-rejects, restore-first (`:96`) | Likely unchanged; consumed via wrapper/adapter (open question: in-process vs `syntaur attach` child) |
| `src/dashboard/session-db.ts` | Schema v6 + EXCLUSIVE-txn migrations (`:77-292`) | If persistence chosen: v7 `hosted_by TEXT` migration cloning v4→v5 add-column pattern + fresh-install SCHEMA_SQL + `SCHEMA_VERSION='7'` |
| `src/dashboard/agent-sessions.ts` | `SessionRow` (`:16-35`), `SESSION_SELECT_WITH_BINDING`, `rowToSession`, `appendSession` upsert (`:152`) | If persistence chosen: carry `hosted_by` through row type/mappers/upsert; possibly pre-insert session rows at dispatch (see Open Questions) |
| `src/dashboard/types.ts` | `SessionLauncher = 'claude-bg' \| 'tmux' \| null` (`:726-727`), `AgentSession` overlay fields (`:729-760`) | Extend `SessionLauncher` (e.g. `'syntaurd'`); possibly a persisted `hostedBy` field distinct from the per-poll `launcher` |
| `src/tui/cockpit/railTypes.ts`, `DetailPane.tsx`, `LeftRail.tsx` | Rail rows consume `AgentSessionWithLiveness`; `RailSessionRow` (`railTypes.ts:36-60`) | Surface hosting backend in UI (AC #4) |
| `src/commands/tui.ts` | Startup probes → `CockpitRenderProps` (`:8-27`) | Add `checkSyntaurd` dep + prop threading |
| `src/tui/tmux/launch.ts`, `src/tui/tmux/attach.ts` | tmux tier | Unchanged internally; demoted to fallback |
| `tsconfig.tests.json` | Type-aware test probe; `files` array (`:24-48`) currently lists daemon tests only | Add every new/changed test file to `files` |
| Tests: `src/tui/cockpit/__tests__/Cockpit.test.tsx`, `actions.test.ts`, `src/tui/sessions/__tests__/feed.test.ts`, `src/daemon/__tests__/*`, new `src/tui/syntaurd/__tests__/` | v2 suites | Ladder-order tests for the daemon tier; feed join precedence + degradation fixtures; component smoke with mocked feed; subscribe/list client tests via fake sockets |

## Patterns Discovered

### Launch flow (verified, Explorer 1)

`Cockpit.tsx` props (`:39-44`): `{ projectsDir, assignmentsDir, tmuxAvailable, claudeBgAvailable }` — capability booleans probed ONCE at startup in `src/commands/tui.ts` and threaded in; the cockpit never re-probes. Terminal handles: `const { exit, suspendTerminal } = useApp()` (Ink's own suspend) and `const { write } = useStdout()`.

`handleLaunch()` (`Cockpit.tsx:153-223`): guard `selection.kind === 'assignment' && projectSlug != null` → default agent → `buildLaunchPlan({projectsDir, projectSlug, assignmentSlug, agent})` → `tmuxSessionName(...)` + `nativeName = \`${projectSlug}/${assignmentSlug}\`` → `runLaunch(sessionName, plan, deps, { agent, name: nativeName })` → status line per mode.

`runLaunch` (`src/tui/cockpit/actions.ts:149-177`), verbatim ladder **claude-bg → tmux → handoff**:
```ts
export async function runLaunch(
  sessionName: string,
  plan: LaunchExecPlan,
  deps: LaunchDeps,
  native?: NativeLaunchInput,
): Promise<'claude-bg' | 'tmux' | 'handoff'> {
  if (
    native &&
    deps.claudeBgAvailable &&
    deps.launchClaudeBg &&
    resolveRunner(native.agent) === 'claude' &&
    isNativeLaunchEligible(native.agent, plan.args)
  ) {
    try {
      await deps.launchClaudeBg({ plan, name: native.name });
      return 'claude-bg';
    } catch (err) {
      deps.onNativeLaunchFailure?.(err);
    }
  }
  if (deps.tmuxAvailable) {
    await deps.launchInTmux({ sessionName, cwd: plan.cwd, command: plan.command, args: plan.args });
    return 'tmux';
  }
  await deps.handOff(plan);
  return 'handoff';
}
```
`LaunchDeps` (`actions.ts:110-125`): `{ tmuxAvailable, launchInTmux, handOff, claudeBgAvailable?, launchClaudeBg?, onNativeLaunchFailure? }`. `NativeLaunchInput` (`:128-132`): `{ agent: AgentConfig; name: string }`. `LaunchExecPlan` (`:108`) = alias of `AgentLaunchPlan`. Note: only the claude-bg branch has try/catch + fall-through; tmux branch does not — a daemon tier needs the same catch-and-degrade wrapping since `ensureDaemon` can throw `SyntaurError` on start timeout.

`buildLaunchPlan` (`src/launch/build-launch.ts:111-117`): `(input: { projectsDir; projectSlug; assignmentSlug; agent: AgentConfig; cwdOverride? }) => Promise<AgentLaunchPlan>` where `AgentLaunchPlan = { command: string; args: string[]; cwd: string }` (`:89-93`). Resolves worktree cwd (never silently falls back to process.cwd()), writes `.syntaur/context.json` workspace marker, resolves launch prompt, builds argv via `buildAgentArgv`. Throws, never process.exit.

**Residency:** claude-bg and tmux tiers are non-blocking (execFile returns immediately); the new session appears on the next 1.5s poll (`SESSION_POLL_INTERVAL_MS = 1500`, `Cockpit.tsx:26`; poll effect `:95-116` with `.catch(() => {/* keep last-known */})`). Only the handoff tier suspends and, on clean exit, calls `exit()`. A daemon dispatch tier fits the resident model naturally.

### Attach flow (verified, Explorer 1)

`handleAttach()` (`Cockpit.tsx:228-276`): native-first routing via `isNativeAttachReachable(session)` (`actions.ts:34-36`):
```ts
return session.agentShortId != null && session.state != null && !NATIVE_TERMINAL_STATES.has(session.state);
```
(`NATIVE_TERMINAL_STATES = new Set(['done','failed','stopped'])`, `:24`.) Both paths use the identical sandwich, capturing the result in an outer closure because neither helper propagates return values:
```ts
let result: ChildOutcome = { code: null };
await runWithMouseSuspended(write, () =>
  suspendTerminal(async () => { result = await runClaudeAttach(session.agentShortId as string); }),
);
```
Classified via `isCleanExit(result, { allowNullCode: true })`. Tmux path additionally gates on `tmuxAvailable && assignmentSlug != null` + `tmuxSessionExists`. `attachEnabled` (`actions.ts:49-56`) prefers native when `agentShortId != null && state != null`, else tmux gate (`caps.tmuxAvailable && isLive === true && assignmentSlug != null`).

`runWithMouseSuspended` (`src/tui/mouse/tracking.ts:18-28`): `disableMouseTracking(write)` → `await suspend()` → `enableMouseTracking(write)` in a `finally`. Value-discarding, hence the closure-capture idiom. There is no `src/tui/util/terminal.ts` — `suspendTerminal` comes from Ink's `useApp()`.

`ChildOutcome` (`actions.ts:186-222`): `{ code: number | null; error?: Error }` with `isCleanExit(outcome, opts?)` / `describeChildFailure(outcome, command?)`.

**Attach shape mismatch (the big integration friction):** `runAttachClient` (`src/daemon/attach-client.ts:96`) seizes process.stdin/stdout directly (raw mode, own data/signal listeners, NDJSON framing, Ctrl-] detach, RESET_SEQUENCES restore) and returns `AttachResult { reason: 'exit'|'detach'|'socket-closed'|'connect-failed'|'signal'; code; signal; detached; error? }` — NOT `ChildOutcome`, and no child process. Wiring it inside Ink's `suspendTerminal` + mouse sandwich needs an `AttachResult → ChildOutcome`-compatible adapter and care about raw-mode/stdin ownership between Ink, suspendTerminal, and runAttachClient.

### Daemon dispatch reference (verified, Explorer 1)

`src/commands/bg.ts:28-35` — the call to mirror:
```ts
const reply = (await daemonRequest({
  op: 'dispatch', argv, cwd: process.cwd(), name: opts.name,
  cols: Number(opts.cols) || 80, rows: Number(opts.rows) || 24,
})) as DispatchReply | ErrorReply;
```
`argv` is one flat `string[]` — a daemon tier maps `buildLaunchPlan` output as `argv: [plan.command, ...plan.args]`, `cwd: plan.cwd`. bg.ts does NOT set the optional `env`/`agent`/`sessionId` dispatch fields; `agent` + `sessionId` matter for the Phase B feed join.

`src/commands/attach.ts:11-36` — CLI attach wiring: `cols = process.stdout.columns ?? 80`, `rows = process.stdout.rows ?? 24`; deps `{ attachOp: (s,c,r) => daemonRequest({op:'attach',...}), connectPty: (sock) => connect(sock) }`. No explicit TTY check; `ensureDaemon` runs transitively inside `daemonRequest`. `connect-failed` → throws SyntaurError; `exit` → prints exit code; else "detached". No process.exit — errors flow through runCommand.

### Fallback tier signatures (unchanged, demoted; Explorer 1)

- `src/tui/tmux/launch.ts`: `tmuxSessionName(projectSlug, assignmentSlug)` (`:13`), `buildTmuxLaunchArgv(input)` (`:26`), `launchInTmux(input): Promise<void>` (`:30`, detached), `tmuxSessionExists(sessionName, exec?)` (`:34`).
- `src/tui/tmux/attach.ts`: `buildTmuxAttachArgv` (`:3`), `runTmuxAttach(sessionName, spawnFn?): Promise<TmuxAttachResult>` (`:22`, stdio:'inherit', never rejects; `TmuxAttachResult = { code: number|null; error?: Error }`).
- `src/tui/claude-agents/launch.ts`: `isNativeLaunchEligible(agent, args)` (`:29`, false for shell-alias or -p/--print), `injectBgArgs(args, name)` (`:42` → `['--bg','--name',name,...args]`), `launchClaudeBg(input): Promise<void>` (`:53`, execFile in plan.cwd).
- `src/tui/claude-agents/attach.ts`: `buildClaudeAttachArgv(shortId)` (`:3` → `['attach', shortId]`), `runClaudeAttach(shortId, spawnFn?)` (`:23`, stdio:'inherit', never rejects).
- Capability probes: `checkTmuxAvailable` (`src/dashboard/scanner.ts:154`, cached `which tmux`), `checkClaudeBgAvailable(probe?)` (`src/tui/claude-agents/capability.ts:18`, cached `claude agents --json` probe, 5s timeout, never rejects). `tuiCommand` (`src/commands/tui.ts:29-43`) awaits both into props via `buildTuiRenderProps` and renders with `{ alternateScreen: true }`.

### Integration frictions inventory (Explorer 1)

1. `runLaunch` purity — daemon dispatch must be an injected dep (e.g. `dispatchDaemon?`, `daemonAvailable?`), not imported, to keep the pure-ladder unit tests.
2. Error-handling asymmetry — daemon tier needs claude-bg-style try/catch + failure callback, else a SyntaurError aborts instead of degrading to tmux.
3. Payload mapping — `{command,args,cwd}` → `{argv:[command,...args], cwd, name, cols?, rows?, agent?, sessionId?}`.
4. Attach shape mismatch — AttachResult vs ChildOutcome adapter + stdin/raw-mode ownership (above).
5. Visibility gap — no daemon→feed join exists; a daemon-launched session today would never light up Attach (`agentShortId`/`state` null, tmux gate needs isLive+assignmentSlug). Feed work is prerequisite to attach routing.
6. `launcher` routing signal exists (`SessionLauncher`) but is unused by `handleAttach` (routes off `agentShortId`+`state`); a daemon tier wants a new launcher value (e.g. `'daemon'`/`'syntaurd'`), feed population, and a third attach branch.

### Daemon client API (verified, Explorer 3)

`src/daemon/client.ts`:
- `ensureDaemon(deps: ClientDeps = {}): Promise<CurrentPointer>` (`:113`) — resolves live daemon via `resolveDaemon(currentPointerPath(), ...)` (connect-probes `current.json`'s controlSock); on miss spawns detached `[cliEntryPath, 'daemon', 'run']` (macOS: wrapped `launchctl asuser <uid>` if probe succeeds), polls `waitForDaemon` (5000ms/100ms bounds), throws `SyntaurError` with remediation on timeout.
- `sendRequest(controlSock: string, req: ControlRequest, timeoutMs = 5000): Promise<ControlReply>` (`:134`) — ONE-SHOT by construction: writes one frame on connect, resolves the FIRST decoded frame, and `finish()` calls `socket.destroy()` immediately (`:176`, `:143-153`). Its docstring: "subscribe streams — use a dedicated path for it, not this."
- `daemonRequest(req: ControlRequest, deps: ClientDeps = {}): Promise<ControlReply>` (`:183`) — `ensureDaemon` + `sendRequest` composed.
- `ClientDeps` (`:33-48`) injects `now, sleep, probe, readFile, spawn, exec, sendRequest, execPath, cliEntryPath, platform, uid, launchctlTimeoutMs, waitTimeoutMs, waitIntervalMs` — every OS/timing touch.
- Paths (`src/daemon/paths.ts`): runtime base = `SYNTAUR_RUNTIME_DIR` else `/tmp/syntaur-<uid>`; `controlSockPath(daemonId)`, `ptySockPath(daemonId, short)`, `rvSockPath(...)`; roster at base (survives daemon restart); jobs under `syntaurRoot()` (honors `SYNTAUR_HOME`). `guardSunPath` throws >100 bytes; `ensureDir0700` fail-closes.

### Attach client (verified, Explorer 3)

`runAttachClient(opts: AttachOptions, deps: AttachDeps): Promise<AttachResult>` (`src/daemon/attach-client.ts:96`).
- `AttachOptions` (`:61-65`): `{ short, cols, rows }`. `AttachDeps` (`:67-78`): required `attachOp: (short, cols, rows) => Promise<AttachReply | ErrorReply>` + `connectPty: (sock) => AttachSocket`; optional `stdin, stdout, signals, captureStty, restoreStty, setRawMode, getSize, resizeDebounceMs` — ALL terminal touches injectable (defaults bind process.stdin/stdout).
- Never rejects: single `settle(result)` exit path (`:165-171`) that runs `restore()` FIRST then resolves; attachOp throw → `settle({reason:'connect-failed'})`; decoder throw inside data handler caught → settle.
- `restore()` (`:118-163`, idempotent): clear resize timer → detach signals → remove stdin listener → `setRawMode(false)` → `restoreStty(saved stty -g)` → write `RESET_SEQUENCES` (mouse off, bracketed paste off, leave alt-screen, show cursor) → `stdin.pause()` → `socket.destroy()`.
- Ctrl-] (`0x1d`) in-band detach (`:190-203`, forwards bytes typed before it); `SIGINT/SIGTERM/SIGHUP` out-of-band detach; `SIGWINCH` → debounced (50ms) `{t:'resize'}` frame.
- `AttachResult` (`:25-32`): `{ reason: 'exit'|'detach'|'socket-closed'|'connect-failed'|'signal'; code; signal; detached; error? }`.

### Subscribe wire protocol (verified, Explorer 3)

Two hops. Pty-host rv socket emits `RvFrame`s: on connect `{ t:'state', record: <StateRecord working> }` (`pty-host.ts:391-399`); at child exit exactly one `{ t:'settled', record: <state done|failed|stopped, exitCode, exitSignal> }` (`finalizeExit`, `:434-441`). **No intermediate patch frames in Phase A.** The supervisor's `handleSubscribe(socket, req)` (`supervisor.ts:512-544`) relays: ack `{ ok: true }` (or `{ ok:false, code:'ENOSESSION', ... }` + close), then re-wraps every rv frame as `{ ok: true, record }` (`SubscribeStateReply`) — **the t:'state'/'settled' discriminator is dropped**; terminality must be inferred from `record.state ∈ {done,failed,stopped}` / `exitCode`.

Protocol facts that shape Phase B:
- **Subscribe scope is ONE session** (`{ op:'subscribe'; short }`). There is NO whole-daemon session-list stream — watching all sessions means polling `{op:'list'}` (`supervisor.ts:265-267`, → `{ ok:true, sessions: Session[] }`) or `{op:'status'}`, optionally + per-short subscribe fan-out (N sockets).
- Multiple subscribers per session supported (own rv connection each; teardown on close is leak-safe).
- `sendRequest` cannot drive subscribe (destroys socket on first frame — would capture only the ack). A streaming client is a NEW dedicated path: keep socket open, persistent `createLineDecoder`, distinguish ack from data frames, settle-style never-reject lifecycle mirroring attach-client.
- pty-host produces only `working` + terminal states via `toState(exitCode, signal)` (`pty-host.ts:209-212`: signal → 'stopped', code 0 → 'done', else 'failed'). **`'blocked'` is declared but NEVER produced in Phase A** (adapters are Phase C) — yet `actions.ts:29-30` already treats blocked as attach-reachable, so precedence logic should handle it.
- `sessionId` populated at dispatch time iff the caller supplies it (`supervisor.ts:252`, passed as `--session-id` to pty-host argv `:224`, recorded in JobState `pty-host.ts:267`); never derived later.

### The claude-agents tier — template checklist for the syntaurd tier (verified, Explorer 3)

1. **Capability probe** — `checkClaudeBgAvailable(probe = defaultProbe)` (`capability.ts:18`): module-level `cache: Promise<boolean> | null`, `probe().then(() => true).catch(() => false)`, test-only `resetClaudeBgAvailableCache()` (`:26`). → syntaurd needs `checkSyntaurdAvailable(probe)` + reset hook, same caching.
2. **Launch dispatcher** — `isNativeLaunchEligible` (pure, static argv/config checks), `injectBgArgs` (pure argv injection), `launchClaudeBg({plan, name, exec?})` (thin exec in plan.cwd). → syntaurd equivalent is a thin dispatch via `daemonRequest({op:'dispatch', argv:[plan.command,...plan.args], cwd:plan.cwd, name, agent?, sessionId?, cols?, rows?})`, injected as a dep.
3. **Attach wrapper** — `runClaudeAttach(shortId, spawnFn?)`: stdio:'inherit' child, never rejects, `{ code, error? }` shape "mirrors runTmuxAttach's never-reject contract exactly". → syntaurd choice: same-shaped wrapper spawning `syntaur attach <short>` as a child, OR in-process `runAttachClient` with an adapter (see Open Questions).
4. **Cockpit sandwich wiring** — new reachable-check + `handleAttach` branch inside the identical `runWithMouseSuspended(write, () => suspendTerminal(...))` sandwich.
5. **Ladder slot** — new optional `LaunchDeps` fields (`syntaurdAvailable?`, `launchSyntaurd?`, `onSyntaurdLaunchFailure?`) + new return-mode string, catch-and-degrade like the claude-bg branch; optional fields keep existing call sites unchanged.
6. **Composition root** — `src/commands/tui.ts` `buildTuiRenderProps` gains a `checkSyntaurd` dep → new `CockpitRenderProps` boolean threaded to `buildActions`/`runLaunch`.
7. **Degradation ethos** — every tier module never throws: probe → false, launch error → caught + fall through, attach error → `{code:null,error}`. Keeps the cockpit resident and everything unit-testable without real spawns.

## Test Patterns & Standards (verified, Explorer 4)

### Commands & config
- `npm run typecheck` = `tsc --noEmit` (source only), `npm test` = `vitest run`, single file: `npx vitest run <path>`. No lint script/config exists.
- **tsconfig.json:20 excludes all test files** — `tsc --noEmit` never sees them, and vitest strips types unchecked. The type-aware probe is `tsconfig.tests.json` (NOT wired to any npm script): re-lists source via `include`, force-adds specific test files via a `files` array (`tsconfig.tests.json:24-48`). Daemon tests are already listed; `src/tui/**` tests are NOT. **A new test file must be added to `files` and checked with `npx tsc -p tsconfig.tests.json --noEmit`.** Its header says "Widen `files` when a change touches other test files" (deliberately scoped — the rest of the test tree has pre-existing type errors).
- vitest.config.ts: include = `src/__tests__/**/*.test.ts`, `src/**/__tests__/**/*.test.ts(x)`; `environment: 'node'` (even Ink .tsx tests); `testTimeout: 30000`; JSX via esbuild (`react-jsx`), no jsdom, no plugin-react in test config.
- ESM: ALL local imports and `vi.mock()` paths use explicit `.js` suffixes (moduleResolution NodeNext).
- No shared test-helper module exists — target tests are self-contained with inline factories (`session()`, `entry()`, `deps()`, `harness()`); copy per-file.

### Cockpit.test.tsx pattern (`src/tui/cockpit/__tests__/Cockpit.test.tsx`)
- `vi.hoisted` mutable mock boxes (`:21-34`): vi.fn()s + mutable state boxes (`sessionLive: { value: true }`, `sessionNative: { agentShortId, state }`) that `vi.mock` factories close over — tests flip behavior per-poll.
- `vi.mock('../../sessions/feed.js', ...)` (`:61-78`): `loadSessions` replaced by async fn returning one fixed session re-reading the hoisted boxes each poll. `../../tmux/launch.js` mocked with `importOriginal` spread (override only `tmuxSessionExists`); tmux/claude attach + build-launch fully replaced with hoisted fns.
- Capability props faked as plain booleans on `<Cockpit ... tmuxAvailable={...} claudeBgAvailable={...} />`.
- REAL timers (no fake timers in this file). `WAIT_TIMEOUT = 45000` on every `vi.waitFor`; poll interval crossed via `await new Promise(r => setTimeout(r, 2500))`. Idempotent inputs (SGR mouse click `'\x1b[<0;COL;ROWM'`, 'a'/'l'/'q' keys) re-sent inside `vi.waitFor`; non-idempotent (Tab, down-arrow) sent once with 200ms settles. Per-test timeout bumped to 90000. Manual `unmount()` each test. Handoff block uses `mkdtemp` + real project.md/assignment.md frontmatter fixtures.

### actions.test.ts pattern (pure ladder tests)
- No vi.mock, no timers. Module fixtures `plan = { command:'claude', args:['hi'], cwd:'/x' }` + agent configs; `deps(overrides)` factory returning vi.fn()s for every side effect (`actions.test.ts:27-36`). Assertions: returned mode string + `toHaveBeenCalledWith`/`not.toHaveBeenCalled()` on sibling deps; error-path fixture injects a throwing `launchClaudeBg` + `onNativeLaunchFailure` spy. Ineligibility fixtures: `--print` args, shell-alias agent, non-claude agent.
- `actions.test.tsx` companion: pure `buildActions` unit tests + a tiny `KeyHarness` Ink component (`useInput` → `dispatchActionKey`) for keypress routing, no async.

### feed.test.ts pattern
- REAL sqlite in tmpdir: `beforeEach`: `resetSessionDb(); resetAgentViewGrace(); dir = mkdtempSync(...); initSessionDb(resolve(dir,'syntaur.db'))`; `afterEach`: `closeSessionDb(); rmSync(dir, {recursive, force})`. Rows seeded via raw SQL `INSERT INTO sessions ...`.
- Seams: `livenessDeps: { isPidAlive, pidStartedAt }` + `agentViewDetailSource`. Semantics asserted: `async () => []` = validly empty (clears overlay immediately); `async () => null` = probe failure with ≤1-poll grace (canonical 3-poll fixture at `feed.test.ts:102-119` — poll1 good, poll2 null reuses cache, poll3 null degrades); throwing source never crashes. Polling simulated by calling `loadSessions` N times — no timers.
- Join precedence fixtures (`:50-88`): matched entry stamps state/waitingFor/agentShortId/activity/launcher; native `'done'` overrides pid-alive liveness; unmatched sessionId untouched.
- Mandatory singleton resets: `resetSessionDb`, `resetAgentViewGrace` (module-level caches leak across tests otherwise).

### Daemon test patterns (`src/daemon/__tests__/`)
- Env-redirect idiom: save/restore `SYNTAUR_HOME` (state/jobs root) and `SYNTAUR_RUNTIME_DIR` (socket root) around a `mkdtemp` tmpdir (roster.test.ts:175-187, supervisor.test.ts:62-77, pty-host.test.ts:185-196). pty-host tests use `vi.useFakeTimers()` (restored via `vi.useRealTimers()` in afterEach) — unlike TUI tests.
- Fake-socket idiom (sockets.test.ts:15-65): hand-rolled net.Server stand-in + `harness({ pathExists, servers, probes })` injecting `bindUnixSocket` deps; real-socket describes keep an `open: Server[]` closed in afterEach.
- NDJSON idiom: `encodeFrame(obj)` / `createLineDecoder().push(chunk)`; real-socket round trip in client.test.ts:128-148 (server decodes inbound frames, writes reply frame, `sendRequest` asserted). Injected-deps daemon-spawn: `fakeSpawn()` + `baseDarwin(over)` builder supplying `{ readFile, platform, uid, execPath, cliEntryPath, now, sleep }` — virtual clock via now/sleep, zero real processes.

## CLAUDE.md Rules Found
- **No CLAUDE.md files exist anywhere in the repo** (verified: repo-wide glob `**/CLAUDE.md` excluding node_modules — zero matches). Standards live in `AGENTS.md` (repo root) and `docs/agents.md`.
- `AGENTS.md` (repo root, read directly):
  - `.syntaur/context.json` is a WORKSPACE MARKER only — not the active-assignment source of truth.
  - Run `npm run typecheck` for TypeScript changes.
  - Skills edited only at `skills/<name>/SKILL.md`; not relevant to this change.
- User memory: tsconfig excludes `src/__tests__` → test-file type errors invisible to typecheck AND vitest; run a type-aware tsc probe on test files after signature changes.
- `package.json` (read directly): `npm run build` = tsup, `npm test` = vitest run, `npm run typecheck` = tsc --noEmit.

## Questions Asked & Answers
| Question | Answer |
|----------|--------|
| (none asked) | The task brief explicitly pre-resolved scope via the scout's findings and instructed not to re-ask resolved questions. The six acceptance criteria are precise. The one flagged open decision (AC #4 persistence) was explicitly scoped as "gather evidence, do not decide." The remaining ambiguities discovered (below) are implementation-design choices for the planning phase, each documented with the evidence needed to decide them — none is a user-scope ambiguity. |

## Open Questions for Planning (evidence gathered, NOT decided here)

**Q1 — Feed consumption mechanism: poll `list` vs per-session `subscribe` fan-out.** AC #3 says "consumes daemon subscribe state", but the verified protocol has NO whole-daemon stream: subscribe is `{op:'subscribe'; short}` (one session, one socket) and the relay drops the state/settled discriminator. `loadSessions` is a stateless-per-call poll function on a 1.5s cadence with a module-level grace-cache precedent (agent-view). Evidence favors a `{op:'list'}` poll as the feed source (returns `{ ok:true, sessions: Session[] }` in one one-shot request, fits the poll model, no socket bookkeeping), with per-short subscribe reserved for a future push model. Planner must choose and reconcile with the AC wording.

**Q2 — Auto-spawn hazard in the feed path.** `daemonRequest` → `ensureDaemon` AUTO-SPAWNS the daemon on a miss (`client.ts:113-128`). A feed poll using `daemonRequest({op:'list'})` would resurrect a deliberately-stopped daemon every 1.5s. `resolveDaemon(currentPointerPath(), ...)` (discovery.ts:172) probes without spawning. The feed source must be non-spawning (resolve + sendRequest only if live); dispatch/launch SHOULD keep ensureDaemon's auto-spawn.

**Q3 — Attach: in-process `runAttachClient` vs spawning `syntaur attach <short>` as a child.** Both are socket attach (AC #2). Child-process route (`spawn('syntaur', ['attach', short], {stdio:'inherit'})` or the CLI entry) mirrors `runClaudeAttach`/`runTmuxAttach` exactly — same never-reject `{code, error?}` shape, no stdin/raw-mode ownership conflict with Ink, trivially testable — but requires the syntaur CLI on PATH (it is: this IS the syntaur CLI; `process.execPath` + `cliEntryPath` are already resolved in `ClientDeps`). In-process route avoids a child process but must adapt `AttachResult` → `ChildOutcome` and carefully sequence stdin ownership between Ink's `suspendTerminal` and `runAttachClient`'s own raw-mode/stty/RESET handling (both manipulate the same terminal; attach-client's restore-first discipline may fight Ink's resume). Evidence collected for both; planner decides.

**Q4 — AC #4 backend recording: persist `hosted_by` (schema v7) vs per-poll derivation.** See "Open Decision — Evidence Gathered" above. The decisive evidence: per-poll derivation cannot distinguish "daemon down, session daemon-hosted" from "never daemon-hosted", which AC #4's routing rule ("tmux only when daemon unavailable OR session predates it") needs; only a persisted column survives daemon downtime.

**Q5 — Session-row provenance and sessionId seeding at dispatch.** `loadSessions` bases rows on session-db (`listAllSessions`) — a syntaurd-dispatched session with no session-db row would never appear in the rail, and AC #1 requires it to appear via the feed join. Claude sessions self-register via track-session hooks; codex/pi/generic agents do not. Evidence for the two options: (a) cockpit pre-inserts a session-db row at dispatch (`appendSession` upsert exists, `agent-sessions.ts:152`) with a generated sessionId passed to `dispatch` (op accepts `sessionId?`, stored at `supervisor.ts:252`, forwarded as `--session-id` to pty-host); (b) feed synthesizes rail rows for daemon sessions unmatched in session-db (daemon `Session` carries `agent/cwd/name/createdAt/state`, enough for a row). Note for (a): Claude's own track-session hook may later upsert the same sessionId — `appendSession` has `reviveStopped` semantics worth checking during planning.

## Open Decision — Evidence Gathered (AC #4)
"Backend recorded per session row": persist a `hosted_by` column (schema v7 migration) vs derive per poll from a daemon `list` join. Evidence (verified, Explorer 2):

**No hosting-backend persistence exists.** `hosted_by`/`hostedBy` = zero hits in src/; `backend` appears only in comments/fixtures. The v6 `sessions` table has 13 columns, none launcher-related: `session_id` (PK), `agent`, `started`, `ended`, `status`, `path`, `description`, `transcript_path`, `pid`, `pid_started_at`, `original_head_sha`, `activity`, `created_at`, `updated_at`. (`src/dashboard/session-db.ts:18-37`, `SCHEMA_VERSION = '6'` at line 12.)

**How `launcher` is derived today (in-memory, per poll):** `SessionLauncher = 'claude-bg' | 'tmux' | null` (`src/dashboard/types.ts:726-727`). In `src/tui/sessions/feed.ts:81-98`, rows matched by the agent-view join get `launcher: 'claude-bg'` stamped fresh every poll; unmatched rows keep whatever they carried (normally unset). Nothing is persisted — when the daemon/CLI is down, `launcher`, `state`, `waitingFor`, `agentShortId` all vanish and rows revert to session-db pid liveness.

**Migration mechanism (v7 template):** all migrations run inside ONE EXCLUSIVE transaction (`database.transaction(...)` + `runMigrations.exclusive()`, `session-db.ts:77-292`); each step re-reads `schema_version` from `meta` inside the txn, then does `CREATE TABLE sessions_vN` → `INSERT INTO ... SELECT` → `DROP TABLE sessions` → `ALTER TABLE ... RENAME TO sessions` → recreate indexes → `UPDATE meta SET value='N'`. The v5→v6 step is at `session-db.ts:247-290`; the simplest add-a-nullable-column template is the v4→v5 step (`session-db.ts:216-244`: new table with trailing `original_head_sha TEXT`, `SELECT <old cols>, NULL, created_at, updated_at`). A v7 `hosted_by TEXT` migration would gate on `vBeforeV7 === '6'`, clone that pattern, add the column to fresh-install `SCHEMA_SQL`, and bump `SCHEMA_VERSION` to `'7'`.

**What survives daemon downtime:** only session-db columns (status, pid/pid_started_at liveness, activity, transcript_path, engagement-projected project/assignment bindings). All join-derived overlay fields are recomputed per poll. A persisted `hosted_by` column would be the ONLY thing that lets AC #4's "session predates the daemon / daemon down → tmux path" routing work while the daemon is unreachable — per-poll derivation cannot distinguish "daemon down, session is daemon-hosted" from "session was never daemon-hosted".

## Exploration Log
| Explorer | Focus Area | Key Findings |
|----------|-----------|--------------|
| Explorer 1 (Entry points & main logic) | Cockpit.tsx, actions.ts, commands/{tui,attach,bg}.ts, build-launch.ts, tmux/claude-agents tier signatures, mouse/suspend sandwich | Verbatim runLaunch/LaunchDeps ladder; handleLaunch/handleAttach call graphs; residency model (claude-bg/tmux tiers non-blocking, only handoff suspends); bg.ts dispatch payload mapping; attach.ts CLI wiring (cols/rows from process.stdout, ensureDaemon transitive); 6 integration frictions incl. the AttachResult-vs-ChildOutcome shape mismatch and the daemon→feed visibility gap |
| Explorer 2 (Data models & types) | daemon/types.ts, session-db.ts schema+migrations, agent-sessions.ts row types, dashboard/types.ts, feed.ts join, railTypes.ts, agent-view.ts | Full ControlRequest/Reply unions + RvFrame/Pty frames; v6 schema (13 cols, no backend column) + EXCLUSIVE-txn migration template (v5→v6 verbatim, v4→v5 add-column pattern); launcher is per-poll in-memory only; sessionId is the sole cross-source join key (null in Phase A by design); nothing join-derived survives daemon downtime |
| Explorer 3 (Similar implementations) | daemon/client.ts, attach-client.ts, supervisor.ts subscribe path, pty-host.ts states, claude-agents tier, daemon test fakes | One-shot sendRequest destroys socket on first frame (subscribe needs a new streaming path); subscribe = per-session relay, ack + `{ok:true,record}` frames, discriminator dropped, no whole-daemon stream (poll `list`); pty-host emits working + done/failed/stopped only ('blocked' reserved, never produced); sessionId populated only when dispatch supplies it; 7-point claude-agents tier mirror checklist; full daemon test-fake inventory |
| Explorer 4 (Configuration & standards) | CLAUDE.md glob, AGENTS.md, tsconfig(.tests).json, vitest.config.ts, all four target test files | Zero CLAUDE.md files repo-wide; tsconfig excludes tests from typecheck — `tsconfig.tests.json` `files` array + `npx tsc -p tsconfig.tests.json --noEmit` is the probe (tui tests not yet listed); per-file test skeletons: hoisted mock boxes + feed.js vi.mock + real timers (Cockpit), pure deps() factory (actions), real sqlite tmpdir + null-vs-[] grace fixtures (feed), env-redirect + fake sockets + NDJSON drivers (daemon) |

## Reflection (gaps check)

1. **Understanding:** complete — launch ladder, attach sandwich, feed join, daemon protocol, migration mechanism, and test seams are all documented with verbatim signatures and line references.
2. **Files:** confirmed and extended beyond the scout list (added `src/dashboard/agent-sessions.ts`, `src/dashboard/types.ts`, a new `src/tui/syntaurd/` tier dir, `tsconfig.tests.json`).
3. **Patterns:** the claude-agents tier is a verified 1:1 architectural template; the agent-view feed join is the verified template for the daemon join precedence/degradation.
4. **Remaining uncertainty:** none blocking discovery. Five implementation-design choices are documented as Open Questions (Q1-Q5) with the evidence needed to decide them in the outline/detail phases — notably the AC-wording-vs-protocol tension in Q1 (subscribe is per-session; whole-rail truth requires polling `list`) and the ensureDaemon auto-spawn hazard in Q2.
5. **No further exploration needed:** every file on the change list was read completely by an explorer; both design docs were read directly.
6. **Complexity:** `large` was given (and fits: ~12 existing files + a new tier + possible schema migration + 4+ test suites).

## Risks

- **Terminal ownership during attach** (Q3): Ink `suspendTerminal` + attach-client raw-mode/stty/RESET both manipulate the same TTY; wrong sequencing breaks the "detach returns cleanly" AC. The child-process route sidesteps this; in-process needs careful ordering.
- **Feed auto-spawn** (Q2): naive `daemonRequest` in the poll would resurrect a stopped daemon every 1.5s.
- **'blocked' never produced in Phase A**: attention rows (⚠) from daemon truth will not fire until Phase C adapters; precedence logic must still handle the state (UI already does).
- **Schema migration** (if v7 chosen): must update fresh-install SCHEMA_SQL AND the migration chain AND agent-sessions.ts row plumbing together, inside the existing EXCLUSIVE-txn pattern.
- **Test typecheck blindspot**: every new/edited test file must be added to `tsconfig.tests.json` `files` and probed with `npx tsc -p tsconfig.tests.json --noEmit`, or type errors ship invisibly.
- **Dashboard-side liveness writers** (`livenessStopSession`, `reconcileActiveSessions`) also mutate session rows; Phase B's TUI-feed changes should not fight them — out of scope but worth a planning note.
