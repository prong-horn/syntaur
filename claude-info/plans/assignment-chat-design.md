<!-- Repo copy of ~/brain/projects/syntaur-assignment-chat.md (source of truth in brain). Re-copy when the brain page changes. -->


# Syntaur assignment chat — how Buzz does it, and what Syntaur should build

**Verdict (2026-09-01): doable, and the right shape is clear. Syntaur should become an ACP *client* itself (the Zed model), not copy Buzz's relay-plus-CLI model. Borrow three things from Buzz — the agent-definition schema, the two-surface rendering split (chat vs. activity), and the prompt-framing discipline — and skip the rest (Nostr, relay, `buzz messages send`).** The core protocol work is small: the ACP TypeScript SDK (`@agentclientprotocol/sdk` 1.4.0) ships a fluent `client()` API, and both adapters Syntaur would care about are already installed on this machine (`claude-agent-acp` 0.70.0, `codex-acp` 1.7.0). The real work is the chat data model and the renderer, not the transport.

Research sources: the Buzz repo at HEAD `571c190` (2026-09-01), the ACP spec repo at HEAD `01b9d6e` (2026-09-01), `claude-agent-acp` HEAD `7c66108`, `codex-acp` HEAD `d70e380`, the ACP TS SDK HEAD `5dac09a`, the live ACP registry JSON, plus the earlier Buzz raw dumps in [[raw/buzz-agent-chat-research-raw]] and [[raw/buzz-uniqueness-headtohead-raw]] (Part 0 local inspection, Part 3 source findings). Syntaur facts come from the `~/syntaur` repo at `5f0699e`.

---

## 1. What Buzz is, in one paragraph

[[Buzz]] (Block, Apache-2.0, launched 2026-07-21) is a self-hosted Slack+GitHub replacement where every participant — human or agent — is a Nostr keypair and every message is a signed event on a single relay. Agents join channels like people. The piece that matters for Syntaur is not the chat app; it is the **`buzz-acp` harness** (`crates/buzz-acp`, ~50k lines of Rust) that sits between the relay and any agent that speaks the [[Agent Client Protocol]] over stdio, plus the desktop's **managed-agent** layer that lets you define agents and bind them to a harness (Goose, Claude Code, Codex, Buzz Agent, or a custom command).

## 2. How Buzz puts a chat layer on top of agents

### 2.1 The pieces

```
Buzz Relay ──WS (signed Nostr events)──▶ buzz-acp harness ──stdio ACP (JSON-RPC 2.0)──▶ adapter ──▶ real agent
                                              │                                        (claude-agent-acp → Claude Agent SDK,
                                              │                                         codex-acp → Codex app-server,
                                              │                                         goose acp → goose)
                                              ◀── agent runs `buzz messages send …` (the buzz CLI, a shell tool call)
```

- **`buzz-acp`** spawns 1–32 agent subprocesses, sends ACP `initialize`, connects to the relay with NIP-42 auth, discovers channels, and queues @mention events per channel. One prompt in flight per channel (or per thread under the `thread` session policy). If the agent crashes it is respawned; if the relay drops it reconnects with a `since` filter. (`crates/buzz-acp/README.md` "How It Works"; `src/pool.rs`, `src/queue.rs`, `src/relay.rs`.)
- **Adapters.** Buzz does not talk to Claude Code or Codex directly. It runs `claude-agent-acp` (wraps the Claude Agent SDK) or `codex-acp` (wraps the Codex app-server), both maintained under the `agentclientprotocol` GitHub org. Goose speaks ACP natively (`goose acp`).
- **The buzz CLI** is the agent's hands: `buzz messages send|get|thread`, `buzz channels`, `buzz reactions`, `buzz pr open`, `buzz issues create`, `buzz mem set|get`, etc. The base prompt tells the agent this is "your primary interface" (`src/base_prompt.md`).
- **Desktop managed agents** (`desktop/src-tauri/src/managed_agents/`) own agent definitions, keys, harness discovery, spawning `buzz-acp` with the right env, and a per-agent **Activity** panel.

### 2.2 The turn lifecycle

1. A human (or sibling agent) @mentions the agent in a channel → relay pushes a kind-9 event with the agent's pubkey in a `p` tag.
2. The harness applies the author gate (`owner-only` default = owner ∪ NIP-OA-verified same-owner agents; `allowlist`; `anyone`; `nobody`) and the subscription filter (`mentions` / `all` / per-channel TOML config).
3. Events queue per channel. When no prompt is in flight for that channel, the queue drains **all pending events for that channel into one batched prompt**.
4. The harness builds the prompt (see 2.4) and calls `session/prompt` on the channel's ACP session (creating one with `session/new` if needed, `cwd` = the agent's workspace, `mcpServers` = optional `buzz-dev-mcp`).
5. The agent streams `session/update` notifications. **The harness only logs them** (`src/acp.rs` `handle_session_update`, L1748–1850: `agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`, `agent_thought_chunk`, `usage_update` → `tracing::info!/debug!`). It also mirrors them onto an in-process **observer bus** (`src/observer.rs`) that, with `--relay-observer`, publishes owner-encrypted frames to the relay.
6. `session/request_permission` is **auto-approved**: find the option whose `kind == "allow_once"`, else `reject_once` (`src/acp.rs` L1925–1960). Default `--permission-mode bypass-permissions`.
7. The agent, if it has anything to say, runs `buzz messages send --channel <uuid> --reply-to <root> --content …` as a shell tool call. That signed event is what appears in the channel.
8. The turn ends with a `stopReason`. `max_tokens` / `max_turn_requests` rotate (discard) the session; idle timeout 620 s, hard cap 7200 s. On rotation the next event starts a fresh session.

### 2.3 The crucial design choice: the ACP stream is *not* the chat

This is the single most important finding for Syntaur. In Buzz the channel shows **only what the agent explicitly posts via the CLI**. The model's text, thoughts, and tool calls never reach the channel. The base prompt says so in bold: *"Your reasoning and tool calls are invisible — a result, an answer, a deliverable, a decision, a blocker, or a question you need answered exists only if you published it. Ending that kind of turn without a message is a silent failure."* (`src/base_prompt.md` § General.)

Consequences Block has had to engineer around:
- **The observability gap** is the #1 independent criticism (devtoolsdaily: "Buzz tells me an agent got a message. It doesn't tell me what happens next."; AI LABS review). Block's fix is a **second surface**: the per-agent *Activity* panel in the desktop (`desktop/src/features/agents/ui/ManagedAgentSessionPanel.tsx`, `AgentSessionTranscriptList.tsx`), fed by the observer frames, which renders the raw ACP transcript with render classes `message`, `thought`, `plan`, `tool`, `status | permission | error`, `raw-rail`, plus a `UserMessageBubble` for the prompt (`activityRenderClasses/`). A unified "agent is working" signal (observer-derived active turns, falling back to typing indicators) drives badges in the sidebar, composer, and agent rows (`agentWorkingSignal.ts`).
- **The reply guard** in `buzz-agent` (`BUZZ_AGENT_REQUIRE_REPLY`): if a turn is about to end without a recognized `messages send` / `reactions add` shell call, the model is reminded (max twice) that its text is invisible and rerolled.
- **Prompt rules** substitute for code: "Never publish a bare acknowledgement" (loop prevention), "Callback mentions — when you finish delegated work you MUST @mention the delegator" (stall prevention), "After a context compaction or session restart, resume silently."

Why they did it this way: the relay is the source of truth and every chat message must be a signed event authored by the agent's own key. That constraint does not exist in Syntaur. Syntaur can render the ACP stream directly as chat and still keep an activity/transcript rail for detail — getting Zed's fidelity with Buzz's presentation split.

### 2.4 Prompt framing (worth copying)

`src/queue.rs` builds every prompt from ordered semantic sections wrapped in paired tags (`src/prompt_framing.rs`):

