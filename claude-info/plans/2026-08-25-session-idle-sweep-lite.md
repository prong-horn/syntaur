# Session Idle Sweep (transcript-idle rule for `syntaur session scan`)

**Date:** 2026-08-25
**Complexity:** medium
**Tech Stack:** TypeScript ESM, Node ≥20, Commander 13, better-sqlite3, vitest 3, tsup. No lint script; validation is `npm run build && npm run typecheck && npm test` (README:421 — build must precede test because several suites spawn `bin/syntaur.js`).

## Objective

Dead `active` session rows stay pinned forever because the scanner's Agent-View keep-alive is unconditional and time-unbounded. Time-bound that keep-alive to a configurable idle threshold (default 6h) on **both** the sweep and the revive side, so an `active` row with no live pid whose transcript has gone idle is swept to `stopped` with `ended` backdated to the transcript mtime and its open engagement closed `idle-sweep`.

## The ticket's premise is wrong — build against this instead

The assignment claims the sweep "keys on pid evidence that scan-inserted rows do not have." That is false. `src/sessions/scanner.ts:375-381` already makes a `pid: null` row with a `transcript_path` a sweep candidate, and `:393` already sweeps it once the transcript is staler than `FRESH_MTIME_MS` (5 min). Two real blockers:

**Blocker 1 — the sweep guard.** `scanner.ts:369`: `if (liveActivity.has(row.session_id)) continue;` — an unconditional, time-unbounded keep-alive for any session `claude agents --json` still lists. All 16 stuck rows on this machine appear in that output, including transcripts untouched for 15 days.

**Blocker 2 — the revive rule (the more dangerous half).** `scanner.ts:274` computes `agentViewLive`, `:275-276` folds it into `isLive`, `:313` passes `{ reviveStopped: heldOpen || agentViewLive }`, and `:333-334` is the revived-counter. Fixing only the sweep means every row you sweep is **revived to `active` by the very next scan** — a sweep/revive flap that writes to the DB and fires a dashboard broadcast every cycle. `scanSessions` runs from the dashboard autodiscovery interval (`src/dashboard/autodiscovery.ts:365`) and a LaunchAgent, so it would flap continuously. **The revive fix is a first-class task, not a footnote.**

**Design:** one shared helper, time-bounding Agent-View presence in both directions, so the two sides can never disagree. This preserves the Decision 5 contract at `scanner.ts:272-273` ("presence is an ADDITIONAL keep-alive; absence is NOT death evidence") — presence is time-bounded, not deleted.

Note that `agentViewLive` is confined to the discovery block; the sweep calls `liveActivity.has(...)` directly at `:369`. That divergence is exactly why the two sides drifted, and why Task 3's shared helper must be used at both.

