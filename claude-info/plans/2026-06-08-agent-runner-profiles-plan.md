---
assignment: agent-runner-profiles-model-playbook-on-open
status: draft
created: "2026-06-08T17:08:08Z"
updated: "2026-06-08T17:19:58Z"
---

# Plan: Agent runner profiles (model + playbook on open)

> Revised after codex plan-review (gpt-5.5, xhigh) — NEEDS REVISION findings
> folded in: real test locations (`src/__tests__/`, public-API round-trip),
> `isValidSlug` reconciliation, model precedence, async picker init,
> `npm run typecheck`, CLI + docs parity, and a mandatory chaining smoke test.

## Overview

Turn each Settings › Agents entry into a full **runner profile** by adding two
optional fields — `model` and `playbook` — to `AgentConfig`. Plumb the model
into the launched CLI as a generic `--model <value>` flag (fresh launch and
resume/fork), and plumb the playbook into the fresh-launch seed prompt so the
agent grabs the assignment **and** runs the playbook end-to-end. Add an agent
picker to the "Open in agent" flow so a specific profile launches via a new
`?agent=<id>` URL param, falling back to the default agent when omitted.
Everything is additive and backward compatible: blank `model` omits the flag,
absent `playbook` keeps today's exact `/grab-assignment` seed, and absent
`agent` keeps today's default-agent selection.

Design spec: `claude-info/plans/2026-06-08-agent-runner-profiles-design.md`.

## Tasks

### Task 1 — Schema + model-flag helper (low)
**File:** `src/utils/agents-schema.ts`
- Add to `AgentConfig`:
  ```ts
  model?: string;     // injected as `--model <value>`; blank => omitted
  playbook?: string;  // playbook slug; seeds /run-playbook on fresh launch
  ```
- Add an exported pure helper used by both argv builders:
  ```ts
  export function modelFlagArgs(agent: AgentConfig): string[] {
    const m = agent.model?.trim();
    return m ? ['--model', m] : [];
  }
  ```
- No deps. Depended on by Tasks 2, 3, 4.

### Task 2 — Config parse / serialize / validate round-trip (medium)
**File:** `src/utils/config.ts`
- `KNOWN_AGENT_SCALAR_FIELDS` set (line 1242): add `'model'`, `'playbook'`.
- `assignAgentField` switch (line ~1312): add `case 'model': target.model = value;`
  and `case 'playbook': target.playbook = value;`.
- `parseAgentsConfig` → `flushCurrent` agent spread (line ~1110): add
  `...(current.model ? { model: current.model } : {})` and
  `...(current.playbook ? { playbook: current.playbook } : {})`.
- `serializeAgentsConfig` (line 1352): after the `command` line, emit when present:
  ```ts
  if (a.model) lines.push(`    model: ${yamlQuoteScalar(a.model)}`);
  if (a.playbook) lines.push(`    playbook: ${yamlQuoteScalar(a.playbook)}`);
  ```
- `validateAgentList` (line 207): after the `promptArgPosition` check, validate
  the new fields with field-mappable messages (consumed by Task 6):
  - `model`: if present, must be a string with **no newline** (`/[\r\n]/`).
    Throw `AgentConfigError('agent "<id>" has invalid model — must be a single line')`.
    (Catches the newline early with a `model`-specific message instead of the
    generic `yamlQuoteScalar` newline throw at serialize time.) Empty/whitespace
    is treated as absent — skip.
  - `playbook`: if present and non-empty, must satisfy `isValidSlug` from
    `src/utils/slug.ts` — NOTE the real validator is
    `/^[a-z0-9]+(-[a-z0-9]+)*$/` (no underscores, no leading/trailing/repeated
    hyphens), **stricter** than the agent-id pattern; do not reuse
    `AGENT_ID_PATTERN`. Throw `AgentConfigError('agent "<id>" has invalid
    playbook "<value>" — must be a valid playbook slug')` on mismatch.
- **Dependencies:** Task 1.

### Task 3 — Model injection in argv builders (medium)
**Files:** `src/tui/launch.ts`, `src/launch/argv.ts`
- `buildAgentArgv` (`src/tui/launch.ts`: fn at line 83; `baseArgs` at line 89):
  change `const baseArgs = [...(agent.args ?? [])];` →
  `const baseArgs = [...(agent.args ?? []), ...modelFlagArgs(agent)];`
  (import `modelFlagArgs` from `../utils/agents-schema.js`). The model flag is
  placed **after** `agent.args` so the profile model is authoritative: if a user
  also hand-wrote `--model X` in `args`, the profile flag comes later and CLI
  last-wins makes the profile win. Fresh launch has no subcommand, so a trailing
  `--model <v>` is valid for `promptArgPosition` `first|last|none` (e.g. `last` →
  `[...args, --model, v, prompt]` = `claude args --model v "<prompt>"`). It is
  included in the `resolveFromShellAliases` quoting (which quotes
  `[agent.command, ...agentArgs]` element-by-element).
