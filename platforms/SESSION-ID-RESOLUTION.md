# Cross-agent session-id resolution

Session identity is an **ambient property of the running process**, resolved on
demand — never persisted-and-looked-up in the shared `.syntaur/context.json`
scalar (a co-tenant sharing the workspace clobbers it). The CLI does this in
`src/utils/session-id.ts` (`resolveOwnSessionId`), with six layers:

1. explicit `--session-id`
2. injected env var: `CLAUDE_CODE_SESSION_ID` / `OPENCODE_SESSION_ID` / `PI_SESSION_ID`
3. agent side channel (Cursor nonce → `conversation_id`)
4. ancestor-pid → runtime marker (`~/.claude/sessions/<pid>.json`, then the
   generic `~/.syntaur/runtime/sessions/<pid>.json`), pid-reuse-guarded by `procStart`
5. cwd/mtime transcript scan (last automatic resort; ambiguous under co-tenancy)
6. legacy `context.json.sessionId` hint (only when the caller opts in)

**The consuming half (layers 2, 4, 5, 6) is implemented and unit-tested today.**
Each agent's job is only to make its real id reachable by layer 2, 3, or 4 — i.e.
to **normalize the key**, never to synthesize an id. Per-agent status and the
exact injector below.

## Generic runtime marker (layer 4)

Any agent whose start/early hook learns the real id but cannot inject env can
stamp a marker that both the resolver and the Codex cleanup hook read:

```
~/.syntaur/runtime/sessions/<agentPid>.json
  = { "sessionId": "<real id>", "agent": "<name>", "cwd": "<abs>",
      "procStart": "<ps -o lstart= string>", "writtenAt": <epoch ms> }
```

`procStart` guards against pid reuse (compared to `ps -o lstart= -p <pid>`).
Helpers: `writeRuntimeMarker` / `readRuntimeMarker` in `src/utils/session-id.ts`.
Override the dir in tests/hooks via `$SYNTAUR_RUNTIME_SESSIONS_DIR`.

---

## Claude Code — EXACT (shipped, no new runtime code)

Native `CLAUDE_CODE_SESSION_ID` env is injected into every child process, so a
`syntaur` command is a child and layer 2 hits. Confirmed live:
`CLAUDE_CODE_SESSION_ID` and the ancestor-pid file `~/.claude/sessions/<pid>.json`
resolve to the same id. The SessionStart hook still mirrors the id into
`context.json` as a legacy hint (back-compat). **Fixes the reported bug.**

## OpenCode — injector ships as a plugin (live-build gate)

OpenCode's plugin API exposes `plugin.trigger("shell.env", { sessionID })` per
spawn (`@opencode-ai/plugin`). A ~5-line plugin injects `OPENCODE_SESSION_ID`,
which layer 2 then reads. Reference plugin: `platforms/opencode/plugin/syntaur-session-env.js`.

- **Caveat:** the V2 `core` bash tool is not yet wired to `shell.env`
  (`// TODO` in `packages/core/src/tool/bash.ts`); the `opencode` `ShellTool`
  path is. Verify on the target build.
- **Status:** Syntaur's current OpenCode integration is **adapter-file-only**
  (`platforms/opencode/README.md`) — it has no persistent-plugin install path
  yet. The plugin is shipped as a reference artifact; wiring it into a
  Syntaur-managed install is follow-up work.
- **Live verification gate (cannot run here):** from an OpenCode tool call,
  `echo $OPENCODE_SESSION_ID` returns the conversation/session id.

## Pi — injector ships as an extension (live-build gate)

Pi extensions expose `session_start` (capture `ctx.sessionManager.getSessionId()`)
and a bash `spawnHook` that injects env per spawn. Inject `PI_SESSION_ID` (layer
2). Reference: `platforms/pi/extension/syntaur-session-env.js` + `platforms/pi/README.md`.

- **Status:** no `platforms/pi/` integration existed before this change; shipped
  as a reference artifact, not yet wired into a Syntaur install path.
- **Live verification gate (cannot run here):** `echo $PI_SESSION_ID` from a Pi
  tool call returns the real id.

## Cursor — best-effort nonce handshake (env injection impossible)

Cursor hooks deliver `conversation_id` on stdin and can only allow/deny — they
**cannot inject env**, and there is no `CURSOR_SESSION_ID` (open feature
request). So we key on a per-invocation **nonce**, not cwd (cwd is ambiguous
under co-tenancy):

1. The `syntaur` CLI emits a nonce token in its own argv.
2. A shipped `beforeShellExecution` hook (which knows `conversation_id`) writes
   `nonce → conversation_id` into `~/.syntaur/runtime/cursor-nonces/<nonce>.json`.
3. The resolver's **layer-3 seam** (`resolveSideChannelSessionId` in
   `src/utils/session-id.ts`) reads its own nonce back.

- **Status:** layer-3 seam exists and returns `undefined` (no-op) today; the
  argv-nonce emission and the `beforeShellExecution` hook are the remaining
  pieces. Documented design; reference hook in `platforms/cursor/hooks/`.
- **Live verification gate (cannot run here):** needs a live Cursor session.

## Codex — best-effort; exact requires a start hook (open question resolved)

**Open question (design memo #1): does Codex expose a session-start event and/or
the process pid to a hook?** Finding from this branch's wired Codex hooks
(`platforms/codex/hooks.json`):

- `PreToolUse` (`enforce-boundaries.sh`) stdin carries `.tool_name` /
  `.tool_input` only — **no session id, no pid.**
- `SessionEnd` (`session-cleanup.sh`) stdin carries `.cwd` only — **no id.**
- **There is no SessionStart hook.**

So Codex exposes no real id to any currently-wired hook, and capture-at-birth
(stamping the generic marker) is **not possible today** without Codex either
adding a session-start event that surfaces the rollout id/pid, or surfacing an
id on an existing hook's stdin. If/when it does, an early hook can
`writeRuntimeMarker(<codexPid>, …)` and both the resolver (layer 4) and the
Codex cleanup hook will resolve it exactly.

**Honest floor today:**
- `session-cleanup.sh` no longer trusts the clobbered scalar; it resolves only
  from an exact runtime marker and otherwise **skips** (the dashboard liveness
  reaper marks the dead session stopped). It never mis-stops a co-tenant.
- For attribution that must be exact now, pass explicit `--session-id`
  (sourced from `payload.id` of the matching `~/.codex/sessions/.../rollout-*.jsonl`,
  as `platforms/codex/scripts/resolve-session.sh` already does on a cwd basis).