**Expected live effect:** 16 `active` rows → 10. Four of the six swept have genuinely alive `claude` processes idling in never-closed terminal tabs, but their DB `pid` is null so AC2 as written is satisfied; the design is self-healing, since typing in such a tab freshens the transcript, un-bounds the keep-alive, and the next scan revives the row.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **AC4 amendment: the config key is `session.idleSweepHours`**, not `sessions.idleSweepHours` as the assignment text says. | `src/utils/config.ts:288-292` already owns a singular `session:` block (`autoTrack`, `summarizeBackend`, `autoSummarize`). A `sessions:` block would be a second, parallel namespace. |
| D2 | `close_reason` is **per-rule**, not blanket. The rule is mechanical, decided per candidate at the point it is pushed, and is stated identically in Task 4: `liveActivity.has(row.session_id)` is true **and** the Task 3 helper returned false (its activity stamp is older than `idleSweepMs`) → `idle-sweep`; the candidate is `noTranscript` → `idle-sweep`; **otherwise → `liveness_gc`**. Do not phrase this as "survived only because it was Agent-View-listed" — that is not computable at the call site. | AC3 read literally ("any swept session") would break `session-scan.test.ts:527` and `:556`, which assert `liveness_gc` for the classic dead-pid sweep. Verified `gc-dead` there is not Agent-View-listed, so it stays `liveness_gc` under this rule. |
| D3 | `swept_no_transcript` is a **subset** counter — those rows also increment `swept`. | Keeps `swept` the honest total for existing tests and dashboard consumers. Documented in the field's JSDoc. |
| D4 | Keep the snake_case field name `swept_no_transcript` despite `ScanSummary`'s camelCase neighbours. | The summary object is spread verbatim into the `--json` document (`src/commands/session.ts:693`), and the AC names this exact JSON key. Fidelity beats local style here. |
| D5 | For a no-transcript sweep, leave `endedAt` undefined so `livenessStopSession` defaults to `now` (`agent-sessions.ts:811`). | There is no honest backdate available; `started` would claim the session ended at birth. **Wrinkle to expect in tests:** with `endedAt` undefined the sessions row takes SQLite's `COALESCE(?, datetime('now'))` at `:826-828`, so `ended` is `YYYY-MM-DD HH:MM:SS`, not the ISO string an mtime-backdated sweep produces. Assert on presence, not format, for AC5 rows. |
| D6 | **Validate the config value, not the key.** Reject non-finite / non-positive `idleSweepHours` and fall back to the default. Do not add an unknown-key validator. | No precedent for key allowlisting outside `STALENESS_KEY_TO_FIELD` (scoped to `staleness:` only), and it would be a repo-wide behavioural change. The typo risk is mitigated instead by emitting the key in `renderConfig` (Task 1) so the scaffolded config shows the correct spelling. |
| D7 | **No schema migration.** | Every column needed already exists (`sessions` DDL `src/dashboard/session-db.ts:40-61`, `SCHEMA_VERSION = '10'` at `:13`; `status` has no CHECK), and `engagement.close_reason` is free-form TEXT with no CHECK (`src/db/engagement-schema.ts:32`), with `CloseByIdInput.closeReason: string` (`src/db/engagement-db.ts:174`). A new column would force a v11 **full table rebuild** (`session-db.ts:370` and `:493`: "never ALTER TABLE ADD COLUMN") plus a `session-db-migration-v11.test.ts`, since `session-db-migration-v10.test.ts` asserts `PRAGMA table_info` order with `toEqual`. |
| D8 | Do **not** add an `archived_at IS NULL` filter to the sweep query. | The D3 comment at `src/dashboard/agent-sessions.ts:76-104` names `sessions/scanner.ts` explicitly (at `:99`) as raw SQL that must keep resolving archived rows. |
| D9 | **The idle threshold bounds the Agent-View keep-alive and the no-transcript rule ONLY. The existing 5-minute `FRESH_MTIME_MS` floor is unchanged for every other row.** AC2 is therefore scoped to the new rule, not read as a global floor. | AC2 read literally ("a transcript modified within the threshold is left `active`") would forbid the *existing* 5-minute sweep of a dead-pid, non-Agent-View row — and would break every existing test that asserts a 1h-stale (`makeStale`) row IS swept — by `it(` line: `session-scan.test.ts:377` (dead pid, `ended` backdated to mtime), `:408` (recycled pid), `:505` (engagement closed `liveness_gc`, asserted at `:527`), `:534` (exactly one `liveness_gc` interval, asserted at `:556`), `:559` (dead session, no engagement), and `:625` (Agent-View probe throws, sweep still fires). **Note `:394` and `:431` are NOT in this set** — both are negative tests asserting a row stays `active`, so a higher floor would not break them; an earlier draft cited them in error. Raising the floor to 6h for all rows is a silent regression of the shipped liveness GC and is explicitly NOT what this ticket asks for. A row with dead-or-absent pid evidence and no Agent-View listing keeps sweeping at 5 minutes exactly as today. |

