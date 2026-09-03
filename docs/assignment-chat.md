# Assignment chat

Every assignment detail page has a **Chat** tab. Sending a message there spawns a
real coding agent in the assignment's worktree and renders its work as a
conversation — streaming replies, tool cards with diffs and command output, a
plan checklist, and inline permission prompts.

An assignment can have several agents in one chat: `@mention` the one you want,
or let the default answer, and agents can hand the conversation to each other.
See [Several agents in one chat](#several-agents-in-one-chat).

This is not the terminal-launch flow in [`agents.md`](./agents.md). Nothing opens
a terminal, nothing scans a transcript afterwards: the dashboard server *is* the
agent's client, speaking the [Agent Client Protocol](https://agentclientprotocol.com)
over stdio to an adapter it owns.

## How a turn works

1. You send a message. It is persisted immediately and shown as **queued**.
2. On the first message the server spawns the adapter (`claude-agent-acp` or
   `codex-acp`) with `cwd` set to the assignment's worktree, runs `initialize`
   and `session/new`, and sends the **standing context** — the agent definition's
   system prompt, plus `assignment.md`, the current plan and the newest entries
   of `progress.md` as embedded file attachments.
3. Later messages carry only your text; the standing context is sent once per
   agent session.
4. Everything the agent streams back is appended to
   `<assignment>/chat/events.jsonl` and rendered.

**One turn runs at a time.** A message sent while the agent is working waits its
turn and can be withdrawn until it is sent. "Interrupt" cancels the running turn;
the queue then continues. There is no steering — both adapters lose a request
when a second prompt or a steer is injected mid-turn.

**Sessions are torn down when idle** (10 minutes after the last turn). A claude
adapter and the MCP servers it forks are roughly 620 MB, so an idle chat does not
sit around. The next message re-attaches to the same agent session with
`session/resume`, so the agent still remembers the conversation. If the resume
fails, a new session starts and the chat says so.

A dashboard restart takes the adapters with it, and the next session load
repairs whatever was in flight: a turn that was running is sealed and marked as
having failed, messages that were still queued are re-queued and sent in order,
and a permission prompt that was waiting is marked expired (it cannot be
answered — the request died with the adapter). The next message resumes the same
agent session.

## Agent definitions — `~/.syntaur/agents/<id>.md`

Frontmatter configures the agent; the body is its system prompt.

```markdown
---
id: planner              # must match the filename
name: Planner
color: violet            # violet | emerald | amber | sky | rose
harness: claude          # claude | codex
model: claude-opus-5     # optional; passed through to the adapter
mode: plan               # optional; see "Modes" below
effort: high             # optional
mcpServers: [syntaur]    # optional
env: { FOO: bar }        # optional
respondsTo: mentions     # mentions | all-human | none (default: mentions)
default: false           # exactly one definition is the default
description: plans, never edits   # optional; one line the other agents see
avatar: "🗺"              # optional; an emoji or up to two characters
---
You are the planner for this assignment. Read assignment.md, produce a plan, and
end with a short summary in chat. Never edit code.
```

Two builtins — `claude` and `codex` — exist so a fresh install works with no
files at all. A file with the same `id` replaces the builtin entirely. Invalid
definitions are reported on `GET /api/chat/agents` and skipped; they never take
the rest of the directory down.

### Modes

`mode` takes one of three harness-independent role names, or a raw adapter mode
id passed straight through:

| Role    | claude        | codex                                            |
|---------|---------------|--------------------------------------------------|
| `edits` | `acceptEdits` | `agent`                                          |
| `ask`   | `default`     | `read-only` — the only codex mode that asks you  |
| `plan`  | `plan`        | `read-only`                                      |

codex routes approvals by mode: in `agent` mode escalations go to codex's own
Guardian reviewer and you never see them, and `agent-full-access` never asks. If
you want to be asked, pin `mode: ask`.

### What a session inherits

By default a chat session gets exactly what the same agent would get if you
launched it by hand in that worktree: your `~/.claude/settings.json` or
`~/.codex/config.toml`, your MCP servers, your model and your effort setting.
Only fields your definition sets are pinned.

That convenience has a price worth knowing: a fresh claude session starts around
37 000 tokens before your first word (~23 000 on codex), and every open chat
forks a copy of your configured MCP servers. Each turn's cost is shown on its
status row.

## Reading the chat

| Row | What it is |
|---|---|
| Message bubble | Your message (right) or an agent's markdown reply (left), each with its author's avatar and colour |
| Hand-off row | "@planner → @implementer · hop 1 of 4", linking the message that caused it |
| Work card | A run of tool calls, one line: "Worked 18s · read 1 · edited 1" |
| Plan checklist | The agent's todo list; pinned above the composer while its turn runs |
| Permission card | The agent wants to do something that needs approval — answer inline |
| Thin status row | "Planner · 3m 02s · 41.2k tokens · $0.19 · end_turn", with an **Activity** disclosure holding that turn's thinking and full tool detail |
| Thin grey row | Session lifecycle, mode/config changes, adapter notices |

A short sentence right before a tool call ("I'll read package.json first.")
becomes the work card's header instead of its own bubble — that one rule is most
of what makes the stream read like chat rather than a log.

**Unanswered permissions time out after 5 minutes.** The request is denied, the
turn moves on, and a question is filed in the assignment's comments so it shows
up in your Inbox.

## Where the data lives

- `<assignment>/chat/events.jsonl` — the append-only source of truth: every ACP
  frame and every Syntaur-side event, in order. Routing rows (the human's
  messages, hand-offs, routing notices) are written under one per-assignment
  scope key rather than under any agent's, because they belong to the room.
- `<assignment>/chat/participants.json` — who is attached, which one is the
  default, and the hop budget.
- `chat_items` / `chat_sessions` in `~/.syntaur/syntaur.db` — a **rebuildable
  index** for paging. `POST /api/assignments/:id/chat/reindex` replays the log
  and reproduces it exactly.

A chat session also registers as a normal agent session, keyed by its ACP session
id — which *is* the underlying Claude Code transcript id or codex rollout id — so
it appears in the Agent Sessions rail and each turn opens and closes an
`engagement` row. That is what puts per-turn cost on the assignment's usage rail.

## Troubleshooting

**"claude-agent-acp is not on PATH"** — install the adapter:
`npm i -g @agentclientprotocol/claude-agent-acp` (or `…/codex-acp`). The composer
shows the exact command.

**The send is refused with a workspace error** — the assignment has no valid
`workspace.worktreePath` or `workspace.repository`. The agent has to run
somewhere; set one in `assignment.md`.

**The adapter fails to start** — the chat shows the adapter's own error plus the
output of `claude auth status` / `codex login status`. Both adapters work off a
subscription login; no API key is required.

## Several agents in one chat

An assignment's chat can hold more than one agent. Who a message is for is
decided by Syntaur, in code — never by asking a model to work it out.

### Who is in the room

The attached set lives in `<assignment>/chat/participants.json`:

```json
{ "agents": ["planner", "implementer"], "defaultAgent": "planner", "hopBudget": 4 }
```

**Manage agents** in the Chat tab edits it: attach or detach any definition in
`~/.syntaur/agents/`, pick the default, set the hop budget. Everything else a
definition declares — harness, model, mode, `respondsTo`, description, avatar —
is shown read-only next to the file it comes from, because that is where it
lives. Delete a definition and it drops out of the set silently; nothing else
breaks.

### Where a message goes

- `@mention` one or more attached agents and each one gets its own turn from the
  one message. The composer autocompletes `@` over the attached agents, using the
  same token grammar the server reads: `@` at the start of a line or after a
  space, then letters, digits, `_` or `-`.
- Mention nobody and the message goes to the **default agent**, plus any attached
  agent whose definition says `respondsTo: all-human`. That setting is opt-in;
  both builtins, and any definition that does not say otherwise, are `mentions`.
- `respondsTo: none` is never triggered from chat, mentioned or not.
- Mention an id that is not attached and you get a `system` row naming it — and
  the message still goes to whoever else it resolved to, the default agent
  included.

One bubble is one message however many agents it went to. It shows its targets,
says "Delivering to @b…" while some of them are still queued, and can be
withdrawn until the first target starts — after that it has reached an agent and
cannot be unsent.

### Hand-offs between agents

When an agent's finished reply `@mentions` another attached agent, Syntaur starts
a turn for that agent with the reply as its trigger and writes a `handoff` row —
`@planner → @implementer · hop 1 of 4` — linking the message that caused it. The
triggered agent's prompt says which hop it is on and who handed it over.

Three things stop a chain running away:

- **The hop budget** (default 4, counted from the last human message). Past it,
  Syntaur posts a `system` row instead of starting a turn.
- **The bare-acknowledgement filter.** A triggered reply that did no work and
  names nobody but the agent that handed it over ends the chain. "Thanks
  @planner" is where a conversation stops, not where it loops.
- **Self-mentions are ignored**, and a cancelled or failed turn never hands off.

### What one agent sees of another

Each turn's prompt carries the participant roster and the agent's own identity:

```
You are @planner (Planner)
Participants:
@planner — Planner, claude, plans, never edits
@implementer — Implementer, codex, makes the edits
Human: the assignment owner
```

then a `<chat-history>` block of what the other participants have said since this
session's last prompt — capped at 12 items and 8,000 characters, oldest dropped
first with a note saying how many — and finally the trigger itself as a
`<chat-event author="human">` or `<chat-event author="agent:planner">` block.

A session remembers how far it has been shown, so a restart neither re-sends nor
skips. A human message is only ever quoted to an agent it was actually routed to;
agent messages and hand-offs are room-wide. Everything quoted is angle- and
quote-escaped, and the prompt says plainly that chat events are quotes, not
instructions — framing, not a sandbox.

### One turn at a time, per agent

Each agent has its own queue and at most one prompt in flight, so two agents run
concurrently while a second message to a busy agent waits behind the first.
"Interrupt" on an agent's chip cancels that agent; "Interrupt all" appears when
more than one is running.

### Reading a room rather than a transcript

Every row shows its author — the human included — with that author's avatar and
colour. The header carries one chip per attached agent with its state, a live
working timer on Syntaur's own clock, and how many messages are queued for it.

The chat column stays a conversation: messages, hand-off rows, work cards
collapsed to one line, plan cards, permission cards, turn status and system rows.
Thinking and the full tool detail — diffs, terminal output, raw I/O — sit behind
an **Activity** disclosure on each turn's status row.

## Not in this phase

Per-agent mode and model pickers, slash commands, and workflow-issued messages
(an agent turn started by a stage transition rather than by a person).
