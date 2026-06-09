# Dashboard launchPrompt editing UI (Phase B)

**Date:** 2026-06-09
**Complexity:** medium
**Tech Stack:** Syntaur CLI (TypeScript ESM, vitest, tsup) + dashboard React 18 / Vite 6 / Tailwind / Radix UI. Build: root `npm run build` + `npm run typecheck`; dashboard `npm run build --prefix dashboard` (`tsc -b && vite build`); tests root `npm test` (vitest, `include: ['src/__tests__/**/*.test.ts']`).

## Objective
Make the per-agent `launchPrompt` shipped in Phase A visible and editable in the dashboard across two surfaces: (1) the agent-profile editor authors/clears the stored template; (2) the "Open in agent" launch flow shows an editable, `@`-autocompleting prompt box prefilled with the effective template, whose edited text rides one launch via a new `prompt=` URL param and is **re-resolved server-side** through the existing `resolveLaunchPrompt` (one resolution path). The launch-box edit is a **per-launch override only** — it does NOT persist back to `AgentConfig.launchPrompt`.

## Key semantics (do not re-litigate)
- **Effective template (prefill):** `agent.launchPrompt` if set, else the resolved fallback seed as plain text (i.e. `resolveLaunchPrompt({ template: undefined, playbook, ... }).prompt` — the `@assignment`/playbook-derived or bare-grab string). The box prefills this **already-expanded plain text**; the user can re-introduce `@`-tokens via autocomplete.
- **Re-resolve on launch:** the edited box text is sent as `prompt=` and fed back into `resolveLaunchPrompt` as `template` (not `agent.launchPrompt`). `@`-tokens expand; plain text passes through unchanged. Same resolver, same warnings, one path.
- **Per-launch only:** no write-back to config. Editing the box never mutates `config.md`.

## Files
| File | Action | Purpose |
|------|--------|---------|
| `dashboard/src/pages/AgentsSection.tsx` | MODIFY | Surface 1: `launchPrompt` textarea + `FieldKey` + error strip |
| `src/launch/url.ts` | MODIFY | Parse assignment-only `prompt=` into `ParsedOpenUrl` |
| `src/launch/plan.ts` | MODIFY | `promptOverride` → feed as `template` to `resolveLaunchPrompt` |
| `src/commands/url.ts` | MODIFY | Thread `parsed.prompt` into `resolveLaunchPlan` |
| `src/launch/launch-prompt.ts` | MODIFY | Add `effectiveLaunchTemplate(...)` helper for prefill |
| `src/dashboard/api-launch-preflight.ts` | MODIFY | New `GET /prompt` prefill endpoint |
| `dashboard/src/lib/recreate-flow.ts` | MODIFY | `continuationUrl` gains `prompt` arg → `&prompt=` |
| `dashboard/src/lib/launch-prompt-autocomplete.ts` | CREATE | Pure tokenizer/suggestion logic for `@`-autocomplete |
| `dashboard/src/components/useRecreateFlow.tsx` | MODIFY | Thread edited prompt through `Pending` + `open()` |
| `dashboard/src/components/LaunchPromptDialog.tsx` | CREATE | Radix dialog: editable box + autocomplete + warnings |
| `dashboard/src/components/OpenInAgentButton.tsx` | MODIFY | Open dialog before launch; pass edited prompt to `flow.open` |
| `src/__tests__/launch-prompt-autocomplete.test.ts` | CREATE | Root vitest for autocomplete lib |
| `src/__tests__/recreate-flow.test.ts` | MODIFY | Add `prompt=` cases to `continuationUrl` |
| `src/__tests__/launch-url.test.ts` (or existing url test) | MODIFY | `prompt=` parse cases + assignment-only guard |
| `src/__tests__/launch-plan.test.ts` (or existing plan test) | MODIFY | `promptOverride` re-resolves as template |

