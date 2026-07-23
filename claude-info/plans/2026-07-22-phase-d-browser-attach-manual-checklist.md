# Phase D — Browser Attach: Manual Verification Checklist (AC6)

The React xterm component and the live daemon↔browser path can't run in the
node-env test harness, so these are verified by hand against a real daemon + a
browser. Automated coverage: 67 tests (daemon-join, pty-token, pty-bridge,
pty-upgrade-auth, snapshot-restore, real-ws upgrade integration, by-id/token
REST, terminalSocket).

## Setup
1. `npm run build && npm run build:dashboard && npm link` (or `npm run try`).
2. Start the dashboard: `syntaur dashboard` → open the printed URL.
3. Launch a daemon-hosted session: `syntaur bg --name demo -- codex` (and a
   second with `claude` for the claude adapter pass).

## Checklist

### AC1 — snapshot restore + live stream
- [ ] Open **Agent Sessions**, click a live session's id → detail route
      `/agent-sessions/:id` renders.
- [ ] The terminal shows the session's **current screen** immediately (snapshot),
      then streams new output live.

### AC2 — input + resize + take-control
- [ ] Terminal is **view-only** by default — typing does nothing.
- [ ] Click **Take control** → typing reaches the agent; the toggle flips to
      **Release control**.
- [ ] Resize the browser window → the PTY reflows (agent redraws at the new size).

### AC3 — multi-attacher, last-attacher-wins
- [ ] With the browser attached, also `syntaur attach <short>` in a terminal.
- [ ] Output appears in **both**; typing in either reaches the agent.
- [ ] Resizing one attacher resizes the session for both (last-attacher-wins).

### AC4 — local-only + token
- [ ] The pty WS is `/ws/agent-sessions/<short>/pty?token=…`; the token is
      single-use (a second connect with the same URL is rejected).
- [ ] A non-loopback request to that path is refused (covered by the auth unit
      test; spot-check that the dashboard is only reached via localhost).

### AC5 — reconnect + settled
- [ ] Refresh the page → terminal re-snapshots cleanly (fresh token minted).
- [ ] Let the session exit (`/exit` the agent) while attached → the pane shows
      `[session exited (code)]`, then the page flips to the **settled final
      screen** (served from `state.json.lastScreen`), not a dead terminal.
- [ ] Open a long-exited session's detail → it shows the final screen directly.
- [ ] Stop the daemon while a non-terminal session's detail is open → a
      **retryable "Session unavailable"** banner appears (not a settled screen).

### Adapters (Phase C surfaces, re-checked here)
- [ ] Repeat AC1–AC2 for both a **codex** and a **claude** session.
- [ ] A blocked session shows its `needs` text (⚠) in the detail header.

## Result
Record pass/fail per box and capture a screenshot of a live browser terminal +
a settled screen via `syntaur capture` as the assignment proof artifact.
