# ACP adapter spike — results

Captured 2026-09-01/02 on macOS (Darwin 25.3.0), Node 22.22.1, `@agentclientprotocol/sdk` 1.4.0,
`claude-agent-acp` 0.70.0 (Claude Code 2.1.258, `claude.ai` login), `codex-acp` 1.7.0
(codex-cli 0.149.1, ChatGPT login). Each adapter operated on its own disposable clone of this
repository. Raw transcripts: `src/__tests__/fixtures/acp/` (see its README and `manifest.json`,
which carries the source commit per row). Regenerate with the commands in `README.md`.

Provenance: the first full run of each suite was at commit `2b3e02b4844b`. Rows rerun with
`--only` after a prompt or predicate fix came later: claude 05, 07, 12, 19 and codex 03, 05, 06, 07
during plan Revisions 2–3 (still at `2b3e02b4844b`), then claude 05, 12, 13 and codex 05, 07n, 12, 13
at `35dbef5d719e` for Revision 4. The claude 13 row was rerun once more at the same commit: the
first Revision-4 attempt hit a Claude session limit mid-scenario ("You've hit your session limit ·
resets 10pm"), which is an environmental failure, not adapter behaviour.

The two suites ran concurrently (one target clone each), so CPU percentages in 19 are noisy;
RSS is not affected.

## Matrix

| # | Scenario | claude-agent-acp 0.70.0 | codex-acp 1.7.0 |
|---|---|---|---|
| 02 | Handshake + trivial prompt | PASS (7.3 s) | PASS (3.7 s) |
| 03 | System prompt transport | PASS (10.0 s) | PASS (10.6 s) |
| 04 | Streaming / coalescing | PASS (15.9 s) | PASS (5.5 s) |
| 05 | Tool calls (read + search) | PASS (19.2 s) | PASS (22.9 s) |
| 06 | Edits / diffs in auto-accept mode | PASS (12.6 s) | PASS (11.5 s) |
| 07 | Permission requests: allow, reject, cancel-while-pending (+ 3 codex modes) | PASS (40.4 s) | PASS (58.6 s) |
| 07n | Negative control: sandbox-denied command, no escalation | — (codex only) | observed (11.8 s) |
| 08 | Plan / todo events | PASS (39.1 s) | PASS (39.8 s) |
| 09 | Thought chunks at high effort | observed (7.3 s) | observed (4.2 s) |
| 10 | Slash commands + config option switch | PASS (6.2 s) | PASS (11.5 s) |
| 11 | Usage updates | PASS (7.0 s) | PASS (3.3 s) |
| 12 | Cancel mid-turn + process hygiene | PASS (38.0 s) | PASS (9.2 s) |
| 13 | Second prompt during a turn; steering | **FAIL** (157.7 s) | **FAIL** (275.9 s) |
| 14 | `session/load` and `session/resume` after adapter restart | PASS (15.3 s) | PASS (11.9 s) |
| 15 | `kill -9` mid-turn | PASS (6.5 s) | PASS (5.9 s) |
| 16 | Embedded resource block + standing-context cost | PASS (6.5 s) | PASS (3.5 s) |
| 17 | Sub-agent (Task tool) rendering | observed (62.4 s) | — (claude only) |
| 19 | Two adapters on the same worktree | PASS (73.9 s) | PASS (28.0 s) |
| 20 | Client closes stdin mid-turn (dashboard/server dies) | PASS (6.3 s) | PASS (7.2 s) |

"PASS" means the structural predicate in `scenarios.ts` held (each predicate is spelled out in
the plan, Task 3). "observed" rows have no predicate. Several rows pass only because a prompt
or predicate was changed after a first failure; those changes and the findings behind them are
in the sections below and in plan Revisions 2–4.

**Row 13 fails on both adapters, and that is the finding, not a defect in the harness.** Its
predicate requires every `session/prompt` this client sent to resolve — an explicit JSON-RPC
error counts as a resolution, a request that never comes back does not. claude leaves the steered
prompt unresolved; codex orphans the first of two concurrent prompts. Decision 6 (serialize
prompts client-side, no steering) rests on this row.

## Measured numbers

| Measure | claude-agent-acp | codex-acp |
|---|---|---|
| Adapter startup to `initialize` response | ~160 ms | ~170 ms |
| First `agent_message_chunk` after a trivial prompt | 4.7–6.3 s | 1.3–1.4 s |
| Streaming (04, ~1.7 kB reply) | 12 chunks over 7.8 s, avg 145 chars, all with `messageId` | 127 chunks over 3.5 s, avg 7 chars, 126/127 with `messageId` |
| Context after first trivial prompt (`usage_update.used`) | 37 507 / 1 000 000 | 23 323 / 258 400 |
| Standing context: same prompt + 5 410-char `resource` block (16) | 39 254 (+1 747 tokens) | 24 881 (+1 558 tokens) |
| Cancel latency (`session/cancel` → prompt resolves `cancelled`) | 11–29 ms | 5–19 ms |
| First `agent_message_chunk` at the inherited `xhigh` effort, 3 000-word essay prompt (12A) | 25 441 ms | 1 613 ms |
| Same prompt at `effort=low` (12B) | 4 035 ms | 1 511 ms |
| `session/load` (2-message history) | 1 457 ms, replays 1 user + 1 agent chunk | 393 ms, replays 1 user + 1 agent chunk + `available_commands_update` + 2 `session_info_update` |
| `session/resume` | 1 506 ms, replays nothing | 121 ms, replays nothing |
| Exit after client closes stdin mid-turn (20) | code 0 in 12 ms, 0 of 2 descendants left | code 0 in 2 013 ms, 0 of 4 descendants left |
| Survivors after SIGKILL of the adapter pid alone (15) | the `claude` child keeps running | none |
| Survivors after SIGTERM of the adapter pid alone (12) | none | none |
| RSS per adapter process group, mid-turn (19) | 610–645 MB | 275–345 MB |
| CPU per group (19; noisy, both suites running) | 43–49 % in the first 2 s, then 1–7 % | 82–109 % in the first 2 s, then 0–10 % |
| Queued second prompt (13) | A 61.5 s, B 61.3 s — both `end_turn`, B answered after A | A never resolves (240 s timeout); B resolves at 34.5 s carrying A's essay |
| Steer mid-turn (13) | `{outcome:"injected"}`, `STEERED` streamed, prompt never resolves (90 s timeout) | `{outcome:"injected"}`, prompt resolves `end_turn` at 32.9 s |
| Steer while idle (13) | `{outcome:"injected"}` | `{outcome:"startedNewTurn"}` |
| Available slash commands (10) | 221 (`/context` present) | 140 (no `/context`) |
| Thought chunks at effort high (09) | 0 | 0 (codex does emit `agent_thought_chunk` on other turns: 4 in 10, 2 in 13) |

## Findings by area

### Handshake, capabilities, auth (02)

- Both advertise `loadSession: true`. Session capabilities: claude `additionalDirectories, close, delete, fork, list, resume`; codex `resume, list, close, delete, additionalDirectories, subagents`. Both put `steering` and `goal` under top-level `initialize._meta`; claude additionally reports `agentCapabilities._meta.claudeCode.promptQueueing: true`.
- Modes: claude `auto, default, acceptEdits, plan, dontAsk, bypassPermissions` (current `auto`); codex `read-only, agent, agent-full-access` (current `agent`). `dontAsk` is advertised by the installed 0.70.0 dist even though the adapter's main branch at `7c6610835f26…` (still labelled 0.70.0) drops it from `buildAvailableModes()`.
- Config options: claude `mode, model, effort, agent`; codex `mode, collaboration_mode, model, reasoning_effort, fast-mode`. Both inherit the user's effort setting: `effort` / `reasoning_effort` start at `xhigh` on this machine.
- Auth with `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` etc. scrubbed from the environment works on both (subscription logins). codex-acp answers its private `authentication/status` extension with `{type: "chat-gpt", email}`; claude-agent-acp rejects the method ("Method not found"). E-mail addresses are redacted in every transcript.
- codex-acp forwards codex's startup notice ("Warning: Skill descriptions were shortened to fit the skills context budget…") as an `agent_message_chunk` **without** a `messageId`, ahead of the first real reply, on every fresh session. Real chunks carry `messageId` and `_meta.codex.phase` (`commentary` | `final_answer`).

### System prompt (03)

- claude: `session/new` `_meta.systemPrompt.append` is honoured (both replies start `PLANNER:`).
- codex: `_meta.systemPrompt` is ignored ("I'm Codex, your AI coding collaborator…"); a `<system>` section prepended to the first user prompt holds across the first and second turns. That is behavioural, not protocol support.

### Streaming (04)

- Chunks are deltas on both. claude emits few, large chunks (145 chars avg); codex emits token-sized chunks (7 chars avg). `messageId` is present on every real chunk on both adapters — it is the coalescing key. The only chunk without one was the codex notice above.

### Tool calls (05)

- claude-agent-acp: `pending → completed` only (never `in_progress`), every call carries `content`, `rawInput`, `rawOutput`; `read` calls carry `locations`; a shell search surfaces as `kind: execute`, title `Terminal`. The Grep tool is not loaded in an ACP session — the agent used ToolSearch/shell grep.
- codex-acp: `in_progress → completed`; shell commands are parsed into `read` (`Read file '<path>'`, with `locations`), `search` (`Search for '<q>' in <path>`, no `content`, no `locations`, no `rawInput`) or `execute` (unparsed commands: terminal `content` + `rawInput {command, cwd}`); the `tool_call_update` carries `rawOutput {formatted_output, exit_code}`. A renderer must fall back to `rawOutput.formatted_output` when `content` is empty.
- Without an explicit instruction codex chains independent tasks into one shell line (one tool call); the prompt now asks for one call per task.
- Given a vague "search tool" prompt, codex reached for its configured MCP tools (`mcp.codex_apps.github.*`, `mcp.node_repl.js`) before local shell — it inherits the user's `~/.codex/config.toml` plugins. The prompt now says "local checkout; no GitHub, network or REPL tools".

### Edits (06)

- Both: one `kind: edit` call, `diff` content blocks with string `path`, `oldText`, `newText`, status `completed`, change on disk, 0 permission requests in `acceptEdits` / `agent`. claude sends two diff blocks for one edit (the `tool_call` and the `tool_call_update` each carry one); codex sends one.
- codex appended the marker at the end of the file when told only "as the very first line"; the prompt now names the line to insert above.

### Permissions (07)

- claude-agent-acp: a plain session inherits `~/.claude/settings.json` (this machine allows `Bash(*)`), so `default` mode never asks — part 0 recorded 0 requests. Isolating with `_meta.claudeCode.options.settingSources: ["project"]` restores prompting. Option kinds `reject_once, allow_once, allow_always`. Allow → `completed`, reject → `failed`, the agent carries on and ends the turn `end_turn`. A held request answered `cancelled` after `session/cancel` resolves the prompt `cancelled` in ~25 ms.
- codex-acp routes approvals by mode: `read-only` ("Ask for approval", `approvalsReviewer: user`) sends `session/request_permission`; `agent` ("Approve for me", `approvalsReviewer: auto_review`) hands escalations to codex's **Guardian** reviewer, surfaced as a `kind: think` tool call titled `Guardian Review` with id `guardian_assessment:<uuid>`, and the client sees no request; `agent-full-access` never asks. All three keep a workspace-write sandbox — `read-only` is a label. `/tmp` is a writable root in every mode (`excludeSlashTmp: false`), so the probe files live in `out/perm/`.
- codex option kinds `allow_once` (`accept`), `allow_always` (`acceptForSession` / exec-policy amendment), `reject_once` — and the only `reject_once` offered was codex's `cancel` decision (no `decline` in the decision set), so a rejection ends the turn as `cancelled`, not `end_turn`. The refused command reports `failed`.
- A sandbox-denied `exec` (the model's first, unescalated attempt) produces **no** `tool_call` in the ACP stream; only the model's narration mentions it. The prompts in 07 ask the agent to request escalated permissions up front, so scenario **07n** retains the negative control: told to run one out-of-workspace write, not to escalate and to quote any error, codex produced **0 tool calls, 0 permission requests**, wrote nothing, ended the turn `end_turn`, and reported the denial only in prose — `zsh:1: operation not permitted: …/out/perm/codex-denied`. Transcript: `codex/07n-sandbox-denied.ndjson`. A Syntaur chat rendering only tool calls would show a turn in which nothing happened.
- Part C (codex, allow-all): `read-only` → 1 request, written; `agent` → 0 requests (Guardian), written; `agent-full-access` → 0 requests, written.

### Plan events (08)

- Both emit `sessionUpdate: "plan"` with full-list replace semantics and `pending / in_progress / completed` statuses. claude streams the list as it grows (1, 1, 2, 2, 3 entries, 15 updates); codex emits the complete 3-entry list from the first update (7 updates).

### Thoughts (09)

- `set_config_option effort=high` / `reasoning_effort=high` is accepted by both (response echoes the full `configOptions` list). Neither produced an `agent_thought_chunk` on the arithmetic prompt. codex emits `agent_thought_chunk`s on longer turns (e.g. 4 during `/context`, 2 in 13); claude-agent-acp 0.70 never did in any scenario.
- claude at the inherited `xhigh` effort thinks silently for **25.4 s** on the 12 essay prompt — measured in 12 part A, where the only updates before the first text chunk are `available_commands_update` ×2 and one `usage_update`, neither of which means "the model is working". At `effort=low` the same prompt streams at 4.0 s. codex reaches its first chunk in 1.6 s at the same inherited `xhigh`. Syntaur has no "thinking" signal to render on claude-agent-acp, and a spinner must be driven by the client's own clock.

### Slash commands and config (10)

- Both send one `available_commands_update` on `session/new` (claude 221 commands, codex 140). `/context` as prompt text works on claude (returns a usage table; not present on codex).
- `set_config_option model=<other>` is echoed in the response `currentValue` on both; neither emitted a `config_option_update` notification for it. The model's self-report cannot verify the switch.

### Usage (11)

- claude: 4 `usage_update`s per turn — `used`/`size`, one with `_meta["_claude/rateLimit"]` (`status, resetsAt, rateLimitType, overageStatus…`), the last with `cost {amount, currency}` and `_meta["_claude/origin"]`. `size` is 1 000 000.
- codex: 1 `usage_update` per turn, `used`/`size` only (`size` 258 400); the prompt response's `usage` carries `inputTokens, cachedReadTokens, outputTokens, thoughtTokens` and `_meta.quota`.

### Cancel (12)

Two labelled cases per adapter, because effort changes what a cancel interrupts.

- **Part A, inherited `xhigh` effort** (whatever the user's local config sets — `xhigh` on this machine): cancel is sent at the first chunk or at 45 s, whichever comes first. claude was still silent at 25.4 s; codex had streamed at 1.6 s. `session/cancel` resolves the prompt `cancelled` in **11 ms** (claude) and **19 ms** (codex) either way — cancelling during the silent window works exactly as well as cancelling mid-stream, which is what a UI needs.
- **Part B, `effort=low`**: prompt resolves `cancelled` in 21 ms (claude) / 14 ms (codex) after 3 / 1 streamed chunks, and **no chunk arrives after the response** on either.
- Process trees mid-turn: claude `node` + the SDK's `claude` binary; codex `node` + `node` + the `codex` binary + a `node_repl` spawned from `/Applications/ChatGPT.app` (the `node_repl` tool). SIGTERM to the adapter pid alone leaves nothing on either; the group kill in `close()` leaves nothing.
- The claude adapter also spawns the user's MCP servers as children of its process group (`@playwright/mcp`, `@upstash/context7-mcp`, `firebase-tools mcp` on this machine). They are torn down with the group, but each ACP session pays for booting them — see "Standing context and cost" below.

### Queue vs steer (13) — FAIL on both

Each adapter loses exactly one `session/prompt` request, in a different place. Both rows fail.

- **claude — native queueing works, steering hangs the prompt.** A second `session/prompt` mid-turn is queued: A finishes (`end_turn`, 61.5 s), then B runs and answers `QUEUED` (`end_turn`, 61.3 s from its send), and the stream shows the queued reply only after A. But `_session/steering` mid-turn returns `{outcome: "injected"}` and the agent emits `STEERED` while the original `session/prompt` **never resolves** (90 s timeout here, 240 s in an earlier run). Steering while idle with `idleBehavior: "promptRequired"` also returns `injected`.
- **codex — steering works, concurrent prompting orphans the first request.** A second `session/prompt` is merged into the running turn: the essay streams to completion, `QUEUED` follows as a second message under a new `messageId`, and only the *second* request gets a response — the first is orphaned (240 s timeout). Steering mid-turn returns `injected` and its prompt resolves `end_turn` (32.9 s); steering while idle returns `{outcome: "startedNewTurn"}`.
- Neither adapter's stream echoed the queued user text (`user_message_chunk` 0).
- A client that keeps one in-flight prompt per session and never steers avoids both failures — that is Decision 6, and it is the only shape that behaves identically on the two adapters.

### Load / resume (14)

- Both: `session/load` replays history as `user_message_chunk` + `agent_message_chunk` before the response; `session/resume` replays nothing; both recall the code word afterwards. codex-acp's load also replays `available_commands_update` and `session_info_update`. `mcpServers: []` was sent on both (required on load, optional on resume in SDK 1.4).

### Crash and client death (15, 20)

- SIGKILL of the adapter pid mid-turn: the pending prompt rejects with "ACP connection closed" in ~2 ms and `conn.closed` settles at once on both. On claude the `claude` child survives the adapter's death; on codex nothing survives. `initialize` on a dead adapter rejects with `write EPIPE`.
- Closing the adapter's stdin mid-turn (the client dying): both exit with code 0 (claude in 12 ms, codex in 2 s) and every descendant is gone.

### Embedded context (16)

- A `resource` content block carrying `assignment.md` (5 410 chars) is read without tool calls on both; the acceptance-criterion count and slug come back correctly. Standing-context cost ≈ 1.6–1.7 k tokens per turn on top of the baseline, consistent with ~3.3 chars/token.

### Sub-agents (17, claude)

- The `Task` tool surfaces as a `kind: think` tool call titled `Task`; the sub-agent's own tool calls (`execute` shell commands here) arrive as sibling top-level `tool_call`s on the same session — 11 calls in total, none nested. The parent's narration frames the delegation and relays the summary.

### Concurrency (19)

- Two adapters of the same kind on the same worktree: independent streams (0 cross-session updates), both `end_turn`, the implementer's README edit lands, the planner writes nothing under the target. The claude planner in `plan` mode writes its plan file to `~/.claude/plans/…` (outside the target) — a blanket "no edits" check is wrong for plan mode. Memory: ~620 MB per claude group, ~340 MB per codex group.

### Standing context and cost (11, 16, and the run as a whole)

Measured from `usage_update` across the claude suite, because it is a phase-2 budget input, not a
spike curiosity.

- A fresh claude session starts at **~37 000 tokens** before the first user word (36 824–37 560 across
  the trivial-prompt scenarios 02, 11, 12, 15, 20); a fresh codex session at **~23 300**. That is the
  local agent environment — CLAUDE.md files, skills, 221 slash commands, and the user's MCP servers,
  which the adapter boots as child processes — and it is re-sent every turn.
- claude-agent-acp reports a per-session `cost`. The whole claude suite (24 adapter processes) came to
  **$11.68**; the cheapest non-trivial row, 02, whose entire prompt is one word, cost **$0.75**.
- Consequence for phase 2: per-assignment chat sessions inherit this by default, so each user message
  costs roughly $0.50–1.00 in re-sent standing context, and every open chat forks a copy of the user's
  MCP servers. Syntaur must pin `settingSources` (claude) and the config/plugin set (codex) per session
  and decide which MCP servers a chat session gets — see the last follow-up.

## Corrections to the design doc

- §5.9a step 5 assumed `pending → in_progress → completed`; claude-agent-acp emits `pending → completed`, codex-acp `in_progress → completed`. The renderer keys on the terminal status, not the sequence.
- §5.9a step 5 assumed every tool call carries `content`; codex-acp's parsed `search` calls carry none. Fall back to `rawOutput`.
- §5.9a step 10 assumed a `config_option_update` on model switch; neither adapter sends one. Trust the `set_config_option` response.
- §5.9a step 12's "cancel at 5 s" assumed a chunk within 5 s; at the inherited `xhigh` effort claude's first chunk arrives at 25.4 s. Cancel itself works during the silent window (11 ms), but a cancel-latency measure that wants a *streaming* turn must wait for the first chunk or pin the effort.
- §5.9a step 13's "queue vs steer" is not a single choice, and neither adapter is safe on its own terms: claude queues correctly but its steering leaves the prompt unresolved; codex steers correctly but merges a second prompt into the running turn and orphans the first request. Syntaur holds one in-flight prompt per session, queues the rest itself, and never steers (Decision 6).
- §5.9a step 7 assumed permission requests exist in every non-bypass mode; codex `agent` mode never asks the client (Guardian), and a sandbox-denied command is invisible in the stream (07n).
- §5 assumed the cost of a chat turn is the conversation. A fresh session's inherited environment is ~37 k tokens on claude and ~23 k on codex before the first word, which dominates it.
- `authentication/status` is a private codex-acp extension, not an ACP method; the plan's earlier "no such method" note was corrected.
- `dontAsk` is advertised by the installed 0.70.0 artifact and absent from the adapter's unreleased main.

## Follow-ups (not done here)

- Why codex-acp emits no `tool_call` for a sandbox-denied `exec` (the codex rollout records the same `custom_tool_call` "exec" shape either way).
- Whether Syntaur wants client-side `terminal` support to render live command output (codex-acp's `execute` calls reference a `terminalId`).
- Re-measuring 19's CPU percentages with one suite at a time, if the numbers ever matter.
- `claude-agent-acp` inherits `settingSources` (user hooks, MCP servers, allow rules); codex-acp inherits `~/.codex/config.toml` (plugins, MCP servers, model, effort). Syntaur must pin both per session (phase 2).

## Cursor addendum (2026-09-03, assignment-chat-cursor-harness Task 0)

Measured against `cursor-agent` 2026.09.02-c22c1a3 with live probes (`scripts/spike/acp/cursor-probe.ts`). Fixtures: `src/__tests__/fixtures/acp/cursor/`.

| Scenario | Finding |
|---|---|
| 03 system prompt | `_meta.systemPrompt.append` **not** honoured; `<system>` prepend on first prompt **is** honoured → `systemPromptTransport: 'prompt'` |
| 06 edits + permissions | Agent-mode file edit works; **no** `usage_update`; shell permission options are standard `allow_once` / `allow_always` / `reject_once` with ids `allow-once`, `allow-always`, `reject-once` (observed in 03, not 06) |
| 08 create_plan | Blocking `cursor/create_plan` with `{ toolCallId, name, overview, plan, todos, isProject, phases }`; accept with `{ outcome: { outcome: 'accepted' } }` |
| 09 ask_question | Not observed live in agent mode (agent asked in prose); docs shape used for implementation |
| 14 session/load | Replays `user_message_chunk`, `agent_thought_chunk`, `agent_message_chunk`, `tool_call`, `tool_call_update`; response carries `modes`, `models`, `configOptions`; no `session/resume` |

Usage: cursor emits no `usage_update` → `HarnessSpec.usage: { kind: 'none' }`. Reattach: `loadSession: true`, no resume → broker uses `session/load`.
