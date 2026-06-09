# Editable agent launch prompt (`launchPrompt`) — design

**Date:** 2026-06-09
**Status:** Design approved (brainstorm), pending spec review
**Scope:** v1 = config-level template (Phase A). Dashboard prompt box with `@`-autocomplete = Phase B, out of scope here.

## Problem

When a `syntaur browse` / dashboard "Open in agent" launch targets an agent profile
that has a `playbook` set, syntaur silently **injects a wrapper sentence** as the agent's
first message:

```
Grab the assignment `proj/slug` using the /grab-assignment skill, then load and run
the `<playbook>` playbook using the /run-playbook skill and carry it out end-to-end.
```

That prose is hardcoded in `INITIAL_PROMPT` (`src/tui/launch.ts:63`) and the user can't
see or change it. Two objections:

1. **It's hidden and uneditable.** If we're going to put words in the agent's mouth,
   the user should own them.
2. **It's brittle to a missing skill.** The whole seed assumes `/grab-assignment` (and
   `/run-playbook`) are installed in the launched agent. If they aren't, the agent has
   *no idea* what it's working on — there's no fallback context.

## Goals

- Replace the rigid `playbook: <slug>` field with an **editable, user-owned launch
  prompt** (`launchPrompt`) per agent profile. Nothing reaches the agent that the user
  didn't write (modulo `@`-token expansion they opted into).
- **Per-agent** `launchPrompt`, with a built-in fallback chain (per-agent `launchPrompt`
  → back-compat `playbook` → bare grab). **Decided (Option A):** no configurable
  workspace-wide default and no `@playbook` token — deliberately kept out to stay simple;
  a top-level default can be layered on later without breaking the per-agent model.
- Inject the assignment **id + records directory path** so an agent can locate and read
  the assignment files itself even when `/grab-assignment` is not installed.
- Preserve today's behavior for users who don't touch the new field.

## Non-goals (future)

- **Phase B:** a live, editable prompt box in the dashboard "Open in agent" flow with
  `@`-autocomplete. This design keeps the data model B-friendly (the box pre-fills from,
  and edits, the same `launchPrompt` template + resolver) but builds none of the UI.
- Multi-line `launchPrompt` storage (the serializer is single-line today; see Storage).
- `@skill:…` / `@resource:…` tokens. The `@` grammar is designed to allow them later,
  but v1 resolves only `@assignment` and `@<playbook-slug>`.

## Model

An agent profile gains an optional **`launchPrompt`** string: the literal first message
the agent is launched with. Inside it, `@`-tokens are resolved at launch time:

| Token | Resolves to |
| --- | --- |
| `@assignment` | A natural-language pointer: the assignment **id**, the **records dir path**, an instruction to claim/bind via `/grab-assignment` *if available*, and a fallback instruction to read `assignment.md` / `plan*.md` / `progress.md` in that directory otherwise. |
| `@<playbook-slug>` | `` the `<slug>` playbook via the /run-playbook skill `` (the noun + how to load it; the template author writes the surrounding verbs). |
| `@<unknown>` | **Warn** at launch; leave the literal `@<unknown>` text in the prompt so the agent still sees intent. Launch is **not** aborted. |

Reserved token: `assignment`. Any other `@<slug>` is treated as a playbook slug.
(A playbook literally named `assignment` is a documented collision; the reserved token
wins.)

### `@assignment` expansion (example)

```
This session is Syntaur assignment a1b2c3, with records at
/Users/brennen/.syntaur/projects/syntaur/assignments/agent-launch-prompt/.
Claim and bind it with the /grab-assignment skill if available; otherwise read
assignment.md, plan*.md, and progress.md in that directory for full context.
```

- The path is the **records directory** (`ResolvedAssignment.assignmentDir`), where
  `assignment.md` lives — *not* the code worktree (which is already the launch cwd).
- For a standalone assignment (`projectSlug === null`) the wording drops the project and
  uses the standalone records dir; the id + path still resolve.
- This is a **pointer**, not a snapshot — the agent reads live files, so nothing goes
  stale. We deliberately do **not** inline the title/description/criteria.

### The grab is now removable