**Self-protection:** the session executing the scan must never sweep itself. It is protected twice over today — a live DB `pid` and a transcript being written continuously — but this is stated explicitly and covered by a test (Task 6).

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/utils/config.ts` | MODIFY | Add `session.idleSweepHours` (type, default 6, parse + value validation) |
| `src/templates/config.ts` | MODIFY | Emit a `session:` block with the key so the spelling is discoverable |
| `src/dashboard/agent-sessions.ts` | MODIFY | Optional `closeReason` on `LivenessStopInput`, defaulting to `liveness_gc` |
| `src/sessions/scanner.ts` | MODIFY | Shared time-bounded keep-alive helper; wire sweep + revive; `swept_no_transcript`; no-transcript rule |
| `src/commands/session.ts` | MODIFY | Surface `swept_no_transcript` in the human summary line |
| `src/__tests__/session-scan.test.ts` | MODIFY | AC6 tests + sweep/revive symmetry + self-protection |
| `tsconfig.tests.json` | MODIFY | Widen `files` to cover the touched test files |
| `platforms/SESSION-ID-RESOLUTION.md` | MODIFY | Update the sweep-semantics prose and config key list |

## Tasks

### 1. Add the `session.idleSweepHours` config key
- **File:** `src/utils/config.ts` (MODIFY), `src/templates/config.ts` (MODIFY)
- **What:**
  - Type: add `idleSweepHours: number` to the `session` block at `:288-292`.
  - Default: add `idleSweepHours: 6` to `DEFAULT_CONFIG.session` at `:333-337`.
  - Parse: in the `session:` parse block at `:2717-2733`, read `fm['session.idleSweepHours']`. The existing three siblings are enum-valued (`*_VALUES.includes(...)` ternaries) so there is **no numeric precedent in this block** — validate per D6: coerce with `Number(...)`, and fall back to `DEFAULT_CONFIG.session.idleSweepHours` unless `Number.isFinite(n) && n > 0`. That guard mirrors `parseDurationMs` at `:105-106`.
  - `parseFrontmatter` (`:630-655`) already flattens exactly two levels into dotted keys (any `indent > 0` becomes `parent.key`), so `session.idleSweepHours` needs **zero parser change**. Verified there is no allowlist, no `KNOWN_KEYS`, and no writer for the `session:` block anywhere in `config.ts`.
  - `cloneDefaultConfig` at `src/utils/config.ts:587-593` does `session: { ...DEFAULT_CONFIG.session }` — a spread, so it picks the new field up automatically. **No edit needed there**; confirm rather than change.
  - `src/templates/config.ts` `renderConfig` (`:5-25`) currently emits **no `session:` block at all** — add one containing only `idleSweepHours: 6` (D6 mitigation). Do not scaffold the other three keys. **Place it after `agentDefaults:` and before `backup:`**, matching `SyntaurConfig` field order and keeping `backup:` the last block — `src/__tests__/terminal-config.test.ts:27` injects a top-level `terminal:` line by replacing the first `\n---\n`, so the closing delimiter must stay where it is.
- **Pattern:** the `session.autoTrack` ternary-against-`DEFAULT_CONFIG` shape at `src/utils/config.ts:2718-2722`.
- **Regression watch:** `src/__tests__/terminal-config.test.ts:109` asserts `renderConfig` does not emit `terminal:` — a `session:` block does not trip that regex, but run the suite to confirm.
- **Verify:** `npm run typecheck` passes and `npx vitest run src/__tests__/terminal-config.test.ts` is green.

### 2. Make the liveness stop's close reason overridable
- **File:** `src/dashboard/agent-sessions.ts` (MODIFY)
- **What:** Add an **optional** `closeReason?: string` to `LivenessStopInput` (`:779-788`) documented as "defaults to `liveness_gc`". In `livenessStopSession` (`:809-832`), replace the hardcoded `closeReason: 'liveness_gc'` at `:818` with `input.closeReason ?? 'liveness_gc'`. Change nothing else — the compare-and-close semantics, the local `endedAt` default at `:811`, the `stillDead` guard at `:813-823`, and the `COALESCE` on the sessions update at `:826-828` all stay as-is. `:818` is the only place in production that emits this string.
- **Pattern:** the other optional fields on the same interface (`engagementId`, `endedAt`, `tokensAtClose`).
- **Verify:** `npx vitest run src/__tests__/liveness-stop-session.test.ts` — the existing `close_reason === 'liveness_gc'` assertions at `:96`, `:124`, `:155` must still pass untouched, proving the default holds.

### 3. Add the shared time-bounded Agent-View keep-alive helper
- **File:** `src/sessions/scanner.ts` (MODIFY)
- **What:**
  - Add `idleSweepHours?: number` to `ScannerDeps` (`:46-64`), JSDoc'd as "Override the configured `session.idleSweepHours` (skips readConfig)" — mirroring the existing `autoTrack?: SessionAutoTrack` override.
  - `scanSessions` (`:211-214`) currently does `deps.autoTrack ?? (await readConfig()).session.autoTrack` at `:217`. Memoize the config read (a lazy `let cfg` + accessor) so both settings share **one** `readConfig()` call, and resolve `idleSweepMs = (deps.idleSweepHours ?? cfg.session.idleSweepHours) * 3_600_000` **after** the `autoTrack === 'off'` early return at `:218`. Autodiscovery calls `scanSessions({})` with no deps every tick (`autodiscovery.ts:365`), so memoizing keeps the per-tick config reads at exactly one, as today.
    - **Resolve `idleSweepMs` after the `autoTrack === 'off'` early return at `:218`.** The load-bearing case is an injected `deps.autoTrack: 'off'` caller — `src/__tests__/session-scan.test.ts:353` passes `deps({ autoTrack: 'off' })` precisely so no config is consulted; resolving the threshold before the return would force a `readConfig()` the dep override exists to avoid. (`src/__tests__/summarize-trigger.test.ts:39-45` is NOT evidence for this: it sets `SYNTAUR_HOME` to a sandbox and writes `session.autoTrack: off` there, so it *wants* the config read and is hermetic via `SYNTAUR_HOME`, not by skipping it.) Verified: `session-scan.test.ts` and `summarize-trigger.test.ts` are the only two test files that call `scanSessions`; production callers are `src/commands/session.ts:682` and `src/dashboard/autodiscovery.ts:365`.
  - Add one module-level helper next to `FRESH_MTIME_MS` (`:42`), used by both call sites:
    - inputs: whether the session is Agent-View-listed, a nullable "last activity" epoch-ms, `nowMs`, `idleMs`;
    - returns `true` only when listed **and** the stamp is non-null **and** `nowMs - stamp < idleMs`.
  - Its doc comment must restate the Decision 5 contract from `:271-273`: presence is an additional keep-alive that is now time-bounded; absence is still not death evidence.
- **Pattern:** `FRESH_MTIME_MS` and the existing `default*` module-level helpers at `:85-115`.
- **Trap:** the existing lazy `deps.autoTrack ?? await readConfig()` short-circuits, so unit tests never touch `~/.syntaur/config.md`. Once `idleSweepHours` is read the same way, any test that omits the dep **will read the developer's real config**. Task 6 adds `idleSweepHours` to the `deps()` helper to restore hermeticity — do both or neither.
- **Verify:** `npm run typecheck`.

### 4. Wire the helper into the sweep, and add the no-transcript rule
- **File:** `src/sessions/scanner.ts` (MODIFY)
- **What:** in the sweep block (`:353-423`):
  - Add `started` to the `SELECT` list at `:357` and to the row type at `:358-363`.
  - Replace the unconditional guard at `:369` with the Task 3 helper. Compute the row's last-activity stamp once: transcript mtime via `statMtimeMs` when `transcript_path` is set, else `Date.parse(row.started)` (treat `NaN` as null). **Carry that mtime on the candidate** (widen the `sweepCandidates` element type at `:365`) so the second loop's `statMtimeMs` call at `:394` is dropped rather than duplicated.
  - Leave the pid-liveness check at `:370-375` exactly as-is — a live pid still wins outright (AC2).
  - Extend the candidacy branches at `:376-382`. Today the `else` branch comments "No pid AND no transcript → no signal either way; leave the row alone." (`:382`). Replace it: when `transcript_path` is null **and** `pid` is null **and** `started` parses to a **finite** epoch-ms **and** `now() - parsed >= idleSweepMs`, push a candidate flagged `noTranscript` (AC5). **An unparseable or missing `started` must NOT sweep** — `Number.isFinite(Date.parse(row.started))` gates the branch, and a row that fails it is left `active` exactly as today. Sweeping on a `NaN` comparison would silently stop every row with a malformed timestamp.
  - Tag each candidate with a `closeReason` at the point it is pushed, using the exact D2 branch — do not re-derive it later, and do not phrase it as "survived only because": `liveActivity.has(row.session_id)` is true **and** the Task 3 helper returned false (its activity stamp is older than `idleSweepMs`) → `idle-sweep`; the candidate is `noTranscript` → `idle-sweep`; **otherwise → `liveness_gc`**. Pass it through the `livenessStopSession` call at `:412-418` (Task 2).
  - Add `swept_no_transcript: number` to `ScanSummary` (`:66-79`) and `emptySummary()` (`:82`), JSDoc'd as a subset of `swept` (D3). Increment it alongside `summary.swept += 1` at `:420` only for `noTranscript` candidates.
  - Update the stale block comment at `:353-355`, which currently states the close reason is always `liveness_gc`.
  - Keep `FRESH_MTIME_MS` in force for transcript-bearing candidates — the idle threshold is the Agent-View bound, not a replacement for the 5-minute freshness check.
- **Verify:** `npx vitest run src/__tests__/session-scan.test.ts` — the pre-existing `liveness_gc` assertions at `:527` and `:556` must still pass (proving D2), as must `:577-599` (Agent-View live + dead pid + **1h**-stale transcript → `swept === 0`, still under a 6h threshold).

### 5. Wire the helper into the revive path (the flap fix)
- **File:** `src/sessions/scanner.ts` (MODIFY)
- **What:** in the discovery/upsert block (`:263-338`), replace the bare `const agentViewLive = liveActivity.has(d.sessionId);` at `:274` with the **same** Task 3 helper, passing the already-computed `mtime` from `:270` as the last-activity stamp. This automatically corrects all three downstream consumers, which must keep referencing the single variable:
  - the `isLive` expression at `:275-276`,
  - the `{ reviveStopped: heldOpen || agentViewLive }` argument at `:313`,
  - the revived-counter condition at `:333-334`.
  Do not duplicate the threshold logic at any of the three; the point of the shared helper is that sweep and revive can never disagree. Also refresh the now-inaccurate comments at `:272-273`, `:307-312`, and `:330-332`, which all describe the keep-alive as unbounded.
- **Pattern:** `heldOpen` at `:271` — same shape, a single boolean computed once and reused.
- **Verify:** `npx vitest run src/__tests__/session-scan.test.ts` — in particular the test at `:308-320` (a fresh stopped row is not revived; `revived === 0` asserted at `:318`) and "never revives a completed row" at `:343`.

### 6. Tests
- **File:** `src/__tests__/session-scan.test.ts` (MODIFY)
- **What:**
  - Add `idleSweepHours: 6` to the hermetic `deps()` helper at `:50-60` (see the Task 3 trap — without this the suite reads the developer's real `~/.syntaur/config.md`).
  - Add a `makeOld(path, hours)` helper beside `makeStale` at `:114-118`, backdating via `utimes` by N hours (`makeStale` is hardcoded to exactly 1 hour). Prefer this over overriding `ScannerDeps.now` — `now` exists at `:53` but is never overridden in this suite, and backdating the file matches the established fixture style.
  - **AC6 matrix** (three tests): null pid + transcript older than the threshold → `stopped`; null pid + fresh mtime → `active`; live pid + old mtime → `active`. The third already exists at `:322-341` — assert the other two as new tests rather than duplicating it.
  - **The mandatory proof the fix works:** a companion to `:577-599` — Agent-View reports the session live, pid is dead, transcript is **older than 6h** → `swept === 1`, row `stopped`, `ended` equals the transcript mtime ISO string. Without this test nothing distinguishes the fix from the status quo.
  - **Sweep/revive symmetry (the flap test):** after that sweep, re-run `scanSessions` with the *same* Agent-View map and assert the row is still `stopped` and `summary.revived === 0`. This is the only guard against the Blocker 2 flap.
  - **Idempotency / concurrency:** run the scan twice against the *same* already-swept stale candidate and assert `swept === 1` on the first and `swept === 0` on the second, with exactly one engagement close row. This is the unit-level stand-in for the LaunchAgent, the dashboard interval, and a manual scan overlapping: `livenessStopSession`'s compare-and-close plus its `WHERE status = 'active'` guard (`agent-sessions.ts:826`) mean duplicate candidate work is harmless, but only a test proves the second pass does not re-close.
  - **AC3:** the idle-swept session's open engagement closes with `close_reason === 'idle-sweep'` (open one via `openEngagement`, as at `:514-520`).
  - **AC5:** a row with `transcript_path: null`, `pid: null`, and `started` older than the threshold → swept, `summary.swept_no_transcript === 1` and `summary.swept === 1` (D3). Add the negative case: the same row with a recent `started` stays `active`.
  - **Self-protection:** a row with a live pid *and* a fresh transcript, present in the Agent-View map, is never swept — the scan-running session's shape.
  - **Config plumbing:** one test passing `idleSweepHours: 1` via `deps()` and a 2h-old transcript, proving the threshold is honoured rather than hardcoded.
- **Do NOT rewrite `:322-341`.** It looks like it contradicts this feature (a 1h-stale transcript staying `active`), but it does not: `claude-idle` is absent from the Agent-View map, so the Task 3 helper returns false and the row falls straight through to the untouched pid check at `:370-375`, where the live matching pid wins. The test passes unchanged and is exactly AC6's third case. Leave it alone.
- **Pattern:** the `describe('scanSessions — Agent-View liveness + activity (#5)')` block at `:576`; `makeSession` + `appendSession` + `scanSessions({ full: true }, deps({...}))`; `latestEngagement` (`:22-26`) for engagement assertions.
- **Verify:** `npx vitest run src/__tests__/session-scan.test.ts` — all 30 pre-existing tests across the 4 describe blocks, plus the new ones, green.

### 7. Surface the new counter in both summary outputs
- **File:** `src/commands/session.ts` (MODIFY)
- **What:** the `--json` document at `:693` is `JSON.stringify({ ...summary, summarization })`, so `swept_no_transcript` appears there **automatically** once it is on `ScanSummary` — no edit needed, but confirm it. The human line is a hand-written template literal at `:696` and **does** need the new count appended (`..., swept N (M without transcript), skipped ...` or similar). The `scan` command (`:670-709`) keeps its existing three options — `--full`, `--json`, `--no-summarize`. Do not add a CLI flag; the threshold is config-only per AC4.
- **Verify:** after `npm run build`, `node bin/syntaur.js session scan --json --no-summarize | python3 -m json.tool` shows a `swept_no_transcript` key, and the same command without `--json` prints the count. (Run this only after the Task 9 backup.)

### 8. Update the docs
- **File:** `platforms/SESSION-ID-RESOLUTION.md` (MODIFY)
- **What:** lines 27-45 (under the `## Session TRACKING vs id resolution` header at `:21`) are the only prose describing scanner sweep semantics. Amend the "sweeps stale `active` rows to `stopped` (`ended` backdated to last mtime)" clause at `:32-33` to name the transcript-idle rule and the time-bounded Agent-View keep-alive, and add `session.idleSweepHours` (default 6) beside the existing `session.autoTrack` line at `:44-45`.
- **Pre-existing drift, do not fix here:** `:30-31` claims the scanner "links project/assignment from `<cwd>/.syntaur/context.json`", which `scanner.ts:292-296` contradicts (discovered sessions insert UNATTRIBUTED; context.json is read only for the workspaces-only gate), and `:29` says "claude + codex today" although `pi` is now covered. Both predate this change — note them as follow-ups in the handoff rather than expanding scope.
- **Verify:** `grep -n "idleSweepHours" platforms/SESSION-ID-RESOLUTION.md` returns a hit.

