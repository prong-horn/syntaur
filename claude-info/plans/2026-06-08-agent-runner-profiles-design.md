# Agent Runner Profiles: model + playbook on open — Design

**Assignment:** `syntaur-meta / agent-runner-profiles-model-playbook-on-open`
**Branch:** `feat/agent-runner-profiles`
**Date:** 2026-06-08

## Problem

Today an agent in **Settings › Agents** is just `{ command, args, promptArgPosition, resume, fork }`.
"Open in agent" always launches the **global default** agent, seeding the prompt
`/grab-assignment <proj> <asg>`. There is no way to (a) pin an LLM model to an
agent, or (b) have the open kick off real work beyond grabbing the assignment.

## Goal

Make each agent entry a full **runner profile**: `command` + `model` + default
`playbook`. When you open an assignment with that profile, a terminal launches
that grabs the assignment **and** runs the playbook end-to-end, on the chosen
model. You can keep several profiles (`Claude — e2e`, `Claude — plan`, `Codex`)
and pick which to launch.

## Decisions (locked in brainstorming)

1. **Execution mode = interactive auto-run.** Open a terminal as today, but seed
   a prompt that grabs the assignment AND runs the chosen playbook. The human
   watches/approves in the live terminal. No headless / `--skip-permissions`
   mode this round.
2. **Profile lives on the agent config.** `model` and `playbook` are per-agent
   fields, editable in Settings › Agents.
3. **Generic `--model` flag.** Inject `--model <value>` for any agent that has a
   model set; omit the flag when blank. No per-agent flag templates.
4. **Agent selection on open.** Add an agent dropdown to the Open-in-agent
   button so a specific profile can be launched (not just the global default).

## Architecture

### 1. Schema — `src/utils/agents-schema.ts`

Add two optional fields to `AgentConfig`:

```ts
export interface AgentConfig {
  // ...existing...
  model?: string;     // e.g. "opus", "gpt-5.5-codex". Injected as `--model <value>`.
                      // Blank/undefined => flag omitted (today's behavior).
  playbook?: string;  // playbook slug. Seeds a /run-playbook step on fresh launch.
                      // Blank/undefined => today's `/grab-assignment` only.
}
```

Both optional → existing user configs and all `BUILTIN_AGENTS` are untouched
(full backward compatibility).

### 2. Launch plumbing — `src/tui/launch.ts`, `src/launch/argv.ts`, `src/launch/plan.ts`

**Model injection.** A small shared helper prepends the model flag to an agent's
base args when set:

```ts
// model flag = agent.model ? ['--model', agent.model] : []
```

- `buildAgentArgv` (fresh launch): fold the model flag into `baseArgs` so it
  appears for `promptArgPosition` first/last/none and is included in the
  `resolveFromShellAliases` quoting.
- `buildSessionArgv` (resume/fork): prepend the same model flag before the
  resume/fork invocation args. The model is part of the profile regardless of
  launch mode.

**Playbook chaining.** Extend `INITIAL_PROMPT` to accept an optional `playbook`
slug:

- **No playbook (unchanged):**
  `/grab-assignment <proj> <asg>`  (or `--id <uuid>` for standalone)
- **With playbook:** an instruction-style seed that chains both skills, e.g.:

  > Grab the Syntaur assignment `<proj>/<asg>` using the /grab-assignment skill,
  > then load and run the `<slug>` playbook using the /run-playbook skill and
  > carry it out end-to-end.

  For standalone assignments the grab clause uses `--id <uuid>` phrasing.

  **Rationale:** a Claude Code message runs only ONE leading slash-command;
  everything after it is swallowed as that command's arguments. To reliably fire
  both `/grab-assignment` and `/run-playbook` from a single seed message, the
  playbook case uses a plain-language instruction (the agent invokes both skills
  itself). The no-playbook path keeps the exact, well-tested `/grab-assignment`
  direct invocation, so nothing regresses when no playbook is configured.

**Plumbing the agent + playbook through `plan.ts`.** `resolveAssignmentPlan`
already calls `buildFreshArgv(agent, INITIAL_PROMPT({...}))`. Change:
- pass `agent.playbook` into `INITIAL_PROMPT`.
- pick the agent from the new optional `agentId` (below), falling back to
  `pickAgent(config)` when absent.

### 3. Pick which agent on open — `src/launch/url.ts`, `src/launch/plan.ts`, dashboard

Today: open flow always uses the global default agent; URL is
`syntaur://open?assignment=<id>`.