> NOTE: confirm the exact existing url/plan test filenames before editing (`ls src/__tests__/ | grep -E 'url\|plan'`); create alongside if absent. Phase A already covers the `api-agents.ts` server coerce + error map for `launchPrompt` — **no server-side agent-config change needed** for Surface 1.

## Tasks

### 1. Surface 1 — agent-editor textarea (client-only, independent)
- **File:** `dashboard/src/pages/AgentsSection.tsx` (MODIFY)
- **What:**
  - Add `'launchPrompt'` to the `FieldKey` union (lines 49-59).
  - In `SortableAgentRow`, add a `launchPrompt` field after the Playbook `<div>` (closes ~line 423), inside the `grid ... sm:grid-cols-2` block. Use a `<textarea>` (`rows={2}`, `font-mono`, `col-span-full`); mirror the Model `<input>` block (lines 385-399): label + control with `errorClass('launchPrompt')` + conditional `{row.fieldErrors.launchPrompt && <p className="mt-0.5 text-[11px] text-error-foreground">…</p>}`. Wire `onChange={(e) => onPatch({ launchPrompt: e.target.value })}` (mirror model line 393). Placeholder hints `@assignment` / `@<playbook>` tokens; store untrimmed (matches `buildPayload` line 128).
  - Add `if ('launchPrompt' in patch) delete next.launchPrompt;` to `stripErrorsForPatch` (after line 714).
  - **No change** to `EditableAgent` (78), `hydrate` (108), `buildPayload` (128), `rowsAreEqual` (196) — Phase A pass-through already carries the field. **No server change** — `api-agents.ts:274-286` coerces and `:112-117` maps `field:'launchPrompt'` errors that `attachFieldErrors` (148-173) surfaces.
- **Pattern:** Model `<input>` block at lines 385-399; Playbook `<select>` at 400-423.
- **Verify:** `npm run build --prefix dashboard` (tsc green). Manual: edit a launchPrompt, Save, confirm it round-trips through PUT → `config.md` and shows inline validation errors mirroring `model`.

### 2. Surface 2 backend — URL parse `prompt=`
- **File:** `src/launch/url.ts` (MODIFY)
- **What:** Mirror the `agent=` precedent end-to-end. Add `prompt?: string` to `ParsedOpenUrl` (after `agent`, ~line 54). In `parseOpenUrl`: read `url.searchParams.getAll('prompt')`, reject `length > 1` with `duplicate-param`, decode/keep when non-empty. Include it **only in the assignment branch** return (lines 162-167) — sessions pin their prompt from history, so parse-but-ignore for sessions (same as `agent`). `URL` already percent-decodes `searchParams`, so no manual decode.
- **Pattern:** the `agent=` handling at lines 142-152 + assignment-branch spread at 162-167.
- **Verify:** unit test (Task 11) — `prompt=` decodes, duplicate rejects, session ignores.

### 3. Surface 2 backend — plan `promptOverride`
- **File:** `src/launch/plan.ts` (MODIFY)
- **What:** Add `promptOverride?: string` to `ResolveLaunchPlanInput` (near `agentId`, ~line 81). In `resolveAssignmentPlan`, when `input.promptOverride` is a non-empty string, pass it as `template` to `resolveLaunchPrompt` (line 175) **instead of** `agent.launchPrompt`; otherwise keep `agent.launchPrompt`. Leave `playbook`, `knownPlaybookSlugs`, `id`, `assignmentDir` etc. unchanged — so the override's `@`-tokens re-resolve through the one existing path and `promptWarnings` thread out as today (line 184/194).
- **Pattern:** existing `resolveLaunchPrompt(...)` call at 175-183; `agentId` optional-input precedent at 81 + 162-173.
- **Verify:** unit test (Task 11) — override re-resolves as template; absent override falls back to `agent.launchPrompt`.