### 9. AC7 live verification — **MUTATES THE REAL DB**
- **File:** none (verification only)
- **What:** this step writes to the user's real `~/.syntaur/syntaur.db`. **Back it up first**, and confirm no dashboard/LaunchAgent scan loop is racing (step 0 below gives the exact checks).
  0. **Confirm no concurrent scanner is running**, so the count is attributable to this run:
     - `launchctl list | grep com.syntaur.session.scan` — expect no output. If present: `launchctl bootout gui/$(id -u)/com.syntaur.session.scan`, and re-install afterwards.
     - `[ -f ~/.syntaur/dashboard-port ] && lsof -ti :"$(cat ~/.syntaur/dashboard-port)" || echo 'no dashboard port file'` — expect no pid. A missing port file means the dashboard has never run and counts as not running. If a pid prints, the autodiscovery interval (`autodiscovery.ts:365`) is scanning; stop it before proceeding.
     - *Verified at plan time: neither is running on this machine — the LaunchAgent is not installed and nothing is listening on port 4800.*
  1. `cp ~/.syntaur/syntaur.db ~/.syntaur/syntaur.db.pre-idle-sweep.bak`
  2. `sqlite3 ~/.syntaur/syntaur.db "select count(*) from sessions where status='active'"` — baseline, **verified as 16 at plan time**.
  3. `npm run build`
  4. `node bin/syntaur.js session scan --full --json --no-summarize`
  5. `sqlite3 ~/.syntaur/syntaur.db "select count(*) from sessions where status='active'"` — **expect 10**.
  6. `sqlite3 ~/.syntaur/syntaur.db "select close_reason, count(*) from engagement where ended_at is not null group by 1"` — expect `idle-sweep` rows to appear.
  7. **Run step 4 a second time** and re-check the count: it must still be 10 and the summary's `revived` must be 0. This is the live proof that Blocker 2 is fixed.
  - If the count is wrong, restore from the backup before iterating.