- `buildSessionArgv` (`src/launch/argv.ts:55`): change
  `const agentArgs = [...(agent.args ?? []), ...substituted];` →
  `const agentArgs = [...(agent.args ?? []), ...modelFlagArgs(agent), ...substituted];`.
  Model goes **after** `agent.args` (profile authoritative) but **before** the
  resume/fork `substituted` args, which matters for subcommand-style agents
  (`codex resume <id>` → `codex [args] --model <v> resume <id>`, verified working
  on Codex 0.135.0; with no agent.args this is identical to the verified
  `codex --model <v> resume <id>`).
- **Model precedence (decision):** the profile `model` is authoritative because
  `modelFlagArgs` is emitted after `agent.args` (CLI last-wins). Document this in
  a code comment on `modelFlagArgs`; no runtime de-dup (YAGNI).
- **Dependencies:** Task 1.

### Task 4 — Playbook chaining in the fresh-launch seed (medium)
**Files:** `src/tui/launch.ts`, `src/launch/plan.ts`
- Extend `INITIAL_PROMPT` (`src/tui/launch.ts:52`) signature with
  `playbook?: string | null`. Behavior:
  - **No playbook (unchanged):** existing `/grab-assignment ...` for ALL THREE
    current branches — project form `/grab-assignment <proj> <asg>`, standalone
    `--id <uuid>`, and the slug-only fallback at line 63.
  - **With playbook:** return an instruction-style seed. Define a variant for
    EACH branch so the rare slug-fallback is covered too:
    - project: `Grab the Syntaur assignment \`<proj>/<asg>\` using the /grab-assignment skill, then load and run the \`<slug>\` playbook using the /run-playbook skill and carry it out end-to-end.`
    - standalone: same, grab clause `…assignment id \`<uuid>\` using /grab-assignment --id <uuid>…`.
    - slug fallback: same, grab clause `…assignment \`<asg-slug>\` using /grab-assignment…`.
  - Add a code comment: a Claude Code message fires only ONE leading
    slash-command, so chaining two skills requires a plain-language seed. This is
    the CHOSEN approach (not a verified guarantee) — it asks the model to invoke
    both skills; correctness is proven by the Task 10 smoke test, not by string
    construction. (`grab-assignment` loads playbook *context*; `run-playbook`
    *executes* a specific enabled playbook — they are complementary, not
    redundant.)
- `resolveAssignmentPlan` (`src/launch/plan.ts:148`): pass
  `playbook: agent.playbook` into the `INITIAL_PROMPT({...})` call.
- `launchAgent` (`src/tui/launch.ts:194`, the TUI-internal launcher): pass
  `playbook: agent.playbook` into its `INITIAL_PROMPT({...})` call so the TUI
  "open" path has parity with the deep-link path.
- **Dependencies:** Task 1.

### Task 5 — Agent selection on open: URL param + plan wiring (medium)
**Files:** `src/launch/url.ts`, `src/launch/plan.ts`, `src/commands/url.ts`
- `parseOpenUrl` (`src/launch/url.ts`): parse an optional `agent` query param.
  - Add `agent?: string` to `ParsedOpenUrl`.
  - `getAll('agent')`: >1 → `OpenUrlError('duplicate-param', ...)`; exactly one
    non-empty value → set `agent`; empty/absent → leave undefined.
  - Include `agent` on both the assignment and session returns via
    `...(agent ? { agent } : {})`. (Sessions pin their agent from the session
    record, so the value is parsed-but-ignored downstream — see urlCommand. Add
    a one-line doc comment on `agent?` in `ParsedOpenUrl` noting sessions ignore
    it; we accept-and-ignore rather than reject to keep the parser simple.)
