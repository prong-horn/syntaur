# Assignment chat

Every assignment detail page has a **Chat** tab. Sending a message there spawns a
real coding agent in the assignment's worktree and renders its work as a
conversation — streaming replies, tool cards with diffs and command output, a
plan checklist, and inline permission prompts.

An assignment can have several agents in one chat: `@mention` the one you want,
or let the default answer, and agents can hand the conversation to each other.
See [Several agents in one chat](#several-agents-in-one-chat).

This is how an assignment is worked. Nothing opens a terminal, nothing scans a
transcript afterwards: the dashboard server *is* the agent's client, speaking the
[Agent Client Protocol](https://agentclientprotocol.com) over stdio to an adapter
it owns. The terminal-launch stack it replaced — the `syntaur://` deep link,
launch prompts, `AgentConfig` profiles, the transcript scanner and the `syntaurd`
daemon — was deleted in v0.80.

## How a turn works

1. You send a message. It may include up to four images pasted, dropped or picked in the composer; they are uploaded first, then referenced from the message. The addressed agents receive them as image blocks right after your text; other agents see `[image attached: name]` in their history. The message is persisted immediately and shown as **queued**.
2. On the first message the server spawns the adapter (`claude-agent-acp`,
   `codex-acp`, or `cursor-agent acp`) with `cwd` set to the assignment's worktree,
   runs `initialize` and `session/new`, and sends the **standing context** — the agent definition's
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
sit around. The next message re-attaches to the same agent session: claude and
codex use `session/resume` (replay nothing); cursor uses `session/load` (replay
history into the broker's log without duplicating chat items). If reattach fails,
a new session starts and the chat says so.

A dashboard restart takes the adapters with it, and the next session load
repairs whatever was in flight: a turn that was running is sealed and marked as
having failed, messages that were still queued are re-queued and sent in order,
and a permission or question prompt that was waiting is marked expired (it cannot
be answered — the request died with the adapter). The next message reattaches
(resume, load, or new — see above).

5. When the turn edited files or ran commands, Syntaur appends one entry to
   `progress.md` (who worked, how long, edit/run/read counts, up to eight edited
   paths, the opening of the agent's reply, and the turn id). Talk-only turns
   leave `progress.md` unchanged — file those from the message's ⋯ menu instead.

## Agent definitions — `~/.syntaur/agents/<id>.md`

Frontmatter configures the agent; the body is its system prompt.

```markdown
---
id: planner              # must match the filename
name: Planner
color: violet            # violet | emerald | amber | sky | rose | slate
harness: claude          # claude | codex | cursor
model: claude-opus-5     # optional; passed through to the adapter
mode: plan               # optional; see "Modes" below
permissions: ask   # ask | auto — auto answers every permission request without a card
effort: high             # optional (ignored on cursor — pin effort inside the model value)
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

Three builtins — `claude`, `codex`, and `cursor` — exist so a fresh install works with no
files at all. A file with the same `id` replaces the builtin entirely. Invalid
definitions are reported on `GET /api/chat/agents` and skipped; they never take
the rest of the directory down.

### Editing agents in the dashboard

The **Agents** page (`/agents`) is a validated editor over the same file format
above. Creating or saving writes `~/.syntaur/agents/<id>.md`; deleting an
override file restores the builtin with that id. Exactly one agent may be marked
`default: true` — saving a new default clears the flag on other file-backed
definitions, and you cannot unset the current default without making another
agent default first.

Model and effort pickers show the values each adapter last advertised in
`configOptions` on `session/new`, cached per harness in `syntaur.db`
(`chat_harness_options`). Use **Refresh** on the harness row (or the editor's
refresh button) to open a throwaway session in a temp directory and fetch the
latest model and effort choices **and the slash-command list** when nothing is
cached or auth failed.

**Test** opens the same throwaway path with the saved definition, sends a fixed
prompt (`"Reply with the single word OK…"`), and shows the reply or the
adapter's spawn/auth error. It costs one short turn on the harness you chose and
writes nothing to any assignment log.

Edits land on the next session open for that agent. An idle open session is
shut down on save so the next message re-attaches with the new pins; a running
turn finishes on the old definition and the chat shows a stale-definition notice.
A changed system prompt cannot reach a resumed ACP session — the chat says it
takes effect at the next new session.

**Cursor:** effort is not a separate config option — pin it inside the model value
(e.g. `composer-2.5[fast=true]`, `claude-fable-5-1[thinking=true,context=300k,effort=high]`).
Cursor has no `session/resume`; the broker re-attaches with `session/load` instead.
Team-level MCP servers from the Cursor dashboard are unavailable in ACP mode.
Cursor does not emit `usage_update`; the chat shows one system row saying turns
are not costed rather than a silent $0.

### Modes

`mode` takes one of three harness-independent role names, or a raw adapter mode
id passed straight through:

| Role     | claude              | codex                                            | cursor        |
|----------|---------------------|--------------------------------------------------|---------------|
| `edits`  | `acceptEdits`       | `agent`                                          | `agent`       |
| `ask`    | `default`           | `read-only` — the only codex mode that asks you  | `ask`         |
| `plan`   | `plan`              | `read-only`                                      | `plan`        |
| `bypass` | `bypassPermissions` | `agent-full-access`                              | `agent`       |

`bypass` is the most permissive role on claude and codex. cursor has no bypass
mode of its own — its `agent` is already its most permissive — so `bypass` and
`edits` are the same thing there. The real bypass on cursor is `permissions:
auto` on the agent definition (see below): Syntaur answers every permission
request without a card.

**`bypass` and `permissions: auto` are honoured even at the home tier.** The
read-only default described under "The agent is running from home" only applies
when a definition pins no mode at all; an explicit `bypass` or `permissions:
auto` is taken at its word, which means an agent with no worktree auto-approves
everything in your home directory. Pin it on agents you keep in a worktree.

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
| Message bubble | Your message (right) or an agent's markdown reply (left), each with its author's avatar and colour. Hover a sent message or a sealed reply for the ⋯ menu — **File as decision / progress entry / comment** opens a prefilled dialog you can edit before filing. User messages with images show thumbnails that open the full file in a new tab. |
| Hand-off row | "@planner → @implementer · hop 1 of 4", linking the message that caused it |
| Work card | A run of tool calls, one line: "Worked 18s · read 1 · edited 1" |
| Plan checklist | The agent's todo list; pinned above the composer while its turn runs |
| Permission card | The agent wants to do something that needs approval — answer inline, or click **Allow all this session** to stop the cards until that agent's session closes (after ten minutes idle, when the adapter exits, or when its harness changes); `permissions: auto` on the agent definition is the durable setting |
| Question card | Cursor asked a multiple-choice question — pick an option inline |
| Thin status row | "Planner · 3m 02s · 41.2k tokens · $0.19 · end_turn", with an **Activity** disclosure holding that turn's thinking and full tool detail |
| Thin grey row | Session lifecycle, mode/config changes, adapter notices, **Filed …** (a message filed as a decision, progress entry or comment), **Auto-approved: `<command>`** (the agent's `permissions: auto`, or **Allow all this session**) |

A permission or Cursor question card left unanswered for about 30 seconds files a `question` in the assignment's comments and a row in your **Needs me** inbox; the row clears when you answer the card (or it times out or is cancelled). The five-minute permission timeout still applies and files its own denial question if nobody answered in time.

### When an agent is waiting on you

Three moments surface in **Needs me**:

1. **Reply questions.** After a human-triggered turn ends normally, if the agent's last paragraph ends with `?` or asks for a decision (for example "Say if you want a commit or a review"), Syntaur files a `question` comment with a hidden marker linking to the reply in the Chat tab. When the last paragraph is a short plain statement, the paragraph before it is also checked (so a question followed by "I have not created anything yet…" still files). Hand-off replies and replies that `@mention` another attached agent do not file. Sending any message to that agent resolves the row.
2. **Permission cards.** A card still pending after ~30 seconds files `Waiting for your permission to run **…**` with a marker on the permission item. Answering the card (including **Allow all this session** or `permissions: auto`) resolves it; if a card times out, its grace row is resolved first, so only the denial question remains.
3. **Cursor questions.** A parked `ask_question` card uses the same grace; the row shows the prompt and links to the card.

The Comments tab shows the question text only (the marker is hidden). Inbox rows for chat items say `@agent asked`, `@agent is waiting for permission`, or `@agent is asking`, link straight to the item in the Chat tab, and offer **Open chat** instead of an inline reply box. You can still **Resolve** by hand on the Inbox or Comments tab; setting a question to its current resolved state returns success without error.

A short sentence right before a tool call ("I'll read package.json first.")
becomes the work card's header instead of its own bubble — that one rule is most
of what makes the stream read like chat rather than a log.

**Unanswered permissions time out after 5 minutes.** The request is denied, the
turn moves on, and a question is filed in the assignment's comments so it shows
up in your Inbox. Auto-approved requests never wait.

## Where the data lives

- `<assignment>/chat/events.jsonl` — the append-only source of truth: every ACP
  frame and every Syntaur-side event, in order. Routing rows (the human's
  messages, hand-offs, routing notices) are written under one per-assignment
  scope key rather than under any agent's, because they belong to the room.
- `<assignment>/chat/participants.json` — who is attached, which one is the
  default, and the hop budget.
- `<assignment>/chat/attachments/<uuid>__<name>.<ext>` — image files uploaded
  from the composer, referenced from `user.message` events by id (bytes are never
  embedded in `events.jsonl`).
- `<assignment>/progress.md` — chat-written entries end with `Chat turn \`<id>\``.
  Filed decisions and progress entries end with `_Filed from chat (…)._`. Standalone
  assignments file to `~/.syntaur/assignments/<uuid>/` rather than under a project.
- `chat_harness_options` in `~/.syntaur/syntaur.db` — per-harness cached
  `configOptions` and auth state from the last successful adapter open (or a
  harness refresh).
- `chat_items` / `chat_sessions` in `~/.syntaur/syntaur.db` — a **rebuildable
  index** for paging. `chat_sessions.standing_fingerprint` records the sha256 of
  the roster lines and system prompt last sent as standing context, so a restart
  can tell when that block needs to be re-sent. `POST /api/assignments/:id/chat/reindex`
  replays the log and reproduces it exactly.

A chat session also registers as a normal agent session, keyed by its ACP session
id — which *is* the underlying Claude Code transcript id or codex rollout id — so
it appears in the Agent Sessions rail and each turn opens and closes an
`engagement` row. That is what puts per-turn cost on the assignment's usage rail.
The row is stamped `hosted_by = 'acp'`, which is also what exempts it from the
stale sweep: the broker writes its `active` / `stopped` itself.

claude reports its own cumulative cost, so a claude turn is priced by the
adapter. codex reports token buckets only, so Syntaur prices those from the
OpenAI list rates in `MODEL_PRICING` (`gpt-5.6-sol`, `gpt-5.6-terra`, … ). If a
codex session ever reports a model with no entry there, the chat says so once
and its turns book at $0 with the token counts still recorded.

## Troubleshooting

**An Inbox question appeared for a reply that was not really a question** — Syntaur
looks at the last paragraph of a human-triggered reply, and when that paragraph
is a short plain statement, the one before it. Polite closers like
"let me know if you need anything else" are filtered out, but the rule is heuristic.
Send any message to that agent to clear the row, or resolve it by hand.

**No Inbox question for an obvious one** — the question may not have been in the
last paragraph (or the short statement before it), or the reply handed off to
another agent (`@mention`), or the turn was triggered by a hand-off rather than
your message.

**"claude-agent-acp is not on PATH"** — install the adapter:
`npm i -g @agentclientprotocol/claude-agent-acp` (or `…/codex-acp`). The composer
shows the exact command.

**"cursor-agent is not on PATH"** — install the Cursor CLI:
`curl https://cursor.com/install -fsS | bash` (see [cursor.com/docs/cli/installation](https://cursor.com/docs/cli/installation)).
Then run `cursor-agent login` (or `agent login`) before chatting.

**The agent is running from home** — the assignment has no `workspace.worktreePath`,
`workspace.repository`, or project `repositories` entry that exists on disk, so
the agent falls back to the home directory (`~`). A system row in the chat says
so and suggests creating a worktree from the assignment header. At the home tier
the session defaults to `ask` mode (read-only) unless the agent definition pins
a different mode. The four-tier resolution chain is: worktree → repository →
project repository → home.

**The adapter fails to start** — the chat shows the adapter's own error plus the
output of `claude auth status` / `codex login status` / `cursor-agent status`.
All three work off a subscription login; no API key is required.

**The image was refused** — only PNG, JPEG, GIF and WebP are accepted, each file
must be 10 MB or smaller, and a message may carry at most four images. A
`/command` cannot carry attachments — send the image in a plain message first.

**Live image check (2026-09-06, scratch home)** — with `claude-agent-acp@0.75.1`,
`codex-acp@1.10.0` and `cursor-agent 2026.09.02`, a valid solid-red 64×64 PNG sent with
"What colour is this image? Answer with one word." got `Red.` from all three in one
turn each, with no tool calls (claude turn `de334638`, codex `16319b33`, cursor
`ad5c699b`). Two earlier failures were not delivery failures: the first test PNG was
malformed (an RGBA header over RGB-sized rows), so cursor's image viewer and the
Anthropic API both rejected it and the models fell back to reading the bytes; and
`claude-agent-acp@0.70.0` (bundled Claude Agent SDK 0.3.232) and `codex-acp@1.7.0`
refused the current default models before inference. If a chat turn fails with
"Claude Code 2.1.x does not support this model" or "requires a newer version of
Codex", upgrade the adapter, not the CLI:
`npm i -g @agentclientprotocol/claude-agent-acp@latest @agentclientprotocol/codex-acp@latest`.

**No progress entry appeared for a turn** — Syntaur writes one only when the turn
ended `end_turn` and edited at least one file or ran at least one command; read-only
and talk-only turns leave `progress.md` unchanged. Cancelled and failed turns append
nothing either. To keep a conclusion, use the message's ⋯ menu (**File as decision /
progress entry / comment**).

**Could not write the progress entry** — the chat shows a warn row with this text
when `progress.md` could not be written (permissions, a hand-made file without YAML
frontmatter, etc.). The turn itself still completed; only the automatic progress entry
was skipped.

**The slash-command picker is empty** — the harness has not sent
`available_commands_update` yet for that agent, nothing is cached for the harness,
and the session row has no saved list. Open **Agents** and press **Refresh** on
that harness (the throwaway session captures the command list), or send any
message to open a session (a session whose list was never saved gets it back from
its own events log on the next open). A fully typed `/command` still sends on
Enter even when the picker is empty; check that the adapter on PATH is current
(`claude-agent-acp` / `codex-acp` / `cursor-agent`).

**The model picker is empty** — the adapter is not installed, nothing has been
cached yet, or the last refresh failed (check the auth detail on the harness row
and use **Refresh**).

**The agent keeps asking for permission** — cursor's "Allow always" adds one
`Shell(<binary>)` or `Write(<path>)` rule to `~/.cursor/cli-config.json`, so each
new binary or file asks again. Use **Allow all this session** to stop the cards
until that agent's session closes (after ten minutes idle, when the adapter exits,
or when its harness changes), or set `permissions: auto` on the agent definition
for a durable bypass. `--yolo` does nothing under ACP.

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
lives. Delete a definition and every affected chat gets a `system` row, the
participants file is rewritten to drop the id (or, for a builtin override, the
builtin is restored); nothing else breaks.

**Detaching stops the agent.** Its turn is cancelled, everything queued for it
is dropped with a `system` row per message saying so, and its adapter is torn
down. Nothing keeps running off-screen: a detached agent has no chip and no
interrupt button, so a turn left to "finish quietly" would be spend you cannot
see or stop. A crash restart will not bring it back either — recovery re-queues
only for agents that are still attached.

**At most eight agents** can be attached at once, and that is a ceiling rather
than a target. Every agent given a turn re-sends its whole standing context
first — about 37 k tokens on claude and 23 k on codex before the first word — so
a message fanned out to four agents costs four full turns. Two or three is the
useful shape.

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

A mention is a mention wherever it appears in a reply, so an agent that writes
"ask @implementer about it" in passing really does hand off. Ids inside backticks
or a fenced code block are **not** mentions — quoting `@planner` is talking about
the planner rather than to them — but ordinary prose is taken at face value, and
the budget and the bare-acknowledgement filter are what bound the result.

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

## Slash commands

Each harness advertises its skills and slash commands on `session/new` through
ACP's `available_commands_update`. The broker captures that list per session,
persists it, and serves it on the `chat-session` frame and
`GET /api/assignments/:id/chat/session`. Before an agent's first session opens,
the composer shows the newest list its harness has advertised elsewhere — from
another session's row or from the per-harness record filled by **Refresh** on the
Agents page (the throwaway session captures the commands) — marked **cached**. A
session whose list was never saved gets it back from its own events log on the
next open.

| Harness | Typical count (2026-09-03) | Notes |
|---------|---------------------------|-------|
| claude (`claude-agent-acp`) | ~221 | Includes plugin and skill commands; `/context` returns the usage table |
| codex (`codex-acp`) | ~140 | Skills and plugin commands appear as `$name` entries; `/plan` sets collaboration mode client-side |
| cursor | ~117 | Same ACP surface; no extra Syntaur work beyond capture and the picker |

Type `/` at the start of the message, or right after a leading `@mention`, to
open a picker scoped to the **addressed agent** — the first attached mention, else
the default. Selecting a command inserts `/name `; when the typed name exactly
matches a listed command and the caret is at its end, Enter sends instead of
re-inserting the name (Tab still completes). An unlisted `/command` is allowed and
still sends as-is.

A command turn is delivered as a **raw** `/name args` line — no `<chat-event>`
wrapper and no `<chat-history>` delta — so the harness recognises it the same way
as in a terminal. The delivery cursor does not move on that turn; the next
ordinary message carries whatever history the command skipped. On a brand-new
session whose standing context has not been sent yet, the broker delivers standing
context in a short internal turn first, then sends the command alone (Task 2a).

codex marks some commands with `_meta.commandAction.kind = setConfigOption` (for
example `/plan` → `collaboration_mode = plan`). Those run client-side: Syntaur
calls `session/set_config_option`, writes a thin `system` row, and closes the
turn without a prompt. `prefixPrompt` commands (for example `/goal`) are sent as
text like claude commands.

## Scheduled messages

A schedule can post into a chat unattended. `syntaur schedule create --assignment
<id> --message "<text>" [--agent <id>] --cron '0 3 * * *'` sends that message on
every fire — in-process when the dashboard's own tick runs it, otherwise over the
chat REST route on the running dashboard. The attempt is tracked by the returned
`messageId` alone: it is "running" while the message is queued or a turn it
triggered is open, and `syntaur schedule kill` withdraws the queued message or
cancels the running turn.

A schedule whose assignment has no attached agent — or whose dashboard is not
running — records an error on the schedule. There is no terminal fallback.

## Not in this phase

Per-agent mode and model pickers and ACP v2 (both adapters
speak v1 only; the SDK's `experimental/v2` is not negotiated until one of them
ships it).