`@assignment` is an ordinary token in a user-owned string. Deleting it is allowed and
produces a launch with no grab and no path/id injection — the user owns that choice.
No hard block. (Optional, default-off: `agents list` / `syntaur doctor` could note "this
agent's launchPrompt has no assignment grab." Flagged for review; not built unless wanted.)

## Seed assembly & behavior preservation

Resolution order for a fresh "Open in agent" launch:

1. Determine the effective template:
   - `agent.launchPrompt` if set, else
   - synthesized from back-compat `agent.playbook` if set (see Migration), else
   - **none.**
2. If there is **no** effective template → emit today's exact default:
   - project assignment → `/grab-assignment <projectSlug> <assignmentSlug>`
   - standalone → `/grab-assignment --id <id>` (preserves `INITIAL_PROMPT`'s current
     no-playbook branch verbatim).
3. If there **is** a template → resolve its `@`-tokens against the assignment context
   (`{ id, assignmentDir, projectSlug, assignmentSlug }`) and emit the result.

| Agent config | Seed handed to the CLI |
| --- | --- |
| no `launchPrompt`, no `playbook` | `/grab-assignment proj slug` *(unchanged)* |
| `playbook: e2e-dev-cycle` (no `launchPrompt`) | `@assignment` + `Run @e2e-dev-cycle end-to-end.` resolved (reproduces today's intent; wording changes to two sentences) |
| `launchPrompt: "@assignment Review @code-review-loop, then ship."` | fully user-controlled, tokens resolved |

> **Decision point for spec review:** keeping the bare `/grab-assignment` slash command
> as the no-config default (step 2) preserves the clean one-liner but means the
> path/id-survives-without-skill benefit only kicks in once a `launchPrompt`/`playbook` is
> present. Alternative: make the default template always `@assignment` so path/id is
> always injected, at the cost of the neat slash-command one-liner. Recommendation: keep
> the bare slash command (step 2) for zero-config back-compat.

## Migration: the old `playbook` field

`playbook: <slug>` is kept as **back-compat shorthand**, not removed:

- When an agent has `playbook: X` and **no** `launchPrompt`, syntaur synthesizes the
  default template `@assignment` + `Run @X end-to-end.` at launch.
- If both are set, **`launchPrompt` wins** and `playbook` is ignored for seed assembly
  (still shown in `agents list` for clarity).
- No config rewrite is forced. A later release may hard-migrate `playbook` → `launchPrompt`
  and drop the field.

## Storage & serialization

- `launchPrompt` is a **single-line** quoted scalar in `~/.syntaur/config.md`
  frontmatter, e.g. `    launchPrompt: "@assignment Run @e2e-dev-cycle end-to-end."`
- `yamlQuoteScalar` (`src/utils/config.ts:1361`) already quotes/escapes `@`, `:`, quotes,
  etc., and **throws on literal newlines** → enforces single-line for v1.
- `decodeYamlScalar` (`:1301`) already decodes `\n`/`\t`/`\"`. Multi-line support later is
  a small encoder change (emit `\n` escapes instead of throwing) — noted, not built.
- New parser/serializer wiring needed:
  - `assignAgentField` (`:1331`) → add `case 'launchPrompt'`.
  - `KNOWN_AGENT_SCALAR_FIELDS` set (`:1259`) → add `'launchPrompt'`.
  - `flushCurrent` agent-literal spread (`:1122`) → carry `launchPrompt`.
  - `serializeAgentsConfig` (`:1377`) → emit `launchPrompt` when set.

## CLI surface

`src/commands/agents.ts`:

- `agents add` / `agents set` → new `--launch-prompt <text>` option (empty string on
  `set` clears it, mirroring how `--playbook`/`--model` clear today at `:259`).
- `buildAgentFromOptions` / `mergeOptionsIntoAgent` → handle the new field.
- `agents list` line + `formatAgentLine` (`:306`) + dashboard `api-agents` display →
  show `launchPrompt` (probably truncated) so a `launchPrompt`-only change isn't reported
  as "(no changes)" by `renderDiff`.

## Data model

`src/utils/agents-schema.ts` `AgentConfig`:

```ts
/**
 * Editable launch prompt for a fresh "Open in agent" launch. The literal first
 * message handed to the agent, with @-tokens (@assignment, @<playbook-slug>)
 * resolved at launch time. When unset, falls back to back-compat `playbook`, then
 * to the bare /grab-assignment seed. Takes precedence over `playbook`.
 */
launchPrompt?: string;
```

`playbook?` stays (documented as back-compat shorthand).

## Token resolver

Generalize `INITIAL_PROMPT` (`src/tui/launch.ts:63`) into a resolver:

```
resolveLaunchPrompt({ template, id, assignmentDir, projectSlug, assignmentSlug })
  -> { prompt: string, warnings: string[] }
```

- Tokenize on `@<slug>` (slug = playbook slug grammar). Replace `@assignment` and
  `@<playbook>`; collect warnings for unknown tokens.
- Keep the existing no-template branches as the fallback path (step 2 above).
- Both call sites already have the needed context:
  - `src/launch/plan.ts:170` — `resolved` is a `ResolvedAssignment` (has `assignmentDir`, `id`).
  - `src/tui/launch.ts:226` (`launchAgent`) — computes `assignmentDir` at `:161`; thread it + `id` through.

## Edge cases

- **Standalone assignment** (`projectSlug === null`): `@assignment` drops the project,
  uses the standalone records dir; id + path still resolve.
- **`launchPrompt` references a playbook slug that doesn't exist:** warn, leave literal
  (don't validate against installed playbooks at config-write time — slugs may exist on
  another machine; validate-with-warning happens at launch).
- **Empty `launchPrompt`** (explicitly `""`): treated as "clear" on `set`; an empty
  template falls back per step 2.
- **`launchPrompt` with a literal `/grab-assignment ...`** (no `@assignment`): emitted
  as-is; no dedupe needed since nothing is structurally prepended.

## Testing

- `resolveLaunchPrompt` unit tests: `@assignment` (project + standalone), `@playbook`,
  multiple tokens, unknown token → warning + literal passthrough, empty/no template
  fallbacks, exact-back-compat for the no-config and `playbook`-only cases.
- Config round-trip: parse → serialize → parse for `launchPrompt` with special chars
  (`@`, `:`, quotes); newline rejected by serializer.
- CLI: `agents add/set --launch-prompt`, clear via empty string, `list`/diff display.
- Existing `INITIAL_PROMPT` tests (`src/__tests__/launch-tui.test.ts:225`) updated/kept
  green for the preserved fallback behaviors.

## Open questions (for spec review)

0. **[RESOLVED → Option A]** No configurable workspace-wide default and no `@playbook`
   token. Per-agent `launchPrompt` only, with the built-in fallback chain (per-agent
   `launchPrompt` → back-compat `playbook` → bare grab). A top-level default can be
   layered on later without breaking this model.
1. Default-template decision point (bare `/grab-assignment` vs always `@assignment`) —
   see the callout above. Recommendation: keep bare slash command for zero-config.
2. Soft "no grab in launchPrompt" note in `agents list` / `doctor` — build it or not?
   Default: not built.
3. Exact `@assignment` / `@playbook` wording — to be finalized in the resolver; examples
   here are indicative.