- `ResolveLaunchPlanInput` (`src/launch/plan.ts:49`): add optional `agentId?: string`.
- `resolveAssignmentPlan` (`src/launch/plan.ts:147`): replace
  `const agent = pickAgent(input.config);` with:
  ```ts
  let agent: AgentConfig;
  if (input.agentId) {
    const found = getAgents(input.config).find((a) => a.id === input.agentId);
    if (!found) {
      throw new LaunchError(
        'agent-not-configured',
        `Agent "${input.agentId}" requested in the open URL is not in your agents list.`,
      );
    }
    agent = found;
  } else {
    agent = pickAgent(input.config);
  }
  ```
  (`getAgents` is already imported in plan.ts; `AgentConfig` type already imported.)
- `urlCommand` (`src/commands/url.ts:54`): add
  `agentId: parsed.kind === 'assignment' ? parsed.agent : undefined,` to the
  `resolveLaunchPlan({...})` input. Preflight (`api-launch-preflight.ts`) is
  agent-independent — confirmed no change needed.
- **Dependencies:** none on 1–4 (parallelizable), but Tasks 4 and 5 both edit
  `plan.ts`/`launch.ts` — sequence to avoid merge churn.

### Task 6 — API validation for the new fields (low)
**File:** `src/dashboard/api-agents.ts`
- `coerceAgentRow`: after the `default` block (line ~212), add optional handling:
  - `model`: if `entry.model !== undefined` → must be a string (else 400 field
    error `field:'model'`); `const m = entry.model.trim(); if (m) cleaned.model = m;`.
  - `playbook`: if `entry.playbook !== undefined` → must be a string (else 400
    field error `field:'playbook'`); `const p = entry.playbook.trim(); if (p)
    cleaned.playbook = p;`. (Slug-shape + model-newline validation is enforced
    server-side by `writeAgentsConfig`→`validateAgentList`; mapped below.)
- `mapAgentErrorToFieldErrors`: add branches matching
  `/^agent "([^"]+)" has invalid playbook/` → `field:'playbook'` and
  `/^agent "([^"]+)" has invalid model/` → `field:'model'`.
- **Dependencies:** Task 2 (error message text).

### Task 7 — Settings UI: Model input + Playbook select (medium)
**Files:** `dashboard/src/pages/AgentsSection.tsx`,
`dashboard/src/hooks/useAgentsConfig.ts`
- `useAgentsConfig.ts` `normalizeRow` (line ~43): carry the new fields through:
  `if (typeof entry.model === 'string') agent.model = entry.model;` and
  `if (typeof entry.playbook === 'string') agent.playbook = entry.playbook;`.
- `AgentsSection.tsx`:
  - `FieldKey` union: add `'model'` and `'playbook'`.
  - `EditableAgent`: add `model: string;` and `playbook: string;`.
  - `hydrate`: `model: a.model ?? ''`, `playbook: a.playbook ?? ''`.
  - `buildPayload`: `if (row.model.trim()) agent.model = row.model.trim();`
    `if (row.playbook.trim()) agent.playbook = row.playbook.trim();`.
  - `rowsAreEqual`: include `model` and `playbook` in the field comparison.
  - `stripErrorsForPatch`: clear `model`/`playbook` on matching patch keys.
  - `addRow` defaults: `model: ''`, `playbook: ''`.
  - Lift a single `usePlaybooks()` call (`dashboard/src/hooks/useProjects.ts:717`)
    into `AgentsSection`; filter `p.enabled`; pass the resulting
    `{slug, name}[]` down to `SortableAgentRow` as a prop (avoid N fetches; pass
    `[]` while loading).
  - `SortableAgentRow`: add two fields to the existing
    `grid grid-cols-1 sm:grid-cols-2` block, mirroring Command/Args markup:
    - **Model** — `<input type="text" placeholder="opus" ...>` patching `model`,
      with the same `errorClass('model')` + field-error `<p>` pattern.
    - **Playbook** — `<select>` with a `— none —` option (value `''`) plus an
      `<option value={p.slug}>{p.name}</option>` per enabled playbook. If the
      row's current `playbook` slug is not in the enabled list (stale/disabled),
      render it as an extra trailing option so the value is preserved on save.
- **Dependencies:** Task 1 (types).

### Task 8 — Open-in-agent dropdown (medium)
**Files:** `dashboard/src/lib/recreate-flow.ts`,
`dashboard/src/components/useRecreateFlow.tsx`,
`dashboard/src/components/OpenInAgentButton.tsx`
- `continuationUrl` (`recreate-flow.ts:20`): add a 4th optional param
  `agentId?: string`; when set AND `target.kind === 'assignment'`, append
  `&agent=${encodeURIComponent(agentId)}`.