- **Verify:** the two counts and the second-run `revived: 0` above.

### 10. Widen the test typecheck probe
- **File:** `tsconfig.tests.json` (MODIFY)
- **What:** the base `tsconfig.json` excludes `src/__tests__`, so `npm run typecheck` never sees test files and vitest strips types unchecked. `tsconfig.tests.json` is the type-aware probe and is **not wired to any npm script**. Neither `src/__tests__/session-scan.test.ts` nor `src/__tests__/liveness-stop-session.test.ts` is currently in its `files` array; its header says "Widen `files` when a change touches other test files." Add both.
- **Caveat:** the same header warns the rest of the test tree carries pre-existing type errors. If adding these two surfaces errors that are **not** from this change, revert the addition and note it in the handoff rather than expanding scope.
- **Verify:** `npx tsc -p tsconfig.tests.json --noEmit` exits clean.

### 11. Full validation
- **File:** none
- **What:** run the repo's documented sequence, in order. Build must precede test because several suites spawn `bin/syntaur.js`.
- **Verify:** `npm run build && npm run typecheck && npm test`

## Dependencies

- No new packages, no env vars, **no DB migration** (D7).
- Task 3 depends on Task 1 (config key must exist). Task 4 depends on Tasks 2 and 3. Task 5 depends on Task 3. Task 6 depends on Tasks 4 and 5. **Task 7 depends on Task 4** (it surfaces `ScanSummary.swept_no_transcript`, which Task 4 creates). Task 9 depends on Tasks 1-8.
- Task 9 mutates `~/.syntaur/syntaur.db` and requires the backup in its own step 1.

