# Cursor session-id handshake (Reference Only)

Cursor hooks deliver `conversation_id` on stdin but **cannot inject environment
variables** into spawned commands (they can only allow/deny), and there is no
`CURSOR_SESSION_ID` env (open feature request). So the env-var path (layer 2)
is impossible for Cursor. Instead we use a per-invocation **nonce** — keying on
a nonce, not cwd, is what keeps it co-tenant-safe.

> **Status:** reference design. The resolver's layer-3 seam
> (`resolveSideChannelSessionId` in `src/utils/session-id.ts`) is in place and
> returns `undefined` today. The two pieces below complete the handshake.

## The handshake

1. **CLI emits a nonce in its own argv.** A `syntaur` invocation that needs to
   self-identify passes e.g. `--session-nonce <random>` (the nonce travels in
   the command line the Cursor hook can see).
2. **`beforeShellExecution` hook records the mapping.** A shipped hook that
   receives `conversation_id` on stdin and sees the spawned command's argv
   extracts the nonce and writes:

   ```
   ~/.syntaur/runtime/cursor-nonces/<nonce>.json = { "sessionId": "<conversation_id>" }
   ```

   ```bash
   #!/usr/bin/env bash
   # beforeShellExecution — reference. Reads the hook payload on stdin.
   payload=$(cat)
   cid=$(printf '%s' "$payload" | jq -r '.conversation_id // empty')
   cmd=$(printf '%s' "$payload" | jq -r '.command // .tool_input.command // empty')
   nonce=$(printf '%s' "$cmd" | sed -n 's/.*--session-nonce \([A-Za-z0-9_-]\{8,\}\).*/\1/p')
   if [ -n "$cid" ] && [ -n "$nonce" ]; then
     dir="$HOME/.syntaur/runtime/cursor-nonces"
     mkdir -p "$dir"
     printf '{"sessionId":"%s"}' "$cid" > "$dir/$nonce.json"
   fi
   echo '{"permission":"allow"}'   # never block on this hook
   ```

3. **Resolver layer 3 reads its own nonce back.** When the CLI was invoked with
   `--session-nonce <n>`, `resolveSideChannelSessionId` reads
   `~/.syntaur/runtime/cursor-nonces/<n>.json` and returns its `sessionId`.

## Verification (needs a live Cursor session — cannot run in CI)

Run a `syntaur` command from a Cursor agent shell with `--session-nonce <n>`;
confirm `~/.syntaur/runtime/cursor-nonces/<n>.json` is written with the right
`conversation_id` and that the command attributes to it.
