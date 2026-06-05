# Design: Resolve agent session id from the process, not the shared `context.json` scalar

- **Date:** 2026-06-05
- **Assignment:** `syntaur-meta/session-id-from-process-not-context-scalar`
- **Status:** Design (approved, pre-plan)
- **Type:** bug → cross-cutting refactor + per-agent adapters

## Problem

When two agent sessions share one workspace (worktree) on the same assignment, the
`sessionId` stored in `.syntaur/context.json` is **clobbered** and a long-lived
session subsequently reads the **wrong** id.

Concrete failure (the reported bug):

1. Agent **A** starts in the worktree → `context.json.sessionId = A`.
2. Agent **B** starts in the same worktree → its `SessionStart` hook overwrites →
   `context.json.sessionId = B` (`platforms/claude-code/hooks/session-start.sh:68`,
   unconditional `jq '. + {sessionId: $sid}'`).
3. The user returns to **A**'s still-running process — **no fresh `SessionStart`
   fires** just because a new message is typed — and runs e.g.
   `save-session-summary`. The command reads `context.json.sessionId` and gets **B**.
   A's summary is written under B's id. ❌

### Why it can't be fixed by changing *what* `context.json` stores

`context.json.sessionId` is **shared mutable state used as a proxy for a
per-process fact.** A co-tenant can rewrite it underneath a long-lived session
without that session knowing. Therefore:

- A **scalar** is wrong (last-writer-wins).
- An **array** (`sessionIds: []`) is *also* wrong: a caller reading `[A, B]` still
  cannot tell which entry is its *own*, and concurrent `SessionStart` hooks doing
  read-modify-write on one file race (jq→tmp→mv is not cross-process atomic).
- A **per-agent file** only relocates the same question: "which file is mine?"

The identity must come from something **stable to the caller's own process** that a
co-tenant cannot touch. That source already exists at the runtime layer.

### Second symptom (same root cause)

`platforms/codex/scripts/session-cleanup.sh` (Codex `SessionEnd`) also reads
`sessionId` from `context.json` — so under co-tenancy, when one Codex session ends
it may mark the **wrong** session as `stopped` in the dashboard. Any fix must cover
the cleanup path, not just save/resume.

## What is already correct (do not change)

- **The DB.** `sessions` (`src/dashboard/session-db.ts:16`) keys on
  `session_id` (PRIMARY KEY) with an index on `(project_slug, assignment_slug)`.
  N sessions → 1 assignment is already modeled. Multi-agent attribution works at
  the data layer today.
- **The "real id only" rule.** The protocol forbids synthesized session ids; the id
  must be the real agent-runtime id. This design does **not** mint any Syntaur id.

## Principle

> **Session identity is an ambient property of the running process, resolved on
> demand from the environment / process tree — never persisted-and-looked-up in a
> shared file.**

`context.json` reverts to describing only the **workspace↔assignment binding**
(`projectSlug`, `assignmentSlug`, `assignmentDir`, `workspaceRoot`, `branch`),
which genuinely is shared and identical for every co-tenant. `sessionId` /
`transcriptPath` are demoted to a **legacy, best-effort hint** (kept for back-compat,
no longer load-bearing).

## Design

### 1. A single resolver: `resolveOwnSessionId()`

A plain, synchronous function in the `syntaur` CLI. No daemon, no timer. Invoked by
any command that needs "which session am I running inside." It returns the **real**
agent id, ordered by trustworthiness:

1. `--session-id <id>` — explicit override.
2. **Injected env var** — `CLAUDE_CODE_SESSION_ID` / `OPENCODE_SESSION_ID` /
   `PI_SESSION_ID` (native or set by a shipped per-spawn hook). Clobber-proof,
   per-process. **Covers 3 of 5 agents fully.**
3. **Agent side channel** — Cursor nonce→`conversation_id` map; Codex
   capture-at-birth marker (see §4).
4. **Ancestor-pid → runtime file** — walk the caller's parent-pid chain and read the
   nearest agent runtime file (`~/.claude/sessions/<pid>.json`); generic fallback.
5. **cwd/mtime transcript scan** — today's behavior (Codex `resolve-session.sh`,
   `cwd-extractor.ts`). Ambiguous under co-tenancy; last automatic resort.
6. `context.json.sessionId` — legacy hint.

Why env (layer 2) works: a `syntaur` command is a **child process** of the agent.
Children inherit the agent's environment. The agent process has its id baked in at
launch; a co-tenant cannot reach into it. Verified live in a Claude session:
`CLAUDE_CODE_SESSION_ID` and the ancestor-pid file (`~/.claude/sessions/<ppid>.json`)
both resolve to the same id.

### 2. Reroute every consumer through the resolver

- `src/commands/session.ts:213` — `options.sessionId ?? ctx.sessionId`
  → `options.sessionId ?? resolveOwnSessionId() ?? ctx.sessionId`. **This is the
  line that produces the reported bug.**
- `save-session-summary` / `resume-session` / `track-session` skills — prefer the
  injected env var over reading `context.json.sessionId`.
- `platforms/codex/scripts/session-cleanup.sh` — resolve the ending session's id
  from the process, not `context.json`.
