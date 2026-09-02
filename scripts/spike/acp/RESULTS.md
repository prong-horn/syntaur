# ACP adapter spike — results

Captured 2026-09-01 on macOS (Darwin 25.3.0), Node 22.22.1, `@agentclientprotocol/sdk` 1.4.0,
`claude-agent-acp` 0.70.0 (Claude Code 2.1.258, `claude.ai` login), `codex-acp` 1.7.0
(codex-cli 0.149.1, ChatGPT login). Both adapters operated on a disposable clone of this
repository at commit `2b3e02b4844b`. Raw transcripts: `src/__tests__/fixtures/acp/` (see its
README and `manifest.json`). Regenerate with the commands in `README.md`.

Rows marked below came from `--only` reruns after a prompt or predicate fix (plan Revisions 2–3):
claude 05, 07, 12, 19; codex 03, 05, 06, 07. Every other row is from the first full run of its suite.
The two suites ran concurrently (one target clone each), so CPU percentages in 19 are noisy;
RSS is not affected.

## Matrix

| # | Scenario | claude-agent-acp 0.70.0 | codex-acp 1.7.0 |
|---|---|---|---|
| 02 | Handshake + trivial prompt | PASS (7.3 s) | PASS (3.7 s) |
| 03 | System prompt transport | PASS (10.0 s) | PASS (10.6 s) |
| 04 | Streaming / coalescing | PASS (15.9 s) | PASS (5.5 s) |
| 05 | Tool calls (read + search) | PASS (17.4 s) | PASS (19.0 s) |
| 06 | Edits / diffs in auto-accept mode | PASS (12.6 s) | PASS (11.5 s) |
| 07 | Permission requests: allow, reject, cancel-while-pending (+ 3 codex modes) | PASS (40.4 s) | PASS (58.6 s) |
| 08 | Plan / todo events | PASS (39.1 s) | PASS (39.8 s) |
| 09 | Thought chunks at high effort | observed (7.3 s) | observed (4.2 s) |
| 10 | Slash commands + config option switch | PASS (6.2 s) | PASS (11.5 s) |
| 11 | Usage updates | PASS (7.0 s) | PASS (3.3 s) |
| 12 | Cancel mid-turn + process hygiene | PASS (10.3 s) | PASS (7.0 s) |
| 13 | Second prompt during a turn; steering | PASS (129.1 s) | PASS (278.5 s) |
| 14 | `session/load` and `session/resume` after adapter restart | PASS (15.3 s) | PASS (11.9 s) |
| 15 | `kill -9` mid-turn | PASS (6.5 s) | PASS (5.9 s) |
| 16 | Embedded resource block + standing-context cost | PASS (6.5 s) | PASS (3.5 s) |
| 17 | Sub-agent (Task tool) rendering | observed (62.4 s) | — (claude only) |
| 19 | Two adapters on the same worktree | PASS (73.9 s) | PASS (28.0 s) |
| 20 | Client closes stdin mid-turn (dashboard/server dies) | PASS (6.3 s) | PASS (7.2 s) |

"PASS" means the structural predicate in `scenarios.ts` held (each predicate is spelled out in
the plan, Task 3). "observed" rows have no predicate. Several rows pass only because a prompt
or predicate was changed after a first failure; those changes and the findings behind them are
in the sections below and in plan Revisions 2–3.

## Measured numbers

