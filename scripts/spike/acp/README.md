# ACP adapter spike

Throwaway ACP client that drives `claude-agent-acp` and `codex-acp` through the
scenarios in `claude-info/plans/assignment-chat-design.md` §5.9a. It exists to
answer the questions phase 2 (assignment chat) depends on; results live in
`RESULTS.md`, the raw transcripts in `src/__tests__/fixtures/acp/`.

Assignment: `syntaur-meta/acp-adapter-spike`.

## Prerequisites

- Node ≥ 22 with native type stripping on (`process.features.typescript` set —
  default since 22.18/23.6; the scripts are `.ts` run with no build step).
- `claude-agent-acp` 0.70.x and `codex-acp` 1.7.x on `PATH`
  (`npm i -g @agentclientprotocol/claude-agent-acp @agentclientprotocol/codex-acp`).
- `claude auth status` → `"loggedIn": true`; `codex login status` → `Logged in using ChatGPT`.
  Both adapters bill the personal subscriptions; no API keys are used (the
  harness scrubs `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`, …).

`run.ts` runs a preflight that checks all of the above and refuses to start otherwise.

## Run

```sh
cd scripts/spike/acp
npm install
npm run typecheck                                   # tsc -p . (spike-local tsconfig)
node run.ts --adapter claude --run claude-full      # all scenarios, one adapter
node run.ts --adapter codex  --run codex-full       # may run concurrently with the above
node run.ts --adapter both   --only 07,14 --run x   # a subset; rows upsert into out/x
node smoke.ts codex                                 # handshake + PONG only
node fixtures.ts --claude claude-full --codex codex-full   # export to src/__tests__/fixtures/acp/
```

Adapters run with `cwd = out/target-<adapter>`, one clone of this repo per adapter
on a throwaway branch, so edit scenarios never touch the real tree and both suites
can run at once. `target.sh <name>` creates the clone and resets it to the source
repo's current `HEAD` before every run (`reset --hard` + `clean -fdx`); the commit
is recorded in `out/<run>/run.json` and on every `results.json` row as
`sourceCommit`, because a `--only` rerun may happen after `HEAD` moved.
Permission scenarios write probe files under `out/perm/` (outside every cwd and
`/tmp`, which codex's workspace-write sandbox treats as writable).

A full run (no `--only`) wipes `out/<run>` first. Output per run:

- `<scenario>.<adapter>[.label].ndjson` — every JSON-RPC frame both ways,
  `{seq, ts, t, dir: "in"|"out", msg}` (`t` = ms since spawn). E-mail addresses
  are replaced with `[redacted-email]` at capture time.
- `<scenario>.<adapter>[.label].stderr.log` — adapter stderr.
- `run.json` — run id, start time, target path + source commit per adapter.
- `preflight.json` (tool versions + sanitized login state), `results.json`, `summary.md`.

## Files

- `harness.ts` — spawn (own process group), tee stdout (SDK + raw-line validator),
  logging `Stream` wrapper with e-mail redaction, permission policies, update
  collector, session helpers, extension-method calls (`ext`), exact-PID liveness
  (`Harness.alive`) and descendant checks, measurements, preflight.
- `scenarios.ts` — scenario registry (ids match §5.9a step numbers; `07n` is a
  codex-only negative control for a sandbox-denied command, `12` runs two adapter
  processes, `inherited` effort then `low`).
- `run.ts` — preflight, runner, matrix, `run.json`.
- `fixtures.ts` — copies a run's transcripts into the repo fixtures dir, writes
  `manifest.json` and the README capture block; refuses (exit 1) on a missing
  scenario row, missing transcript, malformed envelope, or one-directional transcript.
- `target.sh` — disposable per-adapter target clone.
- `smoke.ts` — minimal end-to-end check.
- `tsconfig.json` / `package.json` — spike-local typecheck and pinned dev deps.
- `RESULTS.md` — the matrix and findings (written after the runs).