- `useRecreateFlow` (`useRecreateFlow.tsx`):
  - `open(target, mode?, agentId?)`: thread `agentId` through; store it in
    `Pending` so `confirmFallback` and `confirmRecreate` re-fire the URL with the
    same agent. Pass `agentId` into EVERY `continuationUrl(...)` call (initial
    fire, the network/5xx best-effort fire, the catch fire, fallback, recreate).
- `OpenInAgentButton.tsx`:
  - For `target.kind === 'assignment'`, render a compact agent `<select>` before
    the button, sourced from `useAgentsConfig()`. **Async init:** the hook returns
    `[]` then resolves, so keep `const [selectedAgentId, setSelectedAgentId] =
    useState<string | null>(null)` and a `useEffect([agents])` that, once agents
    load, sets the selection to the still-valid current choice if present, else
    the agent with `default: true`, else the first agent's id. Render the select
    value as `selectedAgentId ?? ''`.
  - `onClick` → `flow.open(target, undefined, selectedAgentId ?? undefined)`.
  - Session targets: no dropdown (agent pinned by the session record).
  - Keep the existing disabled-state markup unchanged.
- **Dependencies:** Task 5 (server must parse `agent=`).

### Task 9 — CLI + docs parity (low)
**Files:** `src/commands/agents.ts`, `docs/protocol/file-formats.md`
(Ordered BEFORE tests so Task 10 can cover the CLI.)
- `agents add` (line 54) + `agents set` (line 126): add `--model <model>` and
  `--playbook <slug>` options; thread them through `buildAgentFromOptions`
  (line 207) and `mergeOptionsIntoAgent` (line 224) and the `AddOptions`/
  `SetOptions` interfaces. Empty trims to omitted; `set` supports clearing via
  empty string (`if (options.playbook !== undefined) { const p =
  options.playbook.trim(); if (p) merged.playbook = p; else delete
  merged.playbook; }`, same shape for `model`). Validation stays centralized in
  `validateAgentList` — no new validation here.
- **Fix the diff/list formatters so model/playbook-only changes are visible**
  (else a `set --model X` renders an identical `formatAgentLine` and
  `renderDiff` falsely prints "(no changes)"):
  - `formatAgentLine` (line 281): push `model=<v>` and `playbook=<slug>` into the
    `flags` array when set.
  - `agents list` action (lines 28-35): add the same `model`/`playbook` to its
    inline flag list so `list` surfaces the profile.
- `docs/protocol/file-formats.md` (agents table ~line 1357): add `model` and
  `playbook` rows (type, required=optional, default, description incl. the
  `--model` injection behavior and that `playbook` must be a valid playbook slug
  per `isValidSlug`).
- **Dependencies:** Tasks 1–2.

### Task 10 — Tests (medium)
Tests live in `src/__tests__/` (backend Vitest); extend the EXISTING files named
below rather than creating co-located ones. Dashboard-pure helpers
(`recreate-flow.ts`) are already backend-importable per that file's header.
- `src/__tests__/launch-argv.test.ts` — `modelFlagArgs` present/absent;
  `buildAgentArgv` `--model` ordering for `first|last|none` (model AFTER
  `agent.args`, profile-wins); model included in the `resolveFromShellAliases`
  quoted command.
- `src/__tests__/launch-session-argv.test.ts` — `buildSessionArgv` emits
  `--model` after `agent.args` and before the resume/fork `substituted` args.
- `src/__tests__/launch-tui.test.ts` — `INITIAL_PROMPT`: no-playbook output
  byte-for-byte unchanged for all three branches; with-playbook chains
  grab + run-playbook for project / standalone / slug-fallback forms.
- `src/__tests__/url-parser.test.ts` — `parseOpenUrl` parses `agent=`; absent →
  undefined; empty → undefined; duplicate `agent` → `duplicate-param`;
  coexistence with `terminal`/`mode`; session branch carries `agent` but it's
  inert.
- `src/__tests__/url-command.test.ts` — `urlCommand` threads `parsed.agent` →
  `agentId` for assignments and `undefined` for sessions.
- `src/__tests__/launch-plan.test.ts` — `resolveAssignmentPlan` honors `agentId`;
  falls back to default when omitted; unknown `agentId` →
  `LaunchError('agent-not-configured')`; threads `agent.playbook` into the seed
  (assert the resolved argv contains the playbook instruction).
- `src/__tests__/agents-config.test.ts` — round-trip via PUBLIC API
  (`writeAgentsConfig` → `readConfig`/`getAgents`) preserves `model` +
  `playbook`; `validateAgentList` accepts valid, rejects a bad playbook slug
  (underscore / leading hyphen) and a newline model.