### 4. Surface 2 backend — thread `prompt` through the url command
- **File:** `src/commands/url.ts` (MODIFY)
- **What:** In `urlCommand`, pass `promptOverride: parsed.kind === 'assignment' ? parsed.prompt : undefined` into `resolveLaunchPlan` (lines 54-63), mirroring the `agentId` line 62. No other change — `emitPlanWarnings` (96-103) already prints `promptWarnings`.
- **Pattern:** `agentId: parsed.kind === 'assignment' ? parsed.agent : undefined` at line 62.
- **Verify:** `npm run typecheck`; covered indirectly by plan test (Task 11) + manual end-to-end (Task 12).

### 5. Surface 2 backend — effective-template helper
- **File:** `src/launch/launch-prompt.ts` (MODIFY)
- **What:** Add an exported pure helper `effectiveLaunchTemplate(input)` that returns the **plain-text prefill** string for the box: `agent.launchPrompt` (verbatim, if set non-empty), else `resolveLaunchPrompt({ template: undefined, playbook, id, assignmentDir, projectSlug, assignmentSlug }).prompt` (the resolved fallback seed). Keep it a thin wrapper so prefill and launch share one resolver. Do NOT change `resolveLaunchPrompt` itself.
- **Pattern:** the fallback chain already in `resolveLaunchPrompt` (lines 121-136) — the helper just chooses raw-template-vs-resolved-fallback for display.
- **Verify:** small unit assertion in the plan/resolver test (Task 11): with `launchPrompt` set → returns it raw; unset with `playbook` → returns the resolved `Run … end-to-end.` seed; unset/no playbook → bare `/grab-assignment` seed.

### 6. Surface 2 backend — prefill endpoint `GET /prompt`
- **File:** `src/dashboard/api-launch-preflight.ts` (MODIFY)
- **What:** Add `router.get('/prompt', ...)` (mounted at `/api/launch`, see `server.ts:724`), modeled on the existing `GET /command` (lines 175-235). Query: `assignment=<id>` (required; `typeof === 'string'` guard rejecting Express-5 array dupes like `/command` line 177) and `agent=<id>` (optional; default via `pickAgent`). Resolve config + assignment (`resolveAssignmentById` → `{ id, assignmentDir, projectSlug, assignmentSlug }`), resolve the agent (`getAgents(config).find` → 422 `agent-not-configured` if unknown), load `knownPlaybookSlugs` (`listPlaybookSlugs(playbooksDir())`). Return JSON `{ template: effectiveLaunchTemplate(...), resolved: { prompt, warnings } }` where `resolved` = `resolveLaunchPrompt({ template: effectiveTemplate, playbook, ... })` so the box can show a live preview + warnings. Reuse `GET /command`'s `LaunchError` → 4xx allowlist (lines 213-231); 404 for `assignment-not-found`. `LaunchPlan` does NOT expose the resolved prompt string, so call `resolveLaunchPrompt` directly here (do not route through `resolveLaunchPlan`).
- **Pattern:** `GET /command` at lines 175-235 (query guards + LaunchError status map).
- **Verify:** `npm run build` + `npm run typecheck`; manual `curl 'localhost:<port>/api/launch/prompt?assignment=<id>&agent=<id>'` returns the expected template.

### 7. Surface 2 frontend pure lib — `continuationUrl` prompt param
- **File:** `dashboard/src/lib/recreate-flow.ts` (MODIFY)
- **What:** Add an optional `prompt?: string` arg to `continuationUrl` (after `agentId`, line 27). When present **and** `target.kind === 'assignment'`, append `&prompt=${encodeURIComponent(prompt)}` (mirror the `agentId` guard at lines 35-37). Pure → root-vitest testable. Update the doc comment.
- **Pattern:** the `agentId && target.kind === 'assignment'` block at lines 35-37.
- **Verify:** Task 11 (`recreate-flow.test.ts`).

