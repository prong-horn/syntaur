# Editable agent `launchPrompt` with `@`-token resolution

**Date:** 2026-06-09
**Complexity:** medium
**Status:** Intermediate draft. **Superseded by the canonical assignment `plan.md`** (in the
assignment records dir) where details differ — notably token validation: the canonical plan
(Decision 4) **does** validate `@<playbook-slug>` against installed playbooks at launch and warns
on well-formed-but-unknown slugs. The bullet below predates that decision; defer to `plan.md`.
**Tech Stack:** TypeScript (ES2022, NodeNext, strict), Node >=20, ESM. CLI via commander + ink/React TUI. Build: tsup (`npm run build`). Typecheck: `npm run typecheck`. Tests: vitest (`npm test` / single file `npx vitest run src/__tests__/<file>.test.ts`).

## Objective
Give each agent profile an editable, user-owned `launchPrompt` string whose `@`-tokens (`@assignment`, `@<playbook-slug>`) resolve at launch time, replacing the hidden hardcoded wrapper in `INITIAL_PROMPT`. Per-agent only (Option A): no workspace-wide default, no `@playbook` token. Back-compat `playbook` and the bare `/grab-assignment` zero-config seed are preserved. Full design at `claude-info/plans/2026-06-09-agent-launch-prompt-design.md`.

## Files
| File | Action | Purpose |
|------|--------|---------|
| `src/launch/launch-prompt.ts` | CREATE | New `resolveLaunchPrompt` resolver: template + `@`-token expansion, fallback chain, warnings |
| `src/launch/index.ts` | MODIFY | Re-export `resolveLaunchPrompt` + its types |
| `src/utils/agents-schema.ts` | MODIFY | Add `launchPrompt?: string` to `AgentConfig` with doc comment |
| `src/utils/config.ts` | MODIFY | Parse/serialize `launchPrompt` (single-line); newline-reject in validate |
| `src/commands/agents.ts` | MODIFY | `--launch-prompt` add/set option, build/merge/clear, list + diff display |
| `src/dashboard/api-agents.ts` | MODIFY | Coerce `launchPrompt` string on dashboard PUT; map validation error |
| `src/tui/launch.ts` | MODIFY | Route `launchAgent` through `resolveLaunchPrompt`; thread `id` + `assignmentDir` |
| `src/launch/plan.ts` | MODIFY | Route `resolveAssignmentPlan` through `resolveLaunchPrompt` |
| `src/__tests__/launch-prompt.test.ts` | CREATE | Resolver unit tests (tokens, fallbacks, back-compat, standalone) |
| `src/__tests__/agents-config.test.ts` | MODIFY | `launchPrompt` config round-trip with `@`/`:`/quotes; newline rejection |
| `src/__tests__/agents-cli-format.test.ts` | MODIFY | `launchPrompt`-only `set` renders a distinct line (not "(no changes)") |
| `src/__tests__/launch-tui.test.ts` | MODIFY | Keep `INITIAL_PROMPT` back-compat cases green; add routed-resolver cases if `INITIAL_PROMPT` is retained vs replaced |
| `src/__tests__/dashboard-api-agents.test.ts` | MODIFY | `launchPrompt` survives the PUT round-trip; non-string rejected |

## Resolved wording (finalized from spec examples)

**`@assignment` (project assignment)** — single replacement string:
```
This session is Syntaur assignment <id>, with records at <assignmentDir>. Claim and bind it with the /grab-assignment skill if available; otherwise read assignment.md, plan*.md, and progress.md in that directory for full context.
```

**`@assignment` (standalone, `projectSlug === null`)** — same wording; drops nothing structural (the sentence never names the project). Uses the standalone records dir as `<assignmentDir>`; `<id>` still resolves.

**`@<playbook-slug>`** — replaced inline (noun + how to load; author writes surrounding verbs):
```
the `<slug>` playbook via the /run-playbook skill
```

**`@<unknown>`** — leave the literal `@<unknown>` text in place; push a warning string; do NOT abort the launch.

**Reserved token:** `assignment` always wins (a playbook literally named `assignment` is a documented collision).

**Tokenizer grammar:** match `@` followed by the playbook slug grammar `[a-z0-9]+(-[a-z0-9]+)*` (mirror `isValidSlug`, `src/utils/slug.ts:11`). Resolution rules:
- `@assignment` → reserved-token wording above.
- any other well-formed `@<slug>` → playbook replacement wording. **[SUPERSEDED by plan.md Decision 4:** validate against the installed-playbook set injected by the call sites; known → resolve with no warning, well-formed-but-unknown → warn + leave literal.**]**
- `@` not followed by a valid slug (bare `@`, `@<non-slug>`, `@FOO`) → leave the literal text in place AND push a warning. Launch is never aborted.