- `src/__tests__/dashboard-api-agents.test.ts` — `coerceAgentRow` accepts
  `model`/`playbook`, normalizes empty → omitted, rejects non-string;
  `mapAgentErrorToFieldErrors` maps invalid-playbook → `field:'playbook'` and
  invalid-model → `field:'model'`.
- `recreate-flow` tests (find the existing file exercising `continuationUrl`, or
  add `src/__tests__/recreate-flow.test.ts`): `&agent=` appended for assignment
  targets only; encoding; omitted when no agentId; mode + agent coexist.
- `src/__tests__/` agents CLI tests (extend the existing agents-CLI test if one
  exists, else add): `agents add`/`set` accept `--model`/`--playbook` and persist
  them; `set --model ''` clears; `renderDiff` reports a model/playbook-only `set`
  as a real change (NOT "(no changes)"); `agents list`/`formatAgentLine` surface
  the fields.
- **Dependencies:** Tasks 1–9.

### Task 11 — Verify build + tests + chaining smoke (medium)
- Fresh worktree first-time setup (per memory): `npm install` at root +
  `npm install --prefix dashboard`, root `npm run build`.
- Gates: root `npm run typecheck` (= `tsc --noEmit`, the real TS check — `build`
  is tsup and does not typecheck) AND `npm test`; dashboard
  `npm run build --prefix dashboard` for the React typecheck.
- **Mandatory chaining smoke test:** set `model` + `playbook` on the default
  agent, then actually launch a real Claude session via "Open in agent" against a
  throwaway assignment and CONFIRM both `/grab-assignment` and `/run-playbook`
  fire and the playbook is followed. The prose-chaining seed is unproven by code
  alone — this is the proof. CLI dry-run to inspect argv without spawning:
  `syntaur url 'syntaur://open?assignment=<id>&agent=<id>' --print-plan` (assert
  `--model` present and the seed references the playbook).
- **Dependencies:** all prior tasks.

## Acceptance Criteria Mapping

- **AC1** (schema + round-trip + validation) → Tasks 1, 2, 10.
- **AC2** (Settings UI for model + playbook, persisted) → Tasks 6, 7, 10.
- **AC3** (`--model` on fresh + resume/fork; blank omits) → Tasks 1, 3, 10.
- **AC4** (playbook seed chains grab + run-playbook; absent = unchanged) →
  Tasks 4, 10, 11 (smoke).
- **AC5** (`?agent=` selection, default fallback, unknown errors) → Tasks 5, 8, 10.
- **AC6** (tests + build pass) → Tasks 10, 11. (CLI + docs parity: Task 9.)

## Risks and Open Questions

- **Playbook chaining is prose, not a guarantee.** The seed asks Claude to invoke
  /grab-assignment then /run-playbook; it does not mechanically execute them.
  Mitigation: the Task 11 smoke test is mandatory. If it proves flaky, the
  deterministic upgrade (out of scope now) is to add a `--playbook <slug>`
  argument to the `grab-assignment` skill so one slash-command both grabs and
  runs — captured as a follow-up, not built here.
- **`--model` portability.** Generic `--model` is verified for claude + codex
  (incl. codex resume/fork). pi/openclaw/hermes flags are unverified — leave
  `model` blank for those. No per-agent flag template (YAGNI).
- **Model precedence.** Profile `model` is authoritative by placement —
  `modelFlagArgs` is emitted AFTER `agent.args`, so even a manual `--model` in
  `args` is overridden via CLI last-wins. No runtime de-dup (YAGNI).
- **Compact button layout.** The agent `<select>` in `size === 'compact'` row
  actions is space-constrained; acceptable for MVP, caret split-button later if
  cramped.
- **Stale playbook slug.** A saved `playbook` later disabled/deleted is preserved
  (UI shows it as an extra option). The seed asks the agent to load a missing
  playbook — acceptable, low blast radius.
- **Session `agent=`.** Parsed but ignored for sessions (agent pinned by record);
  accept-and-ignore documented rather than reject, to keep the parser simple.

## Testing Strategy

- Unit tests extend the existing `src/__tests__/` files enumerated in Task 9
  (Vitest), using public APIs for config round-trip.
- Gates: root `npm run typecheck` + `npm test`; dashboard
  `npm run build --prefix dashboard`.
- A real Claude "Open in agent" smoke test (Task 10) proves the playbook seed
  fires both skills — the one behavior unit tests cannot cover.