## Verification

```
npm run build && npm run typecheck && npm test
npx tsc -p tsconfig.tests.json --noEmit
```

Plus the Task 9 live check (16 → 10 `active` rows, second scan leaves it at 10 with `revived: 0`).

**Must-not-break regression set** — all pre-existing, all must stay green, none should be edited:
- `src/__tests__/session-scan.test.ts:322-341` — live pid + 1h-stale transcript stays `active` (see the Task 6 "do NOT rewrite" note).
- `src/__tests__/session-scan.test.ts:527` and `:556` — classic dead-pid sweep still closes `liveness_gc` (proves D2; `gc-dead` is not Agent-View-listed, so it stays on the `liveness_gc` branch).
- `src/__tests__/session-scan.test.ts:577-599` — Agent-View live + dead pid + **1h** transcript → `swept === 0` (passes because 1h < the 6h default).
- `src/__tests__/session-scan.test.ts:394`, `:431`, `:448`, `:485` — the other sweep/watermark tests (`:394`/`:431`/`:448` are negative, asserting a row stays `active`).
- **The D9-protected set** — `src/__tests__/session-scan.test.ts:377`, `:408`, `:505`, `:534`, `:559`, `:625`. Every one sweeps a 1h-stale transcript and stays correct only because the 5-minute floor is untouched for non-Agent-View rows. If any of these turn red, the threshold has leaked into a global floor.
- **`src/__tests__/session-scan.test.ts:205` — the most important tripwire, and the one guarding a different code path.** It is a *discovery* test, not a sweep test: it asserts a 1h-stale transcript is INSERTED as `stopped`, which depends on the `isLive` freshness check at `scanner.ts:276` — the other consumer of the same `FRESH_MTIME_MS` constant. The likeliest wrong implementation of this ticket is to widen `FRESH_MTIME_MS` from 5 minutes to 6 hours instead of adding a separate bound; that single edit makes a 1h-stale transcript "live", inserts the row as `active`, and turns this test red. **To be precise about what it uniquely covers:** that global-widening mistake would ALSO turn the six sweep tests above red, because the sweep loop reads the same constant at `scanner.ts:394-395` — so `:205` is *not* the only test that catches it. What `:205` alone covers is the **discovery-side** consumer at `scanner.ts:275-276`; the six above cover the sweep-side consumer. Listing both means a change to either consumer is caught by a test that names it. (The Codex plan review initially classified `:205` as out of scope because it is not an active-row sweep assertion — literally true, and precisely why it is listed separately here rather than folded into the set above.)
- `src/__tests__/liveness-stop-session.test.ts:96,124,155` — `close_reason` still defaults to `liveness_gc`; `:185` still yields `switch`.
- `src/__tests__/terminal-config.test.ts` — `renderConfig` template shape (Task 1).

## Out of scope

- `src/dashboard/session-liveness.ts` and `src/schedules/liveness.ts` are not on the scan path and write no status — do not modify.
- `--full` affects discovery only (`scanner.ts:228-248`); the sweep always reads every `active` row, so the new rule intentionally fires on incremental scans and the LaunchAgent too. No `--full` change.
- No unknown-config-key validator (D6). No new CLI flag for the threshold.
