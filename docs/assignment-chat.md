# Assignment chat

Every assignment detail page has a **Chat** tab. Sending a message there spawns a
real coding agent in the assignment's worktree and renders its work as a
conversation — streaming replies, tool cards with diffs and command output, a
plan checklist, and inline permission prompts.

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
respondsTo: all-human    # mentions | all-human | none
default: false           # exactly one definition is the default
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
| Message bubble | Your message (right) or the agent's markdown reply (left) |
| Collapsed "thinking" row | The agent's reasoning, one row per run — click to expand |
| Work card | A run of tool calls: "Worked 18s · read 1 · edited 1". Expand for per-tool rows with diffs, command output and raw input/output |
| Plan checklist | The agent's todo list; pinned above the composer while its turn runs |
| Permission card | The agent wants to do something that needs approval — answer inline |
| Thin status row | "Claude · 3m 02s · 41.2k tokens · $0.19 · end_turn" |
| Thin grey row | Session lifecycle, mode/config changes, adapter notices |

A short sentence right before a tool call ("I'll read package.json first.")
becomes the work card's header instead of its own bubble — that one rule is most
of what makes the stream read like chat rather than a log.

**Unanswered permissions time out after 5 minutes.** The request is denied, the
turn moves on, and a question is filed in the assignment's comments so it shows
up in your Inbox.

## Where the data lives

- `<assignment>/chat/events.jsonl` — the append-only source of truth: every ACP
  frame and every Syntaur-side event, in order.
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

## Not in this phase

Multiple agents in one chat, `@mentions`, agent-to-agent handoffs, mode and model
pickers, and slash commands.
