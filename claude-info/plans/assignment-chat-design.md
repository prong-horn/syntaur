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
- `session/update` variants: `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk` (all with optional `messageId`), `tool_call { toolCallId, title, kind: read|edit|delete|move|search|execute|think|fetch|other, status: pending|in_progress|completed|failed, content[ {type: content|diff{path,oldText,newText}|terminal{terminalId}} ], locations[{path,line}], rawInput, rawOutput }`, `tool_call_update` (partial), `plan { entries[{content, priority, status}] }` (whole-list replace), `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update`, `usage_update { used, size, cost? }`.
- Prompt turn ends with `stopReason: end_turn | max_tokens | max_turn_requests | refusal | cancelled`.
- Content blocks are MCP's (`text`, `image`, `audio`, `resource` (embedded file — the way to attach `assignment.md`/`plan.md` to a prompt), `resource_link`).
- Extensibility: `_meta` everywhere, `_`-prefixed custom methods.

**What `claude-agent-acp` 0.70.0 actually emits** (grep of `src/*.ts`): `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan` (from TodoWrite), `available_commands_update` (slash commands incl. custom `.claude/commands`), `current_mode_update`, `config_option_update` (model, effort, mode), `session_info_update` (titles), `usage_update`, plus draft `subagent_*` / `async_task_*`. It supports images, embedded context, client MCP servers (http/sse/stdio), edit review, interactive terminals, nested subagent transcripts, and auths via the existing Claude Code login (`terminalAuthMethods` / `claude auth status`) or `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`. Dependencies: `@agentclientprotocol/sdk` 1.3.0, `@anthropic-ai/claude-agent-sdk` 0.3.238. **`codex-acp` 1.7.0** maps shell commands, file changes, permission requests, MCP calls, terminal output, reasoning, plan, web search, token usage and review events; auth via ChatGPT login or `CODEX_API_KEY`/`OPENAI_API_KEY`; modes `read-only|agent|agent-full-access`; slash commands `/review`, `/compact`, `/status`…

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
- Human message while a turn is running: claude-agent-acp advertises `_meta.steering` and `promptQueueing`; default to **queue** and offer "interrupt & steer" as an explicit action.

### 5.6 Several agents in one chat

Routing lives in Syntaur, not in prompts. A message is a turn trigger for the agents it `@mentions` (default agent if none). When an agent's own message mentions another defined agent, the router enqueues a turn for that agent with the message as the trigger and writes a `handoff` row. Guards, in code: one turn in flight per agent per assignment (queue the rest and batch them into a single prompt, like Buzz); a hop budget for agent→agent chains without a human message in between (e.g. 4); a bare-acknowledgement filter (a triggered reply with no tool activity and no new mention ends the chain). The prompt-level rules Buzz relies on ("never publish a bare acknowledgement", "@mention the delegator when done") stay in the base prompt as belt and braces. Plan → implement → review is then just: `@planner plan this` · `@implementer go` · `@reviewer review the branch`, or a later "workflow" that issues those messages automatically when a stage completes.

### 5.7 UI

A **Chat** tab on `AssignmentDetail` (arguably the new default tab), with: agent presence chips with a per-agent working indicator (Buzz's `agentWorkingSignal` idea); a composer with `@agent` autocomplete (reuse the `launch-prompt-autocomplete.ts` pattern) and `/command` autocomplete populated from `available_commands_update`; per-agent mode/model pickers driven by `config_option_update`; cancel; cost so far from `usage_update`. Transport: add a `chat-event` `WsMessage` scoped by assignment to the existing `/ws` broadcast, REST for history paging and sending. Rendering: `react-markdown` is already there; diff and terminal blocks are new components (Buzz's `FileEditDiffView` / `FileContentBlock` are the reference).

### 5.8 What this retires (no backward compatibility required)

`syntaur://` URL scheme + AppleScript applet + `src/launch/*` terminal plans; `AgentConfig` terminal profiles and the Agents page's launch semantics; the transcript scanner, idle sweep, Agent View, and `lsof` liveness for Syntaur-launched sessions (they could stay only as a legacy import for sessions started outside Syntaur, or go entirely); the PTY-through-daemon session terminal for these sessions (the daemon could be kept as the process host in a later phase so sessions survive dashboard restarts, spawning adapters under it and bridging stdio over its unix sockets — but phase 1 should spawn in the server process). Keep: the assignment file protocol, lifecycle engine, worktrees, the `syntaur` CLI, the `engagement` table, usage/cost rollups, comments.md as the human record (chat is the timeline; records remain the durable state, written by agents through the CLI as the protocol already says).

### 5.9 Phases

1. **Spike (1–2 days).** A ~200-line script: `@agentclientprotocol/sdk` client → `claude-agent-acp` in an assignment worktree; system prompt via `_meta.systemPrompt`; print normalized events; exercise permission requests in `default` mode, `plan` from TodoWrite, `usage_update`, `session/load`, cancel, and a `codex-acp` run for parity. This settles every remaining unknown about the adapters.
2. **Single-agent chat (≈1 week).** Agent definitions + catalog; session broker in the server; `ChatEvent` log + SQLite index; normalizer with the coalescing/grouping rules; WS + REST; Chat tab with message/work/plan/permission/status items; engagement rows per turn.
3. **Multi-agent + polish.** `@mention` routing and hop guards; codex/opencode harnesses; slash commands; mode/model pickers; steer vs queue; Inbox integration for unanswered permissions/questions; cost per agent.
4. **Durability + cleanup.** Daemon-hosted adapters, `session/load|resume` on restart, delete the terminal-launch and transcript-scan code paths, v2 negotiation behind a flag when the adapters ship it.

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

### 5.10 Gotchas Buzz already paid for

- **Silent turns**: keep the "if you did work, say so in chat" rule in the base prompt anyway — with direct rendering the failure mode becomes "ends with a tool card and no summary", which is annoying rather than invisible.
- **System-prompt cost**: Buzz's base prompt is ~150 lines and reviewers blamed it for a 31k-token "hello" (unverified). Keep Syntaur's standing context lean and send it once per session.
- **Adapter churn**: pin adapter versions in the catalog; ACP v2 is a draft with breaking `session/update` changes (`tool_call` removed in favour of upsert `tool_call_update`, `plan_update` with ids, `state_update` replacing the prompt-response-ends-turn rule, structured diffs, permission `title/subject`). Model the internal `ChatEvent` on v2 semantics now.
- **Auth**: `claude-agent-acp` reuses the Claude Code login (Max plan) or `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`; `codex-acp` needs a ChatGPT login or `CODEX_API_KEY`; Buzz probes `claude auth status` / `codex login status` before spawning and shows a login hint — do the same.
- **Sub-agents**: Claude's Task/Agent tool arrives as ordinary tool calls unless the client negotiates the draft subagent capability; render it as a nested work card and revisit when the RFD stabilizes.
- **Process hygiene**: adapters log to stderr (capture it into the `system` rail, don't let it leak); kill process groups; bound stdout line size (`buzz-agent` caps inbound frames at 4 MiB and tool-result text at 50 KiB); one prompt in flight per session or the adapters misbehave.
- **`plan` is replace-the-whole-list**, `tool_call_update` is partial — the normalizer must treat them differently.
- **Compaction** is the underlying agent's business; the adapter surfaces "Compacting…" as text — render as a `system` row and never re-send standing context because of it.

### 5.11 Open questions (decide during the spike)

- Spawn adapters inside the dashboard server (simple, dies with it) or under syntaurd from day one (durable, more plumbing)? Recommendation above: server first, daemon in phase 4.
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