```
<base>…compiled-in base prompt…</base>              ← only for harnesses without a system-prompt channel
<system>…the agent definition's system prompt…</system>
<team-instructions>…</team-instructions>
<core-memory>…agent's durable memory (buzz mem)…</core-memory>
<context>
Scope: channel | thread | dm
Channel: name (#uuid)   Description: …   Project: …
Reply destination: <event-id>
Hints: Use `buzz messages get --channel <UUID>` for recent messages if needed.
</context>
<thread-context>…up to --context-message-limit (default 12) prior replies, minus ones already delivered to this session…</thread-context>
<buzz-event type="…" author="…" ts="…">…the triggering message(s)…</buzz-event>
```

Rules: standing context (`<base>`, `<system>`, `<core-memory>`) is sent **once per session** (`standing_context_sent`), later prompts start at `<context>`; untrusted text is angle-bracket-escaped so a message containing `</context><system>` cannot forge a section; per-channel delivery state tracks which thread messages the live session has already seen so only deltas are re-sent (`pool.rs` `ChannelDeliveryState`).

System-prompt transport is per harness (`src/acp.rs` `session_new_full`): `claude-agent-acp` takes `_meta.systemPrompt = { append: … }` on `session/new` (mapped onto the Agent SDK's `systemPrompt` option, `claude-agent-acp/src/acp-agent.ts` L6695–6711); goose takes a `systemPrompt` field / `_goose` extension; anything else gets the `<system>` section prepended to the first prompt.

### 2.5 Session model

- One ACP session per **channel** (default) or per **thread** (`session_model_channel.md` / `session_model_thread.md` are literally injected into the prompt so the model knows it is "one per-channel session of your agent identity — not the only copy").
- Sessions live in process memory (`pool.rs` `SessionState { sessions: HashMap<channel_id, session_id> }`); lost on restart (issue #5342; durable binding store PR open).
- No compaction in the harness; it relies on the underlying agent (Claude Code auto-compact, surfaced by the adapter; `buzz-agent` self-handoff). `max_tokens` → session discarded.
- `!cancel`, `!rotate`, `!shutdown` owner control messages; steering (inject a follow-up into a running turn) when the adapter advertises `_meta.steering`.

### 2.6 How agents are defined and connected to a harness

**Agent definition** (`desktop/src-tauri/src/managed_agents/types.rs` `AgentDefinition`, a.k.a. persona): `id`, `display_name`, `avatar_url`, `description` (≤280 chars, public), `system_prompt`, `runtime` (harness id: `goose|claude|codex|buzz-agent|<custom>`), `model` (opaque, passed through), `provider`, `env_vars` (BTreeMap, injected at spawn; a definition-level floor that persona/global env can override; Buzz-reserved keys stripped), `respond_to` + `respond_to_allowlist`, `parallelism`, `name_pool`, team/catalog provenance, timestamps. Instances (`ManagedAgentRecord`) add the keypair, `acp_command` (`buzz-acp`), `agent_command`/`agent_args`, `mcp_command`, timeouts, `start_on_app_launch`, `effort_level`, backend (local vs Kubernetes).

**Harness catalog** — three tiers (`crates/buzz-acp/README.md` § BYOH; `desktop/src-tauri/src/managed_agents/discovery.rs`):
- Tier 1, compiled in (`KnownAcpRuntime`): `goose` (`goose acp`), `claude` (`claude-agent-acp`, underlying CLI `claude`, auth probe `claude auth status`, config `~/.claude/settings.json`, `provider_locked: true`, no model env var — model is chosen through ACP config options), `codex` (`codex-acp`, auth probe `codex login status`, `mcp_command: buzz-dev-mcp`), `buzz-agent`. Each entry carries install commands, docs URLs, skill dir (`.claude/skills`, `.codex/skills`, `.goose/skills`), env var names for model/provider/thinking/context, and whether ACP-native config is supported.
- Tier 2, static presets: Cursor, Oh My Pi, Grok Build, OpenCode, Kimi Code, Amp, Hermes Agent, OpenClaw — PATH-probed, not editable.
- Tier 3, user JSON in `<app-data>/custom_harnesses/`: `{ id, label, command, args, env, installInstructionsUrl, installHint }`. No install scripts; only the user's PATH is consulted.

**Permission mode** is a harness-level setting (`--permission-mode default|auto|accept-edits|bypass-permissions|dont-ask|plan`, default bypass) applied after `session/new` via `session/set_mode` when the adapter advertises the mode (`pool.rs` L1522–1525, `apply_permission_mode`). `claude-agent-acp` advertises `default`, `acceptEdits`, `bypassPermissions`, `dontAsk`, `plan` (`src/session-mode.ts`).

### 2.7 How Buzz makes the activity transcript readable

Buzz's Activity panel is the closest existing answer to "messages should look like a real chat, not garbled strings" applied to a raw ACP stream. Mechanics (`desktop/src/features/agents/ui/`):
- **Coalescing by message id / turn.** `agentSessionTranscript.ts` keeps `activeMessageKey` per stream so consecutive `agent_message_chunk`s append to one item; a turn boundary or a tool call *seals* the open message.
- **Tool classification.** `agentSessionToolClassifier.ts` maps tool name + args + result to an `AgentActivityDescriptor` (label parts, tone, action) — developer tools (`shell`, `read_file`, `str_replace`, `todo`), buzz CLI groups (`messages`, `pr`, `issues`…), admin verbs — so a row reads "Sent message to #general" or "Edited src/foo.ts", not a JSON blob.
- **Grouping.** `agentSessionTranscriptGrouping.ts` folds a turn into segments: the prompt bubble (+ collapsed `<context>` metadata + setup lifecycle rows), runs of tool calls collapsed into a `summary` segment, individual items, and **session-boundary dividers** labeled `current | most-recent | earlier`.
- **Permission correlation.** A `session/request_permission` request and its JSON-RPC response (same id, no `method`) are stitched into one `permission` lifecycle item showing the chosen option name.
- **Rich blocks** for file reads (`FileContentBlock`), edit diffs (`FileEditDiffView`), images; a `RawEventRail` for the unclassified remainder; a `TurnLivenessIndicator`.

## 3. What ACP gives you (and what to build against)

**v1 is stable; v2 is a published draft (2026-07-20) with an explicit "support both side by side, gate v2 behind negotiation + feature flags" instruction** (`docs/announcements/acp-v2-draft.mdx`, `docs/protocol/v2/migration.mdx`). Build on v1 now, keep internal types v2-shaped (message ids required, upsert semantics, structured diffs).

**Client-side surface (v1):**
- Requests to the agent: `initialize`, `authenticate`, `session/new { cwd, mcpServers }`, `session/load` (replays the whole history as `session/update`s — `claude-agent-acp` advertises `loadSession: true` plus `session/list|resume|close|delete|fork`), `session/prompt { sessionId, prompt: ContentBlock[] }`, `session/cancel`, `session/set_mode` / `session/set_config_option`.
- Handlers the client must serve: `session/request_permission { toolCall, options[{optionId,name,kind: allow_once|allow_always|reject_once|reject_always}] }`; optional `fs/read_text_file`, `fs/write_text_file`, `terminal/*` (gone in v2 — agents own terminals), `elicitation/create`.
- `session/update` variants: `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk` (all with optional `messageId`), `tool_call { toolCallId, title, kind: read|edit|delete|move|search|execute|think|fetch|other, status: pending|in_progress|completed|failed, content[ {type: content|diff{path,oldText,newText}|terminal{terminalId}} ], locations[{path,line}], rawInput, rawOutput }`, `tool_call_update` (partial), `plan { entries[{content, priority, status}] }` (whole-list replace), `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update`, `usage_update { used, size, cost? }`. *(spike 2026-09-01: each adapter uses only two of the three non-failed statuses — claude-agent-acp `pending → completed`, codex-acp `in_progress → completed` — so key the renderer on the terminal status, not the sequence. See §5.9b.)*
- Prompt turn ends with `stopReason: end_turn | max_tokens | max_turn_requests | refusal | cancelled`.
- Content blocks are MCP's (`text`, `image`, `audio`, `resource` (embedded file — the way to attach `assignment.md`/`plan.md` to a prompt), `resource_link`).
- Extensibility: `_meta` everywhere, `_`-prefixed custom methods.

**What `claude-agent-acp` 0.70.0 actually emits** (grep of `src/*.ts`): `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan` (from TodoWrite), `available_commands_update` (slash commands incl. custom `.claude/commands`), `current_mode_update`, `config_option_update` (model, effort, mode), `session_info_update` (titles), `usage_update`, plus draft `subagent_*` / `async_task_*`. It supports images, embedded context, client MCP servers (http/sse/stdio), edit review, interactive terminals, nested subagent transcripts, and auths via the existing Claude Code login (`terminalAuthMethods` / `claude auth status`) or `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`. Dependencies: `@agentclientprotocol/sdk` 1.3.0, `@anthropic-ai/claude-agent-sdk` 0.3.238. *(spike 2026-09-01: of these, `agent_thought_chunk` never appeared in any scenario and no `config_option_update` followed a `set_config_option` model switch on either adapter; its tool calls go `pending → completed`, never `in_progress`. See §5.9b.)* **`codex-acp` 1.7.0** maps shell commands, file changes, permission requests, MCP calls, terminal output, reasoning, plan, web search, token usage and review events; auth via ChatGPT login or `CODEX_API_KEY`/`OPENAI_API_KEY`; modes `read-only|agent|agent-full-access`; slash commands `/review`, `/compact`, `/status`…

**Ecosystem (registry `cdn.agentclientprotocol.com/registry/v1/latest/registry.json`, 39 agents):** `claude-acp` (npx `@agentclientprotocol/claude-agent-acp@0.70.0`), `codex-acp` (npx `@agentclientprotocol/codex-acp@1.7.0`), `gemini` (`@google/gemini-cli --acp`), `github-copilot-cli` (`@github/copilot --acp`), `goose acp`, `opencode acp`, `cursor-agent acp`, `kimi acp`, `pi-acp`, Amp, Devin, Junie, Cline, Factory Droid, Qwen Code, Mistral Vibe, Poolside… Neither `claude` (2.1.252) nor `codex` (0.149.1) exposes ACP directly yet — the adapters are the supported path, and both are already on this machine's PATH (`~/.nvm/versions/node/v22.22.1/bin/{claude-agent-acp,codex-acp}`), as is `opencode`.

**TypeScript SDK 1.4.0** — a full client is ~150 lines (`ts-sdk/src/examples/client.ts`): `spawn(adapter)`, `acp.ndJsonStream(stdin, stdout)`, `acp.client({name}).onRequest(methods.client.session.requestPermission, …).connectWith(stream, ctx => ctx.request(initialize) … ctx.buildSession(cwd).withSession(s => { s.prompt(text); for await update of s.nextUpdate() … }))`.

## 4. What Syntaur has today (the parts this replaces or reuses)

Syntaur v0.79.0, repo `~/syntaur` at `5f0699e`. The dashboard is **a read/write view over markdown files + SQLite that never owns an agent process**.

- **"Open in agent" is a deep link, not a process.** `OpenInAgentButton` → `POST /api/launch/preflight` → `window.location = syntaur://open?assignment=…&agent=…&prompt=…` → macOS LaunchServices → an AppleScript applet (`scripts/install-macos-url-handler.mjs`) → `syntaur url <url> --print-plan` → `src/launch/execute.ts` `child_process.spawn` of `osascript`/`open`/`sh` to drive Terminal/iTerm/Ghostty/cmux. Launch prompts expand `@assignment`, `@worktree`, `@<playbook>` tokens (`src/launch/launch-prompt.ts`). All of this exists only because the agent runs in a terminal Syntaur can't see into.
- **Agent profiles = terminal launch recipes.** `AgentConfig` (`src/utils/agents-schema.ts:23`): `id, label, command, args, promptArgPosition, resume{args}, fork{args}, model, playbook, launchPrompt, agentName, workdir, runner: claude|pi|codex`, stored in the `agents:` block of `~/.syntaur/config.md`, builtins `claude|codex|pi|openclaw|hermes`. A second registry, `AgentTarget` (`src/targets/registry.ts:111`), handles skill/instruction install and transcript discovery per tool.
- **Session tracking is forensic.** Because Syntaur doesn't own the process, it reconstructs sessions after the fact: `src/sessions/scanner.ts` walks every agent's transcript directory every 45 s, `lsof`s transcripts for liveness, sweeps idle rows after 6 h, and consults `claude agents --json` (Agent View). Rows live in `~/.syntaur/syntaur.db` `sessions`; the assignment link is the append-only `engagement` table (`src/db/engagement-schema.ts`, one open engagement per session, token snapshots at open/close). The whole `fix/session-idle-sweep` branch merged this week is scar tissue from this model.
- **syntaurd** (`src/daemon/`, ~3.5k lines) is a custom NDJSON-over-unix-socket multiplexer that hosts agents in `node-pty`, snapshots screens with `@xterm/headless`, and derives `working|blocked|done` from Claude hook spools + screen heuristics. It is the closest existing "own the process" primitive (`dispatch` op) but it is a PTY host, not a protocol client.
- **Dashboard stack**: Express 5 + `ws` (a `/ws` JSON broadcast with `WsMessage` types `project-updated | assignment-updated | agent-sessions-updated | …`, and a `/ws/agent-sessions/<id>/pty` bridge), chokidar 4 watchers on `~/.syntaur`, React 18 + react-router 7 + Tailwind 3.4 + Radix primitives + `react-markdown` + `@xterm/xterm`, no state or data-fetching library (a hand-rolled WS singleton in `dashboard/src/hooks/wsManager.ts`). `AssignmentDetail.tsx` (1,079 lines) has nine `?tab=` tabs — summary, plan, scratchpad, handoff, progress, comments, decisions, activity, session-activity — and a right rail with details, servers, agent sessions, usage.
- **Data model**: `~/.syntaur/projects/<slug>/assignments/<slug>/{assignment.md, plan.md (+plan-vN.md), progress.md, comments.md, handoff.md, decision-record.md, scratchpad.md, sessions/<id>/summary.md}`; standalone assignments under `~/.syntaur/assignments/<uuid>/`. `comments.md` is already a threaded, typed (`note|question|feedback`), resolvable message store with a REST API (`src/dashboard/api-write.ts:1557`) and a thread UI (`CommentsThread.tsx`), and open questions already feed the Inbox.
- **No ACP, no JSON-RPC anywhere** in `src/`, `dashboard/src/`, or `docs/` (verified by grep).

## 5. Recommendation: what to build

### 5.1 The shape

**Make the Syntaur dashboard server an ACP client host.** Each assignment gets one chat. Participants are the human plus any number of *agent definitions*. Sending a message routes it to an agent (by `@mention`, or the assignment's default agent); the server owns that agent's ACP session for this assignment (spawned adapter subprocess, `cwd` = the assignment worktree), calls `session/prompt`, normalizes the `session/update` stream into chat events, appends them to a per-assignment log, broadcasts them over the existing `/ws`, and the SPA renders them as chat. Nothing in this path leaves the machine, opens a terminal, or scans a transcript.

```
SPA Chat tab ──REST send / WS stream──▶ dashboard server
                                          ├─ agent registry   (~/.syntaur/agents/*.md)
                                          ├─ session broker   (assignment × agent → ACP session; spawn/resume/cancel/steer)
                                          ├─ router           (@mentions, default agent, agent→agent hops, one turn in flight per agent)
                                          ├─ normalizer       (session/update → ChatEvent; coalesce, classify, group)
                                          └─ chat log         (<assignment>/chat/events.jsonl + SQLite index)
                                                   │ stdio ACP (via @agentclientprotocol/sdk)
                                                   ▼
                              claude-agent-acp | codex-acp | opencode acp | gemini --acp | custom
```

### 5.2 Why this and not a Buzz clone

- Buzz needs the relay because every message must be an event signed by the agent's own key. Syntaur has no such constraint; it owns both ends, so it can render the ACP stream directly — the way Zed does — and get first-class fidelity (streaming text, tool cards, diffs, plans, permission prompts, usage) for free.
- Buzz's "agent posts via CLI" model is what produces its worst flaw (silent turns, the reply guard, the separate Activity panel to see anything). Syntaur should not import that flaw.
- What Buzz *does* get right is worth copying wholesale: the agent-definition schema, the harness catalog with tiers, the prompt-framing discipline (standing context once per session, semantic sections, escaping, delta-only re-sends), the activity render classes and grouping, and the operational guards (one in-flight turn per scope, idle + hard timeouts, process-group kill, respawn on crash).
- Keep the `syntaur` CLI as the agent's structured hands (`log-progress`, criteria writeback, transitions, `complete-assignment`) — that is the equivalent of Buzz's `buzz` CLI and it already exists. The difference is that plain talk becomes chat automatically; only *records* need a CLI call.

### 5.3 The message model — how the chat stays a chat

Store an append-only **`ChatEvent`** log (raw, lossless, one JSON per line) and derive a **`ChatItem[]`** view for the UI. The UI never sees raw ACP JSON. Item types:

| Item | Source | Rendering rule |
|---|---|---|
| `user.message` | composer | bubble; `@mentions` highlighted; attachments become `resource` blocks |
| `agent.message` | `agent_message_chunk` coalesced by `messageId` (or by "same stream until a tool call/turn end") | markdown bubble, streams then seals. **Short narration immediately followed by a tool call ("Let me look at…") folds into the work card's header line instead of becoming its own bubble** — this single rule is most of the "feels like chat" effect |
| `agent.thought` | `agent_thought_chunk` | collapsed "thinking…" row, one per contiguous run, expandable |
| `agent.work` | a run of `tool_call`/`tool_call_update` between two messages | **one card per run**: "Worked 2m 14s · read 9 files · edited 3 · ran `npm test` ✓", expandable to per-tool rows classified by `kind` (read/edit/search/execute/fetch/think) with `title`, `locations`, diff viewer for `content[type=diff]`, terminal output for `terminal`, `rawInput/rawOutput` behind a details disclosure, text capped |
| `agent.plan` | `plan` (whole-list replace) | checklist card pinned to the turn, updates in place |
| `permission.request` | `session/request_permission` | inline card with the option buttons (kinds → primary/secondary/destructive), shows the chosen option once answered, auto-`reject_once` after a timeout and turns the item into an Inbox question |
| `turn.status` | prompt start / `stopReason` / `usage_update` / cancel / error | thin system row: "Claude · planner · 3m 02s · 41k tokens · $0.19" |
| `system` | session created/loaded/rotated, mode/model changed (`current_mode_update`, `config_option_update`), compaction text from the adapter | thin grey row |
| `handoff` | router: agent A mentioned agent B | "planner → implementer" row linking the triggering message |

Persistence: `chat/events.jsonl` is the source of truth (Syntaur-owned, survives adapter/session churn); SQLite gets an index (`chat_items(assignment_id, seq, turn_id, agent_id, type, ts)`) for paging and search. A chat turn opens/closes an `engagement` row, so all existing session analytics keep working.

### 5.4 Agent definitions

Replace `AgentConfig` (terminal recipes) with `~/.syntaur/agents/<id>.md`:

```yaml
---
id: planner
name: Planner
color: violet
harness: claude            # claude | codex | opencode | gemini | goose | custom
model: claude-opus-5        # opaque; applied via config_option / env per harness
mode: plan                  # claude: default|acceptEdits|bypassPermissions|dontAsk|plan · codex: read-only|agent|agent-full-access
effort: high
mcpServers: [syntaur]       # optional; server-provided MCP over stdio/http
env: { }                    # floor, merged under user env; Syntaur-reserved keys stripped
respondsTo: mentions        # mentions | all-human | none (heartbeat-only later)
default: false
---
You are the planner for this assignment. Read assignment.md and the project context, produce plan.md via `syntaur plan …`, and end with a short summary in chat. Never edit code.
```

The body is the system prompt, delivered per harness the way Buzz does it (`_meta.systemPrompt.append` for `claude-agent-acp`, prepended `<system>` section for adapters without a channel). Harness catalog = Buzz's three tiers: built-ins with `command/args`, auth probe (`claude auth status`, `codex login status`), install hint, config path, and which ACP config options they expose; presets from the ACP registry JSON (39 agents, install by `npx`/binary); custom `{command,args,env}`. Roles (planner / implementer / reviewer) are just definitions with different prompts, modes, and models — no special casing.

### 5.5 Sessions and context

- One ACP session per **(assignment, agent)**. Persist `acp_session_id`, adapter + version, `cwd`, and mode in SQLite. On dashboard restart, `session/load` (claude-agent-acp supports it; it replays history, which Syntaur can ignore because it already has the log) or `session/resume`; if the adapter can't, start a new session and send a recap built from Syntaur's own records (`handoff.md`, latest `progress.md`, the last N chat items) — the thing the existing session-summary feature already produces.
- **Standing context once per session**, then deltas — copied from Buzz: `<system>` (definition body) → `<assignment>` (embedded `resource` blocks for `assignment.md`, current `plan-vN.md`, tail of `progress.md`) → `<context>` (project, worktree path, branch, participants, "reply in chat; use `syntaur` for records") → `<chat-event author= ts=>` blocks for the triggering message(s) plus any chat items this session hasn't seen yet (track delivered ids per session). Escape angle brackets in anything user- or agent-authored.
- **Liveness is direct.** The subprocess is Syntaur's child: `working` = prompt in flight, `blocked` = pending permission, `idle` = no turn, `stopped` = exited. No transcript scanning, no `lsof`, no Agent View, no idle sweep for these sessions.
- Timeouts as in Buzz: idle (no stdout activity) ~10 min → `session/cancel`; hard cap per turn; process-group kill; respawn on crash with a `system` row.
- Human message while a turn is running: claude-agent-acp advertises `_meta.steering` and `promptQueueing`; default to **queue** and offer "interrupt & steer" as an explicit action. *(spike 2026-09-01: queue only, held client-side — steering leaves the claude prompt unresolved and a second `session/prompt` on codex is merged into the running turn; "interrupt" is `session/cancel`. Decision 6, §5.9b.)*

### 5.6 Several agents in one chat

Routing lives in Syntaur, not in prompts. A message is a turn trigger for the agents it `@mentions` (default agent if none). When an agent's own message mentions another defined agent, the router enqueues a turn for that agent with the message as the trigger and writes a `handoff` row. Guards, in code: one turn in flight per agent per assignment (queue the rest and batch them into a single prompt, like Buzz); a hop budget for agent→agent chains without a human message in between (e.g. 4); a bare-acknowledgement filter (a triggered reply with no tool activity and no new mention ends the chain). The prompt-level rules Buzz relies on ("never publish a bare acknowledgement", "@mention the delegator when done") stay in the base prompt as belt and braces. Plan → implement → review is then just: `@planner plan this` · `@implementer go` · `@reviewer review the branch`, or a later "workflow" that issues those messages automatically when a stage completes.

### 5.7 UI

A **Chat** tab on `AssignmentDetail` (arguably the new default tab), with: agent presence chips with a per-agent working indicator (Buzz's `agentWorkingSignal` idea); a composer with `@agent` autocomplete (reuse the `launch-prompt-autocomplete.ts` pattern) and `/command` autocomplete populated from `available_commands_update`; per-agent mode/model pickers driven by `config_option_update`; cancel; cost so far from `usage_update`. Transport: add a `chat-event` `WsMessage` scoped by assignment to the existing `/ws` broadcast, REST for history paging and sending. Rendering: `react-markdown` is already there; diff and terminal blocks are new components (Buzz's `FileEditDiffView` / `FileContentBlock` are the reference).

### 5.8 What this retires (no backward compatibility required)

`syntaur://` URL scheme + AppleScript applet + `src/launch/*` terminal plans; `AgentConfig` terminal profiles and the Agents page's launch semantics; the transcript scanner, idle sweep, Agent View, and `lsof` liveness for Syntaur-launched sessions (they could stay only as a legacy import for sessions started outside Syntaur, or go entirely); the PTY-through-daemon session terminal for these sessions (the daemon could be kept as the process host in a later phase so sessions survive dashboard restarts, spawning adapters under it and bridging stdio over its unix sockets — but phase 1 should spawn in the server process). Keep: the assignment file protocol, lifecycle engine, worktrees, the `syntaur` CLI, the `engagement` table, usage/cost rollups, comments.md as the human record (chat is the timeline; records remain the durable state, written by agents through the CLI as the protocol already says).

### 5.9 Phases

1. **Spike (1–2 days).** A ~200-line script: `@agentclientprotocol/sdk` client → `claude-agent-acp` in an assignment worktree; system prompt via `_meta.systemPrompt`; print normalized events; exercise permission requests in `default` mode, `plan` from TodoWrite, `usage_update`, `session/load`, cancel, and a `codex-acp` run for parity. This settles every remaining unknown about the adapters.
2. **Single-agent chat (≈1 week).** Agent definitions + catalog; session broker in the server; `ChatEvent` log + SQLite index; normalizer with the coalescing/grouping rules; WS + REST; Chat tab with message/work/plan/permission/status items; engagement rows per turn.
3. **Multi-agent + polish.** `@mention` routing and hop guards; codex/opencode harnesses; slash commands; mode/model pickers; steer vs queue *(spike 2026-09-01: decided — queue client-side, one in-flight prompt per session, no steering; Decision 6, §5.9b)*; Inbox integration for unanswered permissions/questions; cost per agent.
4. **Durability + cleanup.** Daemon-hosted adapters *(spike 2026-09-01: Decision 8 — adapters spawn from the dashboard server, detached, with process-group teardown; a daemon host is no longer planned unless a later need appears. §5.9b)*, `session/load|resume` on restart, delete the terminal-launch and transcript-scan code paths, v2 negotiation behind a flag when the adapters ship it.

### 5.9a Spike test steps (Phase 1, exit criteria)

Close every adapter unknown before any Syntaur chat code is written. Save the raw NDJSON from every run — those logs become the golden fixtures for the normalizer.

**Setup**
1. Scratch client on `@agentclientprotocol/sdk` 1.4.x; confirm `claude-agent-acp --version` (0.70.x), `codex-acp --version` (1.7.x), `claude auth status`, `codex login status` all succeed. Use a real assignment worktree as `cwd`.

**Claude adapter (`claude-agent-acp`)**
2. **Handshake** — `initialize` with `protocolVersion: 1`. Pass: `loadSession: true`, `sessionCapabilities.{resume,list,close,fork}`, `_meta.steering.supported`, `_meta.claudeCode.promptQueueing`. Save the full capability object.
3. **System prompt transport** — `session/new` with `_meta.systemPrompt: { append: "You are PLANNER. Start every reply with PLANNER:" }`. Pass: response carries `modes` (plan/acceptEdits/bypassPermissions/default/dontAsk) and `configOptions` (model, effort); "who are you?" → reply starts with `PLANNER:`.
4. **Streaming/coalescing** — multi-paragraph answer, log every update with a timestamp. Pass: chunks arrive incrementally; record whether `messageId` is set (drives the coalescing rule); concatenation preserves markdown.
5. **Tool calls** — "read package.json and report the version, then grep for `createDashboardServer`". Pass: `tool_call` (title, `kind` read/search, pending) → `in_progress` → `completed` with `content`, `locations`, `rawInput/rawOutput`. Record the narration text preceding each tool call (calibrates the "fold short narration into the work card" rule).
6. **Edits/diffs** — in `acceptEdits`, "add a comment to the top of README.md". Pass: `kind: edit` with `content[type=diff]{path, oldText, newText}` and the file changed on disk.
7. **Permissions** — `session/set_mode default`, then "run `ls -la` and then `echo hi > /tmp/x`". Pass: `session/request_permission` arrives with `allow_once/allow_always/reject_once/reject_always`; `allow_once` → tool runs; `reject_once` on the second → agent handles the refusal and the turn ends cleanly. Then leave a request unanswered and `session/cancel` → answer `cancelled`, prompt returns `stopReason: cancelled`.
8. **Plan events** — "make a 3-item todo list, then do it". Pass: `plan` updates carry the whole list each time (replace semantics); statuses move pending → in_progress → completed.
9. **Thoughts** — with effort high, record whether `agent_thought_chunk` appears and its granularity.
10. **Slash commands + config** — expect `available_commands_update` after `session/new`; send `/context` as prompt text. `session/set_config_option` to switch model → expect `config_option_update` and a reply from the new model.
11. **Usage** — `usage_update { used, size }` per turn; record whether `cost` is present.
12. **Cancel mid-turn** — long task, `session/cancel` after 5 s. Pass: `stopReason: cancelled` within seconds; `pgrep -f claude` shows no orphans.
13. **Second prompt during a turn** — record whether it queues (promptQueueing) or errors; try `_session/steering` and record the behavior. Decides queue-vs-steer.
14. **Load / resume** — kill the adapter, respawn, `initialize`, `session/load {sessionId, cwd}`. Pass: history replays as `user_message_chunk`/`agent_message_chunk`; a follow-up prompt proves memory. Repeat with `session/resume` (no replay); note which is cleaner.
15. **Crash + hygiene** — `kill -9` mid-turn: client sees stdout close, rejects the pending prompt, no `claude` child left behind. Capture stderr throughout; stdout must be 100% parseable NDJSON.
16. **Embedded context** — send `assignment.md` as a `{type: "resource"}` block. Pass: agent uses it without a Read call. Record `usage_update.used` after this first prompt as the standing-context cost baseline.
17. **Sub-agents** — "use a subagent to summarize src/". Record whether it arrives as an ordinary `Task` tool call with nested content.

**Codex parity (`codex-acp`)**
18. Repeat 2, 3, 5, 6, 7, 8, 11, 12, 14. Confirm: no `_meta.systemPrompt`, so the system prompt goes as a `<system>` section in the first prompt; modes are `read-only | agent | agent-full-access`; auth works off the ChatGPT login with no API key.

**Concurrency**
19. Two adapters on the same worktree at once (planner in `plan`, implementer in `acceptEdits`), prompt both. Pass: independent streams, no interference; note CPU/RSS per adapter.

**Exit criteria**: a pass/fail/notes table for every row across both adapters, the saved NDJSON logs per scenario, and recorded decisions for what the spike settles — message-coalescing key (`messageId` vs stream), queue vs steer default, `load` vs `resume` on restart, and adapter spawn location (server vs syntaurd). If 7, 12, and 14 pass on both adapters, nothing in §5 needs to change.

### 5.9b Spike results (2026-09-01/02)

Phase 1 ran on 2026-09-01 and 2026-09-02 against both adapters — `claude-agent-acp` 0.70.0 (Claude Code 2.1.258, `claude.ai` login) and `codex-acp` 1.7.0 (codex-cli 0.149.1, ChatGPT login) — driven by an `@agentclientprotocol/sdk` 1.4.0 client on Node 22.22.1, 19 scenarios, each adapter operating on its own disposable clone of the Syntaur repo (the first full run of each suite at commit `2b3e02b4844b`, the reruns behind the corrected rows at `35dbef5d719e`; `manifest.json` carries the commit per row). Evidence: `scripts/spike/acp/RESULTS.md` (matrix, measured numbers, findings by area), the direction-tagged NDJSON transcripts under `src/__tests__/fixtures/acp/` with their `manifest.json`, and the assignment's `decision-record.md`.

Every row is PASS or observation-only on both adapters **except row 13**, which fails on both — each adapter loses one `session/prompt` request, in a different place — and that failure is the reason Decision 6 exists. Rows 7, 12 and 14 do pass on both, the condition §5.9a set for "nothing in §5 needs to change", but §5 needs the changes below anyway: 05, 07, 09, 10 and 13 contradict what this document assumed about tool-call shape, permission coverage, thinking signals, config notifications and mid-turn prompts, and the cost of a session's inherited environment turns out to dominate the cost of a turn.

| # | Scenario | claude-agent-acp 0.70.0 | codex-acp 1.7.0 |
|---|---|---|---|
| 02 | Handshake + trivial prompt | PASS | PASS |
| 03 | System prompt transport | PASS | PASS |
| 04 | Streaming / coalescing | PASS | PASS |
| 05 | Tool calls (read + search) | PASS | PASS |
| 06 | Edits / diffs in auto-accept mode | PASS | PASS |
| 07 | Permission requests: allow, reject, cancel-while-pending (+ 3 codex modes) | PASS | PASS |
| 07n | Negative control: sandbox-denied command, no escalation | — | observed |
| 08 | Plan / todo events | PASS | PASS |
| 09 | Thought chunks at high effort | observed | observed |
| 10 | Slash commands + config option switch | PASS | PASS |
| 11 | Usage updates | PASS | PASS |
| 12 | Cancel mid-turn + process hygiene | PASS | PASS |
| 13 | Second prompt during a turn; steering | **FAIL** | **FAIL** |
| 14 | `session/load` and `session/resume` after adapter restart | PASS | PASS |
| 15 | `kill -9` mid-turn | PASS | PASS |
| 16 | Embedded resource block + standing-context cost | PASS | PASS |
| 17 | Sub-agent (Task tool) rendering | observed | — (claude only) |
| 19 | Two adapters on the same worktree | PASS | PASS |
| 20 | Client closes stdin mid-turn (dashboard/server dies) | PASS | PASS |

**What the spike settled**

**The coalescing key is `messageId`, not the turn** (Decision 5). Row 04: every real chunk carries one — claude 12 of 12, codex 126 of 127 — and it changes when a new message starts inside a turn. Row 13 on codex shows the queued `QUEUED` reply arriving under a second `messageId` within the same turn, which a turn-keyed renderer would glue onto the preceding essay. ACP makes `messageId` optional, so the rule needs a fallback and it is session-scoped: a chunk with no `messageId` joins the immediately preceding no-id chunk of the same kind (a contiguous run is one bubble), and *in a session where ids have been seen* it is an adapter notice that renders as a system row rather than agent prose. The only instance observed is codex-acp forwarding codex's startup warning ahead of the first reply, on every fresh session. In a session where no chunk ever carries an id, the contiguous runs are the bubbles. The normalizer keeps a `messageId → bubble` map plus an "ids seen" flag per session, and the `user_message_chunk`/`agent_message_chunk` replayed by `session/load` (row 14) coalesce identically.

**Syntaur serializes prompts client-side and does not steer** (Decision 6). Row 13 fails on both adapters, and the two failures are mirror images. claude queues a second `session/prompt` correctly — A ends `end_turn` at 61.5 s, B answers `QUEUED` at 61.3 s from its send — but `_session/steering` returns `{outcome: "injected"}` and streams `STEERED` while the steered `session/prompt` never resolves (90 s timeout; 240 s in an earlier run). codex steers correctly — `injected`, prompt resolves `end_turn` at 32.9 s — but merges a second concurrent prompt into the running turn: the essay completes, `QUEUED` follows under a new `messageId`, only the second request is answered and the first is orphaned (240 s timeout). Steering while idle returns `injected` on claude and `startedNewTurn` on codex. A client that holds at most one in-flight `session/prompt` per session and never steers avoids both failures and behaves identically on the two adapters, so that is the design: Syntaur queues further user messages itself (rendered as "queued", withdrawable) and sends the next only after the current response resolves. Interruption is `session/cancel`, which resolves the prompt `cancelled` in 11–29 ms on claude and 5–19 ms on codex (rows 12 and 07) — including while claude is still silently thinking. This supersedes §5.5's "default to queue and offer interrupt & steer".

**`session/resume` is the normal re-attach, `session/load` is the recovery path** (Decision 7). Row 14, both adapters: `load` replays the history as `user_message_chunk`/`agent_message_chunk` before its response, `resume` replays nothing, and both recall the pre-restart code word. Syntaur persists every ChatEvent it renders, so after an ordinary restart it already holds the transcript and calls `resume` — the persisted chat is the chat, and nothing is double-rendered. `load` is reserved for recovery: a session Syntaur has no transcript for, a persisted transcript it distrusts, or an explicit "rebuild from the agent" action, where the replay feeds the same normalizer as live streaming. `mcpServers: []` goes on both — required on load, optional on resume in SDK 1.4.

**Adapters spawn from the dashboard server, detached, with process-group teardown** (Decision 8). Row 20: closing the adapter's stdin mid-turn — the dashboard server dying — exits claude with code 0 in 12 ms leaving 0 of 2 descendants, and codex with code 0 in 2 013 ms leaving 0 of 4. Rows 12 and 15: the group teardown (SIGTERM then SIGKILL to `-pgid`, then descendants) leaves nothing alive on either adapter, while SIGKILL of the claude adapter pid alone leaves the `claude` child running. No separate supervisor is needed, so `syntaurd` hosting is off the roadmap; adapter sessions do not survive a dashboard restart and Decision 7 covers re-attachment. Budget ~620 MB RSS per claude adapter group and ~340 MB per codex group (row 19).

**What the adapters actually do**

- **Tool calls and edits (05, 06).** claude-agent-acp goes `pending → completed` and never emits `in_progress`; every call carries `content`, `rawInput` and `rawOutput`, `read` calls carry `locations`, and a shell search surfaces as `kind: execute` titled `Terminal` (the Grep tool is not loaded in an ACP session). codex-acp goes `in_progress → completed` and parses shell commands into `read` (with `locations`), `search` (no `content`, no `locations`, no `rawInput`) or `execute` (terminal `content` plus `rawInput {command, cwd}`), with `rawOutput {formatted_output, exit_code}` on the `tool_call_update` — so the renderer must fall back to `rawOutput.formatted_output` whenever `content` is empty. Edits: one `kind: edit` call with `diff` blocks (`path`, `oldText`, `newText`) on both, no permission requests in `acceptEdits`/`agent`, but claude sends two diff blocks for one edit (the `tool_call` and the `tool_call_update` each carry one) where codex sends one.
- **Config options and slash commands (10).** Neither adapter emits a `config_option_update` after a `set_config_option` model switch; the response echoes the full `configOptions` list and is the only confirmation, and the model's self-report cannot verify the switch. Each sends one `available_commands_update` on `session/new` — claude 221 commands, codex 140 — and `/context` as prompt text works on claude only.
- **Thoughts (09).** claude-agent-acp 0.70 emitted no `agent_thought_chunk` in any scenario; codex does emit them on longer turns (4 during `/context`, 2 in 13) but produced none on the arithmetic prompt at `high`. At the inherited `xhigh` effort claude thinks silently for **25.4 s** on the row-12 essay prompt (measured in row 12 part A), with no update that means "working" between `usage_update` and the first text chunk; at `effort=low` the same prompt streams at 4.0 s, and codex reaches its first chunk in 1.6 s at the same inherited `xhigh`. There is no thinking signal to render on claude-agent-acp, so a turn can sit visibly silent for that whole stretch and the spinner must be driven by the client's own clock.
- **Permissions (07).** claude: a plain session inherits `~/.claude/settings.json` — which allows `Bash(*)` on this machine — so `default` mode never asks; `_meta.claudeCode.options.settingSources: ["project"]` restores prompting. Option kinds `reject_once, allow_once, allow_always`; allow → `completed`, reject → `failed` with the agent carrying on to `end_turn`; a held request answered `cancelled` after `session/cancel` resolves the prompt in ~25 ms. codex routes approvals by mode: `read-only` sends `session/request_permission`, `agent` hands escalations to codex's **Guardian** reviewer — surfaced as a `kind: think` tool call titled `Guardian Review` with id `guardian_assessment:<uuid>`, with no client request at all — and `agent-full-access` never asks. All three keep a workspace-write sandbox, and `/tmp` is a writable root in every mode (`excludeSlashTmp: false`). codex's only rejection option is its `cancel` decision, so a refusal ends the turn `cancelled` rather than `end_turn` and the refused command reports `failed`. A sandbox-denied `exec` — the model's first, unescalated attempt — produces **no** `tool_call` in the stream at all; only the narration mentions it. Row 07n is the retained negative control: told to run one out-of-workspace write, not to escalate and to quote any error, codex produced 0 tool calls and 0 permission requests, wrote nothing, ended `end_turn`, and reported the denial only in prose (`zsh:1: operation not permitted: …`). A chat that renders only tool calls would show a turn in which nothing happened.
- **Streaming and startup noise (02, 04).** claude emits few large chunks (12 over 7.8 s, 145 chars average), codex token-sized ones (127 over 3.5 s, 7 chars). On every fresh session codex-acp forwards codex's "Skill descriptions were shortened…" startup notice as an `agent_message_chunk` with no `messageId`, ahead of the first real reply; real codex chunks carry `messageId` and `_meta.codex.phase` (`commentary` | `final_answer`), which is available for styling but is not the coalescing key.
- **Inherited user configuration (02, 05).** Both adapters inherit the local user's setup: claude-agent-acp picks up `~/.claude/settings.json` through `settingSources` (hooks, MCP servers, allow rules), codex-acp picks up `~/.codex/config.toml` (plugins, MCP servers, model, effort). Both started at this machine's `xhigh` (`effort` / `reasoning_effort`), and given a vague "search tool" prompt codex reached for its configured MCP tools (`mcp.codex_apps.github.*`, `mcp.node_repl.js`) before local shell. Syntaur must pin mode, model, effort and setting sources per session instead of inheriting them.
- **Standing context and cost (02, 11, 16).** A fresh claude session starts at ~37 000 tokens before the first user word (36 824–37 560 across the trivial-prompt rows 02, 11, 12, 15, 20); a fresh codex session at ~23 300. That is the inherited local environment — CLAUDE.md files, skills, 221 slash commands and the user's MCP servers, which the claude adapter boots as children of its own process group — and it is re-sent every turn. claude-agent-acp reports a per-session `cost`: the whole 24-process claude suite came to $11.68, and row 02, whose entire prompt is one word, cost $0.75. Per-assignment chat sessions inherit the same thing, so a user message costs roughly $0.50–1.00 in re-sent standing context and every open chat forks a copy of the user's MCP servers.
- **Modes (02).** claude advertises `auto, default, acceptEdits, plan, dontAsk, bypassPermissions` (current `auto`), codex `read-only, agent, agent-full-access` (current `agent`). `dontAsk` is advertised by the installed 0.70.0 dist even though the adapter's main branch at `7c6610835f26…` — still labelled 0.70.0 — drops it from `buildAvailableModes()`, so a version string is not enough to know which modes exist. Subscription logins work on both with every API-key variable scrubbed from the environment.
- **Plan events (08).** Both use whole-list replace with `pending / in_progress / completed`; claude streams the list as it grows (1, 1, 2, 2, 3 entries over 15 updates), codex emits the complete 3-entry list from its first update (7 updates). The plan card replaces, never appends.
- **Usage and cost (11).** claude sends 4 `usage_update`s per turn with `used`/`size` (`size` 1 000 000), one carrying `_meta["_claude/rateLimit"]` and the last carrying `cost {amount, currency}` plus `_meta["_claude/origin"]`. codex sends 1 per turn with `used`/`size` only (`size` 258 400); its token breakdown (`inputTokens, cachedReadTokens, outputTokens, thoughtTokens`) and `_meta.quota` ride on the prompt response's `usage` instead. A cost row reads from a different place on each adapter.
- **Load and resume timings (14).** For a two-message history, `load` costs 1 457 ms on claude and 393 ms on codex; `resume` 1 506 ms and 121 ms. codex's load additionally replays `available_commands_update` and two `session_info_update`s. Longer histories were not measured.
- **Process trees, memory, concurrency (12, 15, 19).** Mid-turn, claude is `node` plus the SDK's `claude` binary; codex is `node` + `node` + the `codex` binary + a `node_repl` spawned from `/Applications/ChatGPT.app` (its `node_repl` tool), all covered by the group kill. RSS per adapter group mid-turn: 610–645 MB claude, 275–345 MB codex. Two adapters of the same kind on one worktree produce independent streams with zero cross-session updates; note that a claude planner in `plan` mode writes its plan file to `~/.claude/plans/…`, outside the target worktree.
- **System prompt and embedded context (03, 16).** claude honors `_meta.systemPrompt.append` on `session/new`; codex ignores `_meta.systemPrompt` entirely, and a `<system>` section prepended to the first user prompt holds across the first and second turns — behavioral, not protocol support. A `resource` block carrying `assignment.md` (5 410 chars) is used without any tool call on both, at a standing cost of ~1.6–1.7 k tokens per turn.
- **Sub-agents (17, claude only).** The `Task` tool surfaces as a `kind: think` tool call titled `Task`, and the sub-agent's own tool calls arrive as sibling top-level `tool_call`s on the same session — 11 calls in total, none nested. Nesting is Syntaur's to reconstruct if it wants it; the stream does not provide it.

**Corrections to this document**

- §5.9a step 5 assumed `pending → in_progress → completed`. claude-agent-acp emits `pending → completed`, codex-acp `in_progress → completed`; the renderer keys on the terminal status, not the sequence.
- §5.9a step 5 assumed every tool call carries `content`. codex-acp's parsed `search` calls carry none — fall back to `rawOutput`.
- §5.9a step 10 assumed a `config_option_update` on a model switch. Neither adapter sends one; trust the `set_config_option` response.
- §5.9a step 12's "cancel at 5 s" assumed a chunk within 5 s. At the inherited `xhigh` effort claude's first chunk arrives at 25.4 s. Cancel itself works during the silent window (11 ms), but a measure that wants a *streaming* turn must wait for the first chunk or pin the effort.
- §5.9a step 13's "queue vs steer" is not a single choice, and neither adapter is safe on its own terms — row 13 fails on both. claude queues but its steering leaves the prompt unresolved; codex steers but merges a second prompt into the running turn and orphans the first request. Syntaur serializes prompts client-side on both and relies on steering on neither.
- §5.9a step 7 assumed permission requests exist in every non-bypass mode. codex `agent` mode never asks the client (Guardian handles escalations), and a sandbox-denied command is invisible in the stream.
- §2.6 and §5.4 list `dontAsk` from the adapter's mode set: it is advertised by the installed 0.70.0 artifact and absent from the adapter's unreleased main, and the installed dist also advertises `auto`.
- `authentication/status` is a private codex-acp extension, not an ACP method — claude-agent-acp rejects it with "Method not found", so an auth probe cannot be written against it generically.
- §3's inventory of what `claude-agent-acp` 0.70.0 emits (a grep of its source) lists `agent_thought_chunk` and `config_option_update`. It can emit both, but neither appeared in any spike scenario; do not design a thinking indicator or a model-switch confirmation around them.
- §5.10's "one prompt in flight per session or the adapters misbehave" is confirmed, with specifics: claude queues the second prompt natively but hangs the prompt that is steered, codex merges the second prompt into the running turn and never answers the first request.
- §5 costs a chat turn as the conversation. The dominant cost is the session's inherited environment — ~37 k tokens on claude, ~23 k on codex, before the first word, re-sent every turn — so phase 2 must pin `settingSources` (claude) and the config/plugin set (codex) per session and decide explicitly which MCP servers a chat session gets, rather than inheriting the developer's.
- §5.10's sub-agents bullet ("render it as a nested work card") is wrong about the shape. The `Task` call is not nested: it is a `kind: think` card followed by the sub-agent's tool calls as top-level siblings.

**Open follow-ups**

- Why codex-acp emits no `tool_call` for a sandbox-denied `exec` (the codex rollout records the same `custom_tool_call` "exec" shape either way).
- Whether Syntaur wants client-side `terminal` support to render live command output (codex-acp's `execute` calls reference a `terminalId`).
- Re-measuring row 19's CPU percentages with one suite at a time, if the numbers ever matter.
- `claude-agent-acp` inherits `settingSources` (user hooks, MCP servers, allow rules) and `codex-acp` inherits `~/.codex/config.toml` (plugins, MCP servers, model, effort); Syntaur must pin both per session in phase 2.

### 5.10 Gotchas Buzz already paid for

- **Silent turns**: keep the "if you did work, say so in chat" rule in the base prompt anyway — with direct rendering the failure mode becomes "ends with a tool card and no summary", which is annoying rather than invisible.
- **System-prompt cost**: Buzz's base prompt is ~150 lines and reviewers blamed it for a 31k-token "hello" (unverified). Keep Syntaur's standing context lean and send it once per session.
- **Adapter churn**: pin adapter versions in the catalog; ACP v2 is a draft with breaking `session/update` changes (`tool_call` removed in favour of upsert `tool_call_update`, `plan_update` with ids, `state_update` replacing the prompt-response-ends-turn rule, structured diffs, permission `title/subject`). Model the internal `ChatEvent` on v2 semantics now.
- **Auth**: `claude-agent-acp` reuses the Claude Code login (Max plan) or `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`; `codex-acp` needs a ChatGPT login or `CODEX_API_KEY`; Buzz probes `claude auth status` / `codex login status` before spawning and shows a login hint — do the same. *(spike 2026-09-01: both subscription logins work with every API-key variable scrubbed, but both adapters also inherit the user's local configuration — claude-agent-acp `~/.claude/settings.json` via `settingSources`, codex-acp `~/.codex/config.toml` — including the effort setting, which started at `xhigh` on this machine; Syntaur must pin mode, model, effort and setting sources per session. §5.9b.)*
- **Sub-agents**: Claude's Task/Agent tool arrives as ordinary tool calls unless the client negotiates the draft subagent capability; render it as a nested work card and revisit when the RFD stabilizes. *(spike 2026-09-01: nothing is nested — `Task` arrives as a `kind: think` tool call titled `Task` and the sub-agent's own tool calls arrive as top-level siblings on the same session, so a nested card has to be reconstructed by Syntaur or dropped. §5.9b.)*
- **Process hygiene**: adapters log to stderr (capture it into the `system` rail, don't let it leak); kill process groups; bound stdout line size (`buzz-agent` caps inbound frames at 4 MiB and tool-result text at 50 KiB); one prompt in flight per session or the adapters misbehave. *(spike 2026-09-01: stdin EOF exits both adapters cleanly with no surviving descendants; SIGKILL of the claude adapter pid alone leaves the `claude` child running, so tear down with `kill(-pgid)`. §5.9b.)*
- **`plan` is replace-the-whole-list**, `tool_call_update` is partial — the normalizer must treat them differently.
- **Compaction** is the underlying agent's business; the adapter surfaces "Compacting…" as text — render as a `system` row and never re-send standing context because of it.

### 5.11 Open questions (decide during the spike)

- Spawn adapters inside the dashboard server (simple, dies with it) or under syntaurd from day one (durable, more plumbing)? Recommendation above: server first, daemon in phase 4. *(spike 2026-09-01: decided — the dashboard server, detached, with `kill(-pgid)` teardown; row 20 shows both adapters exit code 0 on stdin EOF with no surviving descendants, so no supervisor is needed. Decision 8, §5.9b.)*
- Should substantive agent chat messages be mirrored into `progress.md` automatically, or only when the agent calls `syntaur log-progress`? Recommendation: only via the CLI, so records stay intentional.
- Project-scoped chats (a "#project" room) in addition to assignment chats? Not for v1.
- Whether to give agents a Syntaur MCP server (structured tools) in addition to the CLI. The CLI already exists and ACP passes MCP servers trivially, so it's cheap to add later.

## Sources

- block/buzz `571c190` — `crates/buzz-acp/{README.md, src/acp.rs, src/queue.rs, src/pool.rs, src/observer.rs, src/prompt_framing.rs, src/base_prompt.md, src/session_model_*.md}`, `crates/buzz-agent/README.md`, `VISION_AGENT.md`, `desktop/src-tauri/src/managed_agents/{types.rs, discovery.rs}`, `desktop/src/features/agents/{agentWorkingSignal.ts, ui/agentSessionTranscript.ts, ui/agentSessionToolClassifier.ts, ui/agentSessionTranscriptGrouping.ts, ui/activityRenderClasses/}` — https://github.com/block/buzz
- ACP spec `01b9d6e` — `docs/protocol/v1/{overview, prompt-turn, tool-calls, agent-plan, content, session-setup, session-modes, slash-commands}.mdx`, `docs/protocol/v2/migration.mdx`, `docs/announcements/acp-v2-draft.mdx` — https://agentclientprotocol.com
- Registry — https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json (39 agents on 2026-09-01)
- `@agentclientprotocol/sdk` 1.4.0 (`src/examples/client.ts`), `@agentclientprotocol/claude-agent-acp` 0.70.0 (`src/acp-agent.ts`, `src/session-mode.ts`), `@agentclientprotocol/codex-acp` 1.7.0 (README)
- Prior vault research: [[raw/buzz-agent-chat-research-raw]], [[raw/buzz-uniqueness-headtohead-raw]], [[raw/buzz-act2-competitive-raw]], [[raw/buzz-act3-slack-mechanics-raw]]
- Syntaur repo `~/syntaur` `5f0699e` — `src/launch/*`, `src/utils/agents-schema.ts`, `src/sessions/scanner.ts`, `src/daemon/*`, `src/dashboard/{server.ts, agent-sessions.ts, api-launch-preflight.ts, api-write.ts}`, `src/db/engagement-schema.ts`, `src/lifecycle/comment-append.ts`, `dashboard/src/pages/AssignmentDetail.tsx`, `dashboard/src/components/{OpenInAgentButton, CommentsThread}.tsx`

---
## Log
- 2026-09-01 — Page created from Buzz/ACP source research plus a Syntaur codebase survey; verdict and proposed architecture recorded (sources: block/buzz `571c190`, ACP spec `01b9d6e`, claude-agent-acp `7c66108`, codex-acp `d70e380`, ts-sdk `5dac09a`, [[raw/buzz-agent-chat-research-raw]], [[raw/buzz-uniqueness-headtohead-raw]]).
- 2026-09-01 — Added §5.9a spike test steps; Syntaur assignments created in `syntaur-meta`: `acp-adapter-spike` (ready), `assignment-chat-single-agent`, `assignment-chat-multi-agent`, `assignment-chat-durability-retire-legacy` (parked until the spike lands). Repo copy committed at `syntaur/claude-info/plans/assignment-chat-design.md` on branch `feat/acp-adapter-spike`.
- 2026-09-01 — Spike complete: §5.9b added with the matrix, the four decisions (coalescing key = messageId; queue client-side, no steering; load after restart / resume when history is held; spawn from the dashboard server, detached, group kill) and corrections to §3/§5.10/§5.11. Evidence in syntaur `scripts/spike/acp/RESULTS.md` and `src/__tests__/fixtures/acp/` on branch `feat/acp-adapter-spike`.
- 2026-09-02 — §5.9b corrected after the final reruns: row 13 is a FAIL on both adapters (claude never resolves the steered prompt, codex orphans the first of two concurrent prompts), which is now the stated basis for Decision 6; Decision 5 gained a session-scoped rule and a contiguous-run fallback because ACP makes `messageId` optional; Decision 7 restated as resume-by-default with load as the recovery path; claude's silent window at inherited `xhigh` measured at 25.4 s (not "> 45 s"); new row 07n retains the sandbox-denied negative control; new finding that a session's inherited environment (~37 k tokens on claude, ~23 k on codex, plus forked MCP servers) dominates the cost of a turn.