| Measure | claude-agent-acp | codex-acp |
|---|---|---|
| Adapter startup to `initialize` response | ~160 ms | ~170 ms |
| First `agent_message_chunk` after a trivial prompt | 4.7–6.3 s | 1.3–1.4 s |
| Streaming (04, ~1.7 kB reply) | 12 chunks over 7.8 s, avg 145 chars, all with `messageId` | 127 chunks over 3.5 s, avg 7 chars, 126/127 with `messageId` |
| Context after first trivial prompt (`usage_update.used`) | 37 507 / 1 000 000 | 23 323 / 258 400 |
| Standing context: same prompt + 5 410-char `resource` block (16) | 39 254 (+1 747 tokens) | 24 881 (+1 558 tokens) |
| Cancel latency (`session/cancel` → prompt resolves `cancelled`) | 25–29 ms | 5–9 ms |
| `session/load` (2-message history) | 1 457 ms, replays 1 user + 1 agent chunk | 393 ms, replays 1 user + 1 agent chunk + `available_commands_update` + 2 `session_info_update` |
| `session/resume` | 1 506 ms, replays nothing | 121 ms, replays nothing |
| Exit after client closes stdin mid-turn (20) | code 0 in 12 ms, 0 of 2 descendants left | code 0 in 2 013 ms, 0 of 4 descendants left |
| Survivors after SIGKILL of the adapter pid alone (15) | the `claude` child keeps running | none |
| Survivors after SIGTERM of the adapter pid alone (12) | none | none |
| RSS per adapter process group, mid-turn (19) | 610–645 MB | 275–345 MB |
| CPU per group (19; noisy, both suites running) | 43–49 % in the first 2 s, then 1–7 % | 82–109 % in the first 2 s, then 0–10 % |
| Queued second prompt (13) | A 32.8 s, B 33.1 s — B answered after A | A never resolves (240 s timeout); B resolves at 36 s carrying A's essay |
| Steer mid-turn (13) | `{outcome:"injected"}`, `STEERED` streamed, prompt never resolves (90 s timeout) | `{outcome:"injected"}`, prompt resolves `end_turn` at 35 s |
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
- A sandbox-denied `exec` (the model's first, unescalated attempt) produces **no** `tool_call` in the ACP stream; only the model's narration mentions it. The prompts now ask the agent to request escalated permissions up front.
- Part C (codex, allow-all): `read-only` → 1 request, written; `agent` → 0 requests (Guardian), written; `agent-full-access` → 0 requests, written.

### Plan events (08)

- Both emit `sessionUpdate: "plan"` with full-list replace semantics and `pending / in_progress / completed` statuses. claude streams the list as it grows (1, 1, 2, 2, 3 entries, 15 updates); codex emits the complete 3-entry list from the first update (7 updates).

### Thoughts (09)

- `set_config_option effort=high` / `reasoning_effort=high` is accepted by both (response echoes the full `configOptions` list). Neither produced an `agent_thought_chunk` on the arithmetic prompt. codex emits `agent_thought_chunk`s on longer turns (e.g. 4 during `/context`, 2 in 13); claude-agent-acp 0.70 never did in any scenario.
- claude at the inherited `xhigh` effort thinks silently for more than 45 s on the 12 essay prompt with no update of any kind between `usage_update` and the first text chunk (probe: `effort=low` streams at ~4 s). Syntaur has no "thinking" signal to render on claude-agent-acp.

### Slash commands and config (10)

- Both send one `available_commands_update` on `session/new` (claude 221 commands, codex 140). `/context` as prompt text works on claude (returns a usage table; not present on codex).
- `set_config_option model=<other>` is echoed in the response `currentValue` on both; neither emitted a `config_option_update` notification for it. The model's self-report cannot verify the switch.

### Usage (11)

- claude: 4 `usage_update`s per turn — `used`/`size`, one with `_meta["_claude/rateLimit"]` (`status, resetsAt, rateLimitType, overageStatus…`), the last with `cost {amount, currency}` and `_meta["_claude/origin"]`. `size` is 1 000 000.
- codex: 1 `usage_update` per turn, `used`/`size` only (`size` 258 400); the prompt response's `usage` carries `inputTokens, cachedReadTokens, outputTokens, thoughtTokens` and `_meta.quota`.

### Cancel (12)

- Both resolve the in-flight prompt `cancelled` within tens of ms of `session/cancel`; no chunks arrive after the response. Process trees mid-turn: claude `node` + the SDK's `claude` binary; codex `node` + `node` + the `codex` binary + a `node_repl` spawned from `/Applications/ChatGPT.app` (the `node_repl` tool). SIGTERM to the adapter pid alone leaves nothing on either; the group kill in `close()` leaves nothing.

### Queue vs steer (13)

- claude: a second `session/prompt` mid-turn is **queued** — A finishes (`end_turn`, 32.8 s), then B runs and answers `QUEUED` (`end_turn`, 33.1 s from its send); the stream shows the queued reply only after A. `_session/steering` mid-turn returns `{outcome: "injected"}` and the agent emits `STEERED`, but the original `session/prompt` **never resolves** (90 s timeout, and 240 s in the first run). Steering while idle with `idleBehavior: "promptRequired"` also returns `injected`.
- codex: a second `session/prompt` mid-turn is **merged into the running turn**: the essay streams to completion, `QUEUED` follows as a second message in the same turn, and only the *second* request gets a response — the first `session/prompt` is orphaned (240 s timeout). Steering mid-turn returns `injected` and the prompt resolves `end_turn` (35 s); steering while idle returns `{outcome: "startedNewTurn"}`.
- Neither adapter's stream echoed the queued user text (`user_message_chunk` 0).

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

## Corrections to the design doc

- §5.9a step 5 assumed `pending → in_progress → completed`; claude-agent-acp emits `pending → completed`, codex-acp `in_progress → completed`. The renderer keys on the terminal status, not the sequence.
- §5.9a step 5 assumed every tool call carries `content`; codex-acp's parsed `search` calls carry none. Fall back to `rawOutput`.
- §5.9a step 10 assumed a `config_option_update` on model switch; neither adapter sends one. Trust the `set_config_option` response.
- §5.9a step 12's "cancel at 5 s" assumed a chunk within 5 s; at the inherited `xhigh` effort claude produces nothing for > 45 s. Any cancel-latency measure must wait for the first chunk.
- §5.9a step 13's "queue vs steer" is not a single choice: claude queues but its steering hangs the prompt; codex steers but merges a second prompt into the running turn and orphans the first request. Syntaur must serialize prompts client-side on codex and must not rely on steering on claude.
- §5.9a step 7 assumed permission requests exist in every non-bypass mode; codex `agent` mode never asks the client (Guardian), and a sandbox-denied command is invisible in the stream.
- `authentication/status` is a private codex-acp extension, not an ACP method; the plan's earlier "no such method" note was corrected.
- `dontAsk` is advertised by the installed 0.70.0 artifact and absent from the adapter's unreleased main.

## Follow-ups (not done here)

- Why codex-acp emits no `tool_call` for a sandbox-denied `exec` (the codex rollout records the same `custom_tool_call` "exec" shape either way).
- Whether Syntaur wants client-side `terminal` support to render live command output (codex-acp's `execute` calls reference a `terminalId`).
- Re-measuring 19's CPU percentages with one suite at a time, if the numbers ever matter.
- `claude-agent-acp` inherits `settingSources` (user hooks, MCP servers, allow rules); codex-acp inherits `~/.codex/config.toml` (plugins, MCP servers, model, effort). Syntaur must pin both per session (phase 2).