### 8. Surface 2 frontend pure lib — autocomplete tokenizer (CREATE)
- **File:** `dashboard/src/lib/launch-prompt-autocomplete.ts` (CREATE)
- **What:** Pure, React-free (sibling of `recreate-flow.ts`, see its header comment). Export:
  - `detectActiveToken(text, caret)` → `{ start, partial } | null` — find an active `@<partial>` token under the caret (`@` at start-of-string or after whitespace; partial = `[A-Za-z0-9_-]*`), matching the server `TOKEN_RE` grammar (`launch-prompt.ts:85`).
  - `rankSuggestions(partial, slugs)` → ranked `string[]` from `['assignment', ...installedPlaybookSlugs]` (prefix-match first, then substring; case-insensitive).
  - `applySuggestion(text, caret, suggestion)` → `{ text, caret }` inserting `@<suggestion>` and placing the caret after it.
  - `tokenWarnings(text, knownSlugs)` → `string[]` paralleling the server warnings (`launch-prompt.ts:96-103`) for unknown/malformed `@`-tokens, for a live UI hint (advisory only — the server is authoritative).
- **Pattern:** grammar from `src/launch/launch-prompt.ts` (TOKEN_RE line 85, warning text 96-103); pure-lib style from `dashboard/src/lib/recreate-flow.ts`.
- **Verify:** Task 11 (`launch-prompt-autocomplete.test.ts`).

### 9. Surface 2 frontend shell — launch-prompt dialog (CREATE)
- **File:** `dashboard/src/components/LaunchPromptDialog.tsx` (CREATE)
- **What:** Thin Radix `Dialog` (from `components/ui/dialog.tsx`) shell: a `<textarea>` prefilled from `GET /api/launch/prompt?assignment=&agent=`, an `@`-autocomplete popup driven entirely by the Task-8 lib (component owns only DOM/caret + popup render), a live warnings line from `tokenWarnings`, and Confirm/Cancel. On Confirm, calls back with the edited text. Borrow popup positioning + click-outside/Escape/arrow-nav from `OpenInAgentButton.tsx` (lines 71-208) and `ui/MultiSelect.tsx`. Playbook slugs from `usePlaybooks()` (`hooks/useProjects.ts:717`) filtered `.enabled` (as `AgentsSection.tsx:441-447`), passed into the lib as the known-slug set. Keep the shell logic-light so all testable behavior lives in the Task-8 lib.
- **Pattern:** `ui/dialog.tsx` exports; popup a11y in `OpenInAgentButton.tsx:71-208` + `ui/MultiSelect.tsx`; playbook filtering at `AgentsSection.tsx:441-447`.
- **Verify:** `npm run build --prefix dashboard` (typecheck). Behavior covered by Task 8 lib tests + manual (Task 12).

### 10. Surface 2 frontend shell — wire dialog into the launch flow
- **File:** `dashboard/src/components/useRecreateFlow.tsx` + `dashboard/src/components/OpenInAgentButton.tsx` (MODIFY)
- **What:**
  - `useRecreateFlow.tsx`: add `prompt?: string` to the `Pending` interface (lines 51-56) and as a 4th arg to `open()` (lines 78-82). Thread it through **every** `continuationUrl(...)` call (94, 99, 117, 125 via `missPending`, 152 via `recreatePending`) as the new 5th arg — so an edited prompt survives the missing-terminal and recreate detours.
  - `OpenInAgentButton.tsx`: in `launch(agentId)` (line 91), first open `LaunchPromptDialog` (prefilled via the endpoint for `target` + `agentId`); on the dialog's Confirm, call `flow.open(target, undefined, agentId, editedPrompt)`. Render the dialog alongside `flow.dialogs` (line 210). Assignment-only — sessions keep the direct `flow.open` (no prompt box).
- **Pattern:** existing `agentId` threading through `open`/`Pending`/`continuationUrl` (the exact lines above); dialog render next to `{flow.dialogs}`.
- **Verify:** `npm run build --prefix dashboard`; manual (Task 12).