- Audit other `sessionId` readers: `assignment-target.ts:47` (`standalone`
  classification — must no longer key on the scalar; key on an explicit
  `scope` field or presence of session state), `usage/session-join.ts`,
  `context-leases.ts:51`, doctor workspace checks.

### 3. Per-agent id providers (the cross-agent surface)

Normalization, **not** synthesis — the *value* is always the agent's real id; we
only standardize the *key* the resolver reads.

| Agent | Mechanism | Clobber-proof | Cost |
|---|---|---|---|
| **Claude Code** | native `CLAUDE_CODE_SESSION_ID` env (already injected) + `SessionStart` stdin + `~/.claude/sessions/<pid>.json` | ✅ today | route resolver through env |
| **OpenCode** | `shell.env` plugin hook receives `sessionID`, injects env **per spawn** → `OPENCODE_SESSION_ID` | ✅ | ship ~5-line plugin* |
| **Pi** | extension: `session_start` captures `ctx.sessionManager.getSessionId()`, bash `spawnHook` injects `PI_SESSION_ID` per spawn | ✅ | ship small extension |
| **Cursor** | hooks deliver `conversation_id` on stdin but **cannot inject env** (allow/deny only); no `CURSOR_SESSION_ID` (open feature request) | ⚠️ | nonce-in-argv handshake via `beforeShellExecution`, or best-effort |
| **Codex** | **no `SessionStart`**; `SessionEnd` stdin lacks the id; only cwd+mtime rollout scan | ⚠️ | capture-at-birth pid-marker (if Codex exposes pid to a hook) or explicit `--session-id` |

\* *OpenCode caveat: the V2 `core` bash tool is not yet wired to `shell.env`
(`// TODO` in `packages/core/src/tool/bash.ts`); the `opencode` `ShellTool` path is.
Verify on the target build.*

#### Cursor nonce handshake (the one genuinely hard runtime)

Cursor cannot push env into a spawned command. So: the `syntaur` CLI emits a
**nonce** in its own argv; a shipped `beforeShellExecution` hook (which knows
`conversation_id`) writes `nonce → conversation_id` into a small map file; the CLI
reads its own nonce back. Keying on a per-invocation nonce — not cwd — is what makes
it co-tenant-safe.

#### Codex capture-at-birth

Codex has no start hook today and its `SessionEnd` stdin omits the id. If Codex's
hook spec exposes a session-start event **and** the process pid, a start hook can
record the freshly-created rollout id (mtime is unambiguous *at birth*) into an
ancestor-pid marker. **Open question — verify against Codex's current hook spec.**
If unavailable, the honest floor is explicit `--session-id`.

### 4. Generic pid-marker (optional unifier)

For any agent whose start hook learns the real id but can't inject env, stamp:

```
~/.syntaur/runtime/sessions/<agentPid>.json = { sessionId, agent, cwd, procStart }
```

The resolver (layer 4) walks ancestor pids and returns the id from the nearest
ancestor with a marker. `procStart` guards pid reuse. This generalizes Claude's
`~/.claude/sessions/<pid>.json` into an agent-neutral cache of the real id.

## Coverage summary

- **Claude** — exact after routing the resolver through env. Fixes the reported
  bug. Zero new runtime code.
- **OpenCode, Pi** — exact after shipping one tiny per-spawn hook each.
- **Cursor** — best-effort via nonce handshake (env injection impossible).
- **Codex** — best-effort / explicit id (no start hook today).

Not "all agents for free," but a uniform principle with an honest, per-agent cost:
**3 of 5 become exact with a trivial shipped hook; 2 get documented fallbacks.**

## Rollout / back-compat

Keep `context.json.sessionId` as a written legacy hint (writers may still mirror the
"last session here"); readers prefer the resolver and fall back to the scalar. No
schema migration; existing worktrees keep working. Remove the scalar from the
write path in a later release once consumers are fully rerouted.

## Out of scope

- Changing the DB schema (already correct).
- Minting any Syntaur-owned session id.
- A `sessionIds: []` array in `context.json` (rejected — see Problem).

## Open questions

1. Does Codex's current hook spec expose a session-start event and the process pid?
   (Decides whether Codex can be made exact.)
2. Canonical env-var name(s): read each native var, or also set one shared key from
   the shipped OpenCode/Pi hooks?
3. Standalone-session classification (`assignment-target.ts:47`) — replacement
   signal once the scalar is no longer authoritative.

## Key references (verified)

- Bug site: `src/commands/session.ts:213`; clobber: `platforms/claude-code/hooks/session-start.sh:68`; Codex cleanup: `platforms/codex/scripts/session-cleanup.sh`.
- Codex id resolution: `platforms/codex/scripts/resolve-session.sh`, `src/usage/cwd-extractor.ts`.
- OpenCode `shell.env`: opencode plugin API (`@opencode-ai/plugin`), `tool/shell.ts` `plugin.trigger("shell.env", { sessionID })`.
- Pi `spawnHook`: `@earendil-works/pi-coding-agent`, `core/tools/bash.ts`, `docs/extensions.md`.
- Cursor hooks: `cursor.com/docs/hooks` (`beforeShellExecution`, `conversation_id` on stdin; no env injection; feature request for `CURSOR_*` env unfulfilled).