Change:
- **URL** gains optional `&agent=<id>`.
- `parseOpenUrl` (`url.ts`) parses `agent` into the `ParsedOpenUrl`.
- `ResolveLaunchPlanInput` gains optional `agentId`. `resolveAssignmentPlan`
  resolves the agent by id from `getAgents(config)`; if the id is unknown, throw
  `LaunchError('agent-not-configured', …)` (same code/shape sessions already
  use). When `agentId` is absent, fall back to `pickAgent(config)` (default) —
  backward compatible with existing deep links.

### 4. UI work

**`dashboard/src/pages/AgentsSection.tsx`** — per agent row add:
- **Model** — text input (free-form; placeholder e.g. `opus`), styled like the
  existing `command`/`args` fields, with the same inline field-error pattern.
- **Playbook** — `<select>` populated from the EXISTING `usePlaybooks()` hook
  (`dashboard/src/hooks/useProjects.ts`; no new hook needed), filtered to
  enabled playbooks, with a leading `— none —` option mapping to empty/undefined.

Persist both through the existing `saveAgentsConfig` → `PUT /api/config/agents`
path (no new endpoints).

**`src/dashboard/api-agents.ts` + `validateAgentList` (`src/utils/config.ts`)** —
accept and validate the new fields on PUT:
- `model`: optional string; trimmed; empty string normalizes to omitted.
- `playbook`: optional string; must satisfy `isValidSlug` from
  `src/utils/slug.ts` (the real validator is `/^[a-z0-9]+(-[a-z0-9]+)*$/` —
  stricter than the agent-id pattern: no underscores, no leading/trailing/
  repeated hyphens) when present; empty normalizes to omitted. We do NOT
  hard-fail if the slug isn't currently an enabled playbook (playbooks can be
  toggled independently); the UI offers a valid dropdown, and a stale slug
  simply yields a seed that asks the agent to load a missing playbook.
- `model`: validate it contains no newline (field-specific error → `field:'model'`).

**`dashboard/src/components/OpenInAgentButton.tsx` + `useRecreateFlow.tsx` +
`dashboard/src/lib/recreate-flow.ts`** — agent-selection dropdown:
- A small dropdown next to "Open in agent" listing configured agents (label),
  defaulting to the configured default agent (initialized via a `useEffect` once
  the async `useAgentsConfig()` resolves).
- Thread the chosen `agentId` through `flow.open(target, mode?, agentId?)` → the
  `syntaur://open?...&agent=<id>` URL builder. **Preflight is agent-independent
  and needs no change** (`POST /api/launch/preflight` only checks terminal +
  worktree).

### 5. Tests

- `src/tui/launch.ts` / argv: `--model` present when `agent.model` set, absent
  when blank; correct ordering for `promptArgPosition` first/last/none; included
  in `resolveFromShellAliases` quoting; resume/fork argv includes `--model`.
- `INITIAL_PROMPT`: no-playbook output unchanged; with-playbook output chains
  grab + run-playbook (project-nested and standalone forms).
- `parseOpenUrl`: parses `agent=`; absent => undefined; mutually-exclusive
  assignment/session rules still hold.
- `resolveAssignmentPlan`: uses `agentId` when provided; falls back to default;
  throws `agent-not-configured` for an unknown id; threads `agent.playbook` into
  the seed.
- `validateAgentList` / api-agents: accepts `model` + `playbook`; rejects a bad
  playbook slug; normalizes empties to omitted.

## Scope boundaries (YAGNI)

- Interactive only — no headless/auto-approve mode.
- Generic `--model` — no per-agent model-flag templates.
- Playbook affects **fresh launch only** (resume/fork continue an existing
  conversation, so no re-seed).
- No new persistence surface — reuse `~/.syntaur/config.md` agents block and the
  existing config API.

## Files touched (anticipated)

| Area | File |
| --- | --- |
| Schema | `src/utils/agents-schema.ts` |
| Validation | `src/utils/config.ts` (`validateAgentList`) |
| Launch argv (model + prompt) | `src/tui/launch.ts`, `src/launch/argv.ts` |
| Launch plan (agent pick + playbook) | `src/launch/plan.ts` |
| URL parse (`agent=`) + plan wiring | `src/launch/url.ts`, `src/commands/url.ts` |
| Agent API validation | `src/dashboard/api-agents.ts` |
| Settings UI | `dashboard/src/pages/AgentsSection.tsx`, `dashboard/src/hooks/useAgentsConfig.ts` |
| Open button + flow | `dashboard/src/components/OpenInAgentButton.tsx`, `dashboard/src/components/useRecreateFlow.tsx`, `dashboard/src/lib/recreate-flow.ts` |
| Playbook list (UI) | existing `usePlaybooks()` in `dashboard/src/hooks/useProjects.ts` (no new hook) |
| CLI + docs parity | `src/commands/agents.ts`, `docs/protocol/file-formats.md` |
| Tests | `src/__tests__/*.test.ts` (extend existing files) |