This is the "unknown `@token`" path in criterion 3: the warn-and-leave-literal case is a malformed `@`-token the author typed, surfaced at launch so the agent still sees the literal intent.

## Fallback chain (no/empty `launchPrompt`)
1. `agent.launchPrompt` (trimmed non-empty) → resolve its tokens.
2. else `agent.playbook` set → synthesize template `@assignment Run @<playbook> end-to-end.` then resolve.
3. else → today's bare seed verbatim: project → `/grab-assignment <projectSlug> <assignmentSlug>`; standalone with id → `/grab-assignment --id <id>`; slug fallback → `/grab-assignment <assignmentSlug>`.

`launchPrompt` wins when both `launchPrompt` and `playbook` are set.

## Tasks

### 1. Add `launchPrompt` to the schema
- **File:** `src/utils/agents-schema.ts` (MODIFY) — `AgentConfig` interface :17, add adjacent to `playbook?` :40
- **What:** Add `launchPrompt?: string;` with the doc comment from the design spec (editable first message; `@`-tokens resolved at launch; falls back to `playbook` then bare grab; takes precedence over `playbook`).
- **Pattern:** Mirror the `model?` / `playbook?` doc-comment style already in this interface.
- **Verify:** `npm run typecheck`

### 2. Create the resolver module
- **File:** `src/launch/launch-prompt.ts` (CREATE)
- **What:** Export `resolveLaunchPrompt(args: { template?: string | null; playbook?: string | null; id: string; assignmentDir: string; projectSlug: string | null; assignmentSlug: string }) -> { prompt: string; warnings: string[] }`. Implement the fallback chain (Task description above): pick effective template (`template` → synth from `playbook` → none); if none, return the bare-seed branches (port `INITIAL_PROMPT`'s no-playbook logic verbatim) with empty warnings; if a template, tokenize and replace `@assignment` (reserved wording) and `@<slug>` (playbook wording), collecting warnings for malformed `@`-tokens; return resolved prompt.
- **Pattern:** Port the bare-seed branches from `INITIAL_PROMPT` (`src/tui/launch.ts:71-81`) exactly; reuse the slug grammar from `src/utils/slug.ts:11` for the tokenizer.
- **Verify:** `npx vitest run src/__tests__/launch-prompt.test.ts`

### 3. Re-export the resolver
- **File:** `src/launch/index.ts` (MODIFY) — after the `./plan.js` / `./argv.js` re-exports
- **What:** Add `export { resolveLaunchPrompt, type ... } from './launch-prompt.js';`
- **Pattern:** Mirror the existing block re-exports (`./url.js`, `./plan.js`, `./argv.js`).
- **Verify:** `npm run typecheck`

### 4. Parse `launchPrompt` from config.md
- **File:** `src/utils/config.ts` (MODIFY)
- **What:**
  - `flushCurrent` agent-literal spread :1133 → carry `...(current.launchPrompt ? { launchPrompt: current.launchPrompt } : {})` after `playbook`.
  - `KNOWN_AGENT_SCALAR_FIELDS` set :1259 → add `'launchPrompt'`.
  - `assignAgentField` :1331 → add `case 'launchPrompt': target.launchPrompt = value; break;` after `playbook`.
- **Pattern:** Each change mirrors the existing `playbook` handling line-for-line. `decodeYamlScalar` :1301 already decodes `\n`/`\t`/`\"`/`\\`/`''` — no change needed.
- **Verify:** `npx vitest run src/__tests__/agents-config.test.ts`

### 5. Serialize `launchPrompt` to config.md + newline rejection
- **File:** `src/utils/config.ts` (MODIFY)
- **What:**
  - `serializeAgentsConfig` :1377 → emit `if (a.launchPrompt) lines.push(`    launchPrompt: ${yamlQuoteScalar(a.launchPrompt)}`);` after the `playbook` block :1386-1388. `yamlQuoteScalar` :1361 already force-quotes `@`/`:`/quotes and throws on `[\r\n]` → single-line enforced for free.
  - `validateAgentList` :208 → add a `launchPrompt` newline-rejection check (mirror the `model` check :233) for parity, so an invalid value surfaces a clean error before serialize.
- **Pattern:** `playbook` serialize block :1386-1388; `model` validate check :233.
- **Verify:** `npx vitest run src/__tests__/agents-config.test.ts`

### 6. CLI: `--launch-prompt` on add/set, build/merge/clear
- **File:** `src/commands/agents.ts` (MODIFY)
- **What:**
  - `AddOptions` :44 + `SetOptions` :122 → add `launchPrompt?: string`.
  - `agents add` :68 → add `.option('--launch-prompt <text>', 'Literal launch prompt with @assignment / @<playbook> tokens')` after `--playbook`.
  - `agents set` :146 → add the same `--launch-prompt <text>` option (note: empty string clears).
  - `buildAgentFromOptions` :217 → `if (options.launchPrompt && options.launchPrompt.trim()) agent.launchPrompt = options.launchPrompt;` (do NOT trim the stored value — preserve leading/trailing/internal spacing the author wrote; only the emptiness gate trims). Mirror after `playbook` :231.
  - `mergeOptionsIntoAgent` :236 → empty-string-clears block mirroring `--playbook` :259-263: `if (options.launchPrompt !== undefined) { if (options.launchPrompt.trim()) merged.launchPrompt = options.launchPrompt; else delete merged.launchPrompt; }`.
- **Pattern:** `--playbook` option + `buildAgentFromOptions` :231 + `mergeOptionsIntoAgent` :259-263.
- **Verify:** `npm run typecheck` then `npx vitest run src/__tests__/agents-cli-format.test.ts`

### 7. CLI display: list + diff line
- **File:** `src/commands/agents.ts` (MODIFY)
- **What:**
  - `formatAgentLine` :306 → add a `launchPrompt` flag (truncated, e.g. first ~40 chars) after `playbook` :312, so a `launchPrompt`-only `set` is not collapsed to "(no changes)" by `renderDiff` :287.
  - `agents list` inline flags :33-34 → add the same truncated `launchPrompt` flag after the `playbook` flag.
- **Pattern:** `model` / `playbook` flags at :311-312 and :33-34.
- **Verify:** `npx vitest run src/__tests__/agents-cli-format.test.ts`

### 8. Dashboard coerce on PUT
- **File:** `src/dashboard/api-agents.ts` (MODIFY)
- **What:**
  - `coerceAgentRow` :234-262 → add a parallel `launchPrompt` string-coerce block after `playbook` :249-262: reject non-string with a 400 + fieldErrors; on a non-empty trimmed value, set `cleaned.launchPrompt = entry.launchPrompt` (store untrimmed value, empty-after-trim drops it). Otherwise the dashboard round-trip silently drops `launchPrompt`.
  - Error mapping :92-110 → add a `launchPrompt` invalid-value match arm if validate emits one (parallel to the `model` :102-110 arm).
- **Pattern:** The `playbook` coerce block :249-262 and the `model` error map arm :102-110.
- **Verify:** `npx vitest run src/__tests__/dashboard-api-agents.test.ts`

### 9. Route TUI launch call site through the resolver
- **File:** `src/tui/launch.ts` (MODIFY) — `launchAgent` call site :224-227
- **What:** Replace `INITIAL_PROMPT({ projectSlug, assignmentSlug, playbook: agent.playbook })` with `resolveLaunchPrompt({ template: agent.launchPrompt, playbook: agent.playbook, id: detail.id, assignmentDir, projectSlug, assignmentSlug }).prompt`, and `console.warn` each returned warning. `assignmentDir` is in scope :161; `detail.id` is in scope (`AssignmentDetail` from `getAssignmentDetail` :154). Import `resolveLaunchPrompt` from `../launch/index.js`.
- **What (INITIAL_PROMPT):** Keep `INITIAL_PROMPT` exported for now (the resolver ports its logic; existing `launch-tui.test.ts:225` suite still references it) OR have it delegate to `resolveLaunchPrompt`. Decide during implementation: simplest is to keep the bare-seed logic in the resolver and leave `INITIAL_PROMPT` as a thin pass-through so its tests stay green. Do NOT delete it without updating `launch-tui.test.ts`.
- **Pattern:** Existing `buildAgentArgv(agent, INITIAL_PROMPT({...}))` :224-226.
- **Verify:** `npx vitest run src/__tests__/launch-tui.test.ts src/__tests__/launch-end-to-end.test.ts`

### 10. Route plan.ts launch call site through the resolver
- **File:** `src/launch/plan.ts` (MODIFY) — `resolveAssignmentPlan` call site :168-176
- **What:** Replace `INITIAL_PROMPT({ projectSlug: resolved.projectSlug, assignmentSlug: resolved.assignmentSlug, id: resolved.id, playbook: agent.playbook })` with `resolveLaunchPrompt({ template: agent.launchPrompt, playbook: agent.playbook, id: resolved.id, assignmentDir: resolved.assignmentDir, projectSlug: resolved.projectSlug, assignmentSlug: resolved.assignmentSlug }).prompt`. `resolved` is a full `ResolvedAssignment` (`src/utils/assignment-resolver.ts:6`) with `assignmentDir`/`id`/`projectSlug`/`assignmentSlug`. Surface warnings via the plan's existing warning path or `console.warn`. Update the import (drop `INITIAL_PROMPT` if no longer used; add `resolveLaunchPrompt`).
- **Pattern:** Existing `buildFreshArgv(agent, INITIAL_PROMPT({...}))` :168-176.
- **Verify:** `npx vitest run src/__tests__/launch-plan.test.ts`

### 11. Resolver unit tests
- **File:** `src/__tests__/launch-prompt.test.ts` (CREATE)
- **What:** Cover: `@assignment` project (asserts id + assignmentDir + grab-if-available + read-fallback wording); `@assignment` standalone (`projectSlug: null`); `@<playbook>` single + multiple tokens in one template; malformed `@`-token → warning + literal passthrough, launch not aborted (warnings non-empty, prompt retains literal); empty/undefined template with `playbook` set → synth `@assignment Run @<playbook> end-to-end.` resolved; no template + no playbook → exact bare `/grab-assignment <proj> <slug>` and standalone `--id <id>` strings (back-compat); `launchPrompt` wins when both set.
- **Pattern:** `launch-tui.test.ts:225` `describe('INITIAL_PROMPT')` assertion style (exact strings for back-compat, `.toContain` for composed sentences).
- **Verify:** `npx vitest run src/__tests__/launch-prompt.test.ts`

### 12. Extend config + CLI + dashboard tests
- **Files:** `src/__tests__/agents-config.test.ts`, `src/__tests__/agents-cli-format.test.ts`, `src/__tests__/dashboard-api-agents.test.ts` (MODIFY)
- **What:**
  - `agents-config.test.ts` round-trip suite :128 → add a `launchPrompt` parse→serialize→parse case with `@`, `:`, and `"`; assert a literal-newline value is rejected by the serializer.
  - `agents-cli-format.test.ts` (regression guard :14 "different line when only model changes") → add the parallel `launchPrompt`-only-`set` case asserting `formatAgentLine` differs (not "(no changes)").
  - `dashboard-api-agents.test.ts` → assert `launchPrompt` survives a PUT round-trip and a non-string `launchPrompt` is rejected 400.
- **Pattern:** `model`/`playbook` cases already present in each file (round-trip :172, format :8-14, dashboard coerce tests).
- **Verify:** `npx vitest run src/__tests__/agents-config.test.ts src/__tests__/agents-cli-format.test.ts src/__tests__/dashboard-api-agents.test.ts`

### 13. Final verification + acceptance-criteria recheck
- **What:** Run `npm run typecheck` and `npm test`. Then walk each acceptance criterion and confirm a passing test or code path proves it:
  1. `launchPrompt` settable/clearable via add/set, round-trips config.md single-line, shows in `agents list` → Tasks 1,4,5,6,7,12.
  2. `@assignment` resolves to id + records-dir + grab-if-available + skill-free read fallback → Tasks 2,11.
  3. `@<playbook>` → `/run-playbook` reference; malformed `@token` warns + literal, launch not aborted → Tasks 2,11.
  4. Deleting `@assignment` yields a launch with no grab/injection; nothing force-prepended → Task 2 (no structural prepend) + Task 11 (template-without-`@assignment` case).
  5. Back-compat: `playbook` still works (synth default when no `launchPrompt`); `launchPrompt` wins when both; zero-config emits today's bare `/grab-assignment` seed → Tasks 2,9,10,11.
  6. Both call sites route through the resolver → Tasks 9,10.
  7. Tests cover resolution, fallbacks, back-compat, config round-trip → Tasks 11,12.
- **Verify:** `npm run typecheck && npm test`

## Dependencies
- No new packages, env vars, or external prerequisites. All work is internal to existing modules.

## Verification
- `npm run typecheck` — strict TS clean.
- `npm test` (vitest) — full suite green, including the preserved `INITIAL_PROMPT` back-compat assertions in `launch-tui.test.ts` and the new `launch-prompt.test.ts`.
- Manual spot-check (optional): `node dist/... agents set <id> --launch-prompt "@assignment Run @e2e-dev-cycle end-to-end."` then `agents list` shows the prompt; clear with `--launch-prompt ""`.