### 11. Tests — pure libs via root vitest
- **Files:** `src/__tests__/launch-prompt-autocomplete.test.ts` (CREATE), `src/__tests__/recreate-flow.test.ts` (MODIFY), url + plan tests (MODIFY/CREATE).
- **What:**
  - Autocomplete: `detectActiveToken` (caret in/out of a token, `@` at boundaries), `rankSuggestions` (prefix-before-substring, `assignment` present), `applySuggestion` (text + caret), `tokenWarnings` (unknown slug warns, `@assignment` does not). Import from `../../dashboard/src/lib/launch-prompt-autocomplete` (the established cross-import pattern, `recreate-flow.test.ts:2-6`).
  - `recreate-flow.test.ts`: add `prompt=` cases — appended for assignment, encoded, **omitted** for sessions; coexists with `agent=`/`terminal=`.
  - url test: `prompt=` decodes into `ParsedOpenUrl`, duplicate `prompt` → `duplicate-param`, session URL ignores `prompt`.
  - plan test: `promptOverride` is used as `template` (its `@`-tokens re-resolve); absent override falls back to `agent.launchPrompt`; `effectiveLaunchTemplate` returns raw template / resolved fallback as specified.
- **Pattern:** `src/__tests__/recreate-flow.test.ts` (vitest, cross-imports dashboard lib).
- **Verify:** `npm test`.

### 12. Final verification + AC cross-walk
- **What:** Run the full gate and confirm each acceptance criterion. See Verification below.
- **Verify:** all four commands green + the AC table.

## Dependencies
- No new packages. Radix `Dialog` already present (`@radix-ui/react-dialog`, used by `ui/dialog.tsx`). `usePlaybooks` / `GET /api/playbooks` already exist.
- Stacked on `editable-launchprompt` (Phase A). Rebase onto `main` once Phase A merges (per assignment context); does not affect task content.
- No env vars, no GCP secrets.

## Verification
Run all four (the AC#5 "dashboard build stays green" gate is the `tsc -b && vite build` step):
- `npm run build` (root)
- `npm run typecheck` (root)
- `npm run build --prefix dashboard`  (`tsc -b && vite build`)
- `npm test` (root vitest — autocomplete + recreate-flow + url + plan suites)

Acceptance-criteria cross-walk:
| AC | Covered by |
|----|------------|
| 1. Agent-editor `launchPrompt` field + `FieldKey` + inline errors, round-trips via PUT/`config.md` | Task 1 (Phase A server coerce already in place) |
| 2. Editable prompt box prefilled from resolved `launchPrompt`/fallback | Tasks 5, 6, 9 (`effectiveLaunchTemplate` + `GET /prompt` + dialog) |
| 3. `@`-autocomplete (`@assignment` + playbook slugs); unknown tokens warn in UI | Tasks 8, 9 (`tokenWarnings` parallels server `resolveLaunchPrompt` warnings) |
| 4. Launched first message reflects the **edited** box value | Tasks 2, 3, 4, 7, 10 (`prompt=` → `promptOverride` → re-resolve as `template`) |
| 5. Tests cover new components + edited-prompt path; dashboard build green | Task 11 (pure libs, root vitest) + dashboard `tsc -b && vite build` typechecks the React shells |

## Documented limitation (AC#5 testing approach)
The dashboard has **no component test harness today** (no vitest/@testing-library under `dashboard/`; root vitest only includes `src/__tests__/**`). Per established convention, all testable logic is **extracted into pure `dashboard/src/lib/*.ts` modules** (`launch-prompt-autocomplete.ts`, the `continuationUrl` change) and tested by **root vitest** via the existing cross-import pattern (`src/__tests__/recreate-flow.test.ts`). The React shells (`LaunchPromptDialog.tsx`, `OpenInAgentButton.tsx`/`useRecreateFlow.tsx` wiring) are **type-checked by the dashboard build** (`tsc -b && vite build`), not unit-tested. This satisfies AC#5's "tests cover the new dashboard components" in spirit (their logic is covered) while keeping the shells thin; a net-new dashboard test runner is explicitly **out of scope** for this assignment.
