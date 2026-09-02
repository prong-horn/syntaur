# ACP adapter transcripts

Recorded JSON-RPC traffic between the spike client (`scripts/spike/acp/`) and the
two ACP adapters Syntaur's assignment chat will drive. Captured by the
`acp-adapter-spike` assignment; regenerate with

```sh
cd scripts/spike/acp
node run.ts --adapter claude --run claude-full
node run.ts --adapter codex  --run codex-full
node fixtures.ts --claude claude-full --codex codex-full
```

## Layout

- `claude/<nn>-<slug>[.label].ndjson` — `claude-agent-acp` transcripts, one per
  spawned adapter process (`label` distinguishes multiple processes in one
  scenario, e.g. `19-concurrency.planner` / `.implementer`).
- `codex/…` — the same for `codex-acp`.
- `manifest.json` — run ids, adapter/CLI versions, and for every scenario × adapter:
  pass/fail, duration, notes, headline metrics, and the transcript files.

## Envelope

One JSON object per line:

```json
{"seq": 12, "ts": "2026-09-01T20:01:02.345Z", "t": 1834, "dir": "in", "msg": {"jsonrpc": "2.0", "method": "session/update", "params": {…}}}
```

- `seq` — monotonically increasing per file.
- `t` — milliseconds since the adapter process was spawned.
- `dir` — `out` = client → adapter (requests, responses to permission requests,
  notifications like `session/cancel`); `in` = adapter → client.
- `msg` — the raw JSON-RPC frame. The only edit is that e-mail addresses are
  replaced with `[redacted-email]` at capture time (the account e-mail shows up
  in codex-acp's `authentication/status` reply and in some agent text).

## Volatile values

Nothing else is scrubbed; the following differ between recordings and must not
be asserted on literally: absolute paths under
`scripts/spike/acp/out/target-<adapter>` (one disposable clone per adapter) and
`scripts/spike/acp/out/perm`, `sessionId`, tool-call ids (`toolu_…`, `call_…`,
`exec-…`), `usage_update` numbers, `_meta["_claude/rateLimit"]`, timestamps,
and model output text. Structure —
method names, `sessionUpdate` kinds, field presence, `ToolKind`/status values,
permission option kinds, stop reasons — is what the fixtures document.

No tests consume these yet; phase 2 (`assignment-chat-single-agent`) will replay
them against the real ACP client.
