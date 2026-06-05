# Pi Integration (Reference Only)

Syntaur resolves the **real** agent session id from the running process, not the
shared `.syntaur/context.json` scalar (a co-tenant clobbers it). For Pi, the job
is to inject `PI_SESSION_ID` per spawn so the CLI's `resolveOwnSessionId` picks
it up at layer 2. See `../SESSION-ID-RESOLUTION.md` for the full design.

> **Status:** Syntaur already ships a Pi extension at
> `extensions/syntaur/index.ts` (it tracks the dashboard session via
> `ctx.sessionId`). That extension does **not** yet inject `PI_SESSION_ID` into
> spawned commands — adding the `spawnHook` below to it is the remaining piece
> so Pi commands self-identify to `resolveOwnSessionId` (layer 2). This file
> documents that injector and its verification gate.

## Injector — a `spawnHook` extension

Pi extensions (`@earendil-works/pi-coding-agent`, see its `docs/extensions.md`)
can capture the session id at `session_start` and inject env on every spawned
command via a bash `spawnHook`:

```js
// syntaur-session-env extension (reference; verify against your Pi version)
export default {
  name: 'syntaur-session-env',
  session_start(ctx) {
    // Capture the real id once, at session start.
    this.sessionId = ctx.sessionManager.getSessionId();
  },
  // Injected into the environment of every spawned shell command.
  spawnHook() {
    return this.sessionId ? { env: { PI_SESSION_ID: this.sessionId } } : {};
  },
};
```

Alternatively, if Pi's start hook exposes the process pid, stamp the generic
marker `~/.syntaur/runtime/sessions/<pid>.json` (see `../SESSION-ID-RESOLUTION.md`)
and the resolver's layer-4 ancestor walk will find it without env injection.

## Verification (needs a live Pi build — cannot run in CI)

From a Pi tool call:

```bash
echo "$PI_SESSION_ID"   # prints the real Pi session id
```

`PI_SESSION_ID` is already in the resolver's layer-2 precedence list
(`src/utils/session-id.ts`), so once injected, `syntaur session save` (etc.)
attribute to the correct session automatically.
