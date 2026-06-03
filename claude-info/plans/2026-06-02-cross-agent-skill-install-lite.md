---
title: Cross-agent skill installability — Phase 1 (Tier 1 + Tier 2)
assignment: make-syntaur-skills-installable-in-any-agent-agent-skills-spec-skillssh-interop
date: 2026-06-02
status: in_progress
---

# Cross-agent skill installability — Phase 1

**Date:** 2026-06-02
**Complexity:** medium
**Tech Stack:** TypeScript (ESM), Commander 13 CLI, tsup, vitest, @inquirer/prompts + ink/React TUI, Node ≥20.

## Objective
Make Syntaur skills installable in any Agent Skills-spec agent. Phase 1 delivers **Tier 1** (wrap `npx skills add` for skills.sh distribution, with an offline copy fallback) and **Tier 2** (a declarative per-agent target-descriptor registry under `src/targets/` with descriptors for pi, hermes, openclaw, cursor, opencode + claude/codex as `nativePlugin` entries). The Claude Code / Codex full-plugin (Tier-3) path stays provably unchanged.

Source of truth: `claude-info/plans/2026-06-02-cross-agent-skill-installability-design.md` (approved memo).

## Out of scope (explicit)
- **Phase 2:** `.well-known/agent-skills/index.json` generator + hosting; `syntaur doctor` cross-agent verification. (Exception: a *static* `.well-known` index may be hand-added in Task 9 only if the discovery check fails.)
- **Phase 3:** user-authored descriptors ("C" evolution); Tier-3 deep enforcement plugins (pi/openclaw TS, hermes Python).

## Files
| File | Action | Purpose |
|------|--------|---------|
| `src/targets/types.ts` | CREATE | `AgentTarget`, `ProtocolContext` interfaces (memo lines 104-115) |
| `src/targets/registry.ts` | CREATE | Declarative descriptors: pi, hermes, openclaw, cursor, opencode (instructions) + claude/codex (`nativePlugin`) |
| `src/templates/hermes-soul.ts` | CREATE | New `SOUL.md` renderer for Hermes (the one new renderer) |
| `src/templates/index.ts` | MODIFY | Barrel-export the new Hermes renderer |
| `src/commands/setup-adapter.ts` | MODIFY | Drive paths/renderers off the registry instead of the `SUPPORTED_FRAMEWORKS` switch |
| `src/utils/install-skills.ts` | MODIFY | Narrow to offline fallback; read target dir from a descriptor `skillsDir` (keep CC/Codex `plugin-active` skip) |
| `src/commands/setup.ts` | MODIFY | Orchestrate generalized flow: wrap `npx skills add` (Tier 1) + offline fallback + iterate registry (Tier 2) |
| `src/utils/config.ts` | MODIFY | Extend `IntegrationConfig` with per-agent install records (interface + defaults + serializer + parser) |
| `src/index.ts` | MODIFY | Register `--target` / `--agent` / `--dry-run` flags on `setup` (and `setup-adapter` if needed) |
| `references/tool-dialects.md` | CREATE | One-page tool-dialect matrix (Phase-1 docs) |
| `platforms/README.md` | MODIFY | Add new agents to Supported Frameworks table + usage |
| `src/__tests__/adapter-templates.test.ts` | MODIFY | Add `describe` for the Hermes renderer |
| `src/__tests__/setup-adapter.test.ts` | MODIFY | Add registry-driven cases for pi/hermes/openclaw |
| `src/__tests__/targets-registry.test.ts` | CREATE | Assert descriptors resolve correct paths + renderers |
| `src/__tests__/setup-install.test.ts` | MODIFY | `setup --target pi --dry-run` against temp HOME shows the `npx skills add` invocation |

## Tasks

Order keeps the build green at every step: types → renderer → registry → setup-adapter refactor → install-skills generalization → setup orchestration (npx wrap + offline fallback) → config records → CLI flags → discovery check → docs → tests.

### 1. Define target-descriptor types
- **File:** `src/targets/types.ts` (CREATE)
- **What:** Add `ProtocolContext` (the existing 4-field renderer shape: `projectSlug`, `assignmentSlug`, `projectDir`, `assignmentDir` — matches `CursorAssignmentParams` and `CodexAgentsParams`; OpenCode's renderer needs only `projectDir`, a subset). Add `AgentTarget` per memo lines 104-115: `id`, `displayName`, `detect(): Promise<boolean>`, optional `skillsDir?: { project?; global? }`, optional `instructions?: { files: Array<{ path: string; render: (ctx: ProtocolContext) => string }> }`, optional `nativePlugin?: 'claude' | 'codex'`. Renderers referenced by a renderer **key** (string), not inline closures, to stay serializable-friendly (memo 116-117) for the deferred Phase-3 "C" option.
- **Pattern:** Mirror param shapes in `src/templates/cursor-rules.ts:1-6` and `src/templates/codex-agents.ts:1-6`.
- **Verify:** `npm run typecheck`

### 2. Add the Hermes SOUL.md renderer
- **File:** `src/templates/hermes-soul.ts` (CREATE) + `src/templates/index.ts` (MODIFY, barrel export alongside lines 49-56)
- **What:** New `renderHermesSoul(params: ProtocolContext): string` producing `SOUL.md`/context content. Reuse the protocol body from `renderCodexAgents` (`src/templates/codex-agents.ts`) as the basis; Hermes reads `SOUL.md`/context per memo line 36. Export `renderHermesSoul` + its param type from the barrel so `adapter-templates.test.ts` can import from `'../templates/index.js'`.
- **Pattern:** Follow `src/templates/codex-agents.ts` structure (string template, leading `# Syntaur Protocol` heading). pi reuses `renderCodexAgents` and cursor reuses `renderCursorProtocol`/`renderCursorAssignment` — no new renderers for those.
- **Verify:** `npm run typecheck`

### 3. Build the descriptor registry
- **File:** `src/targets/registry.ts` (CREATE)
- **What:** Export an array/map of `AgentTarget` descriptors:
  - `cursor` → instructions write `.cursor/rules/syntaur-protocol.mdc` (via `renderCursorProtocol`) + `.cursor/rules/syntaur-assignment.mdc` (via `renderCursorAssignment`).
  - `codex` → `nativePlugin: 'codex'`. `pi` → instructions write `AGENTS.md` via `renderCodexAgents` (pi reads `AGENTS.md`/`CLAUDE.md`), `skillsDir.global` = `~/.pi/agent/skills`.
  - `openclaw` → instructions write workspace `AGENTS.md` (and optionally `SOUL.md`) via `renderCodexAgents`, `skillsDir.global` = `~/.openclaw/skills`.
  - `hermes` → instructions write `SOUL.md` via `renderHermesSoul`, `skillsDir.global` = `$HERMES_HOME/skills` (default `~/.hermes/skills`).
  - `opencode` → instructions write `AGENTS.md` (`renderCodexAgents`) + `opencode.json` (`renderOpenCodeConfig`, `{ projectDir }`).
  - `claude` / `codex` → `nativePlugin` entries, no `instructions` (keeps Tier-3 path untouched).
  - `detect()` = `existsSync` probe of each agent's config/dir, exactly like skills.sh (e.g. pi `~/.pi`, openclaw `~/.openclaw`, hermes `$HERMES_HOME`/`~/.hermes`). Use `expandHome` from `src/utils/paths.js`.
  - Use a renderer-key registry (key → render fn) so descriptors stay serializable.
- **Pattern:** Descriptor input == existing 4-field renderer params. Paths are CWD-relative for instruction files; `skillsDir` are absolute home-expanded.
- **Verify:** `npm run typecheck`

### 4. Refactor setup-adapter to iterate the registry
- **File:** `src/commands/setup-adapter.ts` (MODIFY)
- **What:** Replace `SUPPORTED_FRAMEWORKS` (line 10), the `Framework` union (line 11), and the unknown-framework throw (25-29) with a lookup into the registry. Keep context resolution unchanged: `readConfig()` → `config.defaultProjectDir` or `--dir` (50-53), project.md verify (62-67), assignment.md verify (70-75), `rendererParams` build (81-86). Replace the `if (framework === 'cursor') … else if (codex|opencode)` block (101-115) with a loop over `target.instructions.files`, resolving each `file.path` against `process.cwd()` and calling `file.render(rendererParams)` through `writeAdapterFile` (88-99, unchanged — `writeFileForce` on `--force` else `writeFileSafe`). Throw on unknown framework or a framework with no `instructions` (e.g. claude/codex — those go through the plugin path, not the adapter). Cursor still emits the two `.mdc` files; codex/opencode still emit `AGENTS.md` (+ `opencode.json` for opencode) — byte-identical to today.
- **Pattern:** Reuse `writeAdapterFile` and `src/utils/fs.ts` helpers (`writeFileSafe:17`, `writeFileForce:29`, `fileExists:8`).
- **Verify:** `npm run typecheck && npx vitest run src/__tests__/setup-adapter.test.ts` (existing cursor/codex/opencode cases must stay green before adding new ones)

### 5. Generalize install-skills to read a descriptor skillsDir
- **File:** `src/utils/install-skills.ts` (MODIFY)
- **What:** Allow installs to target an arbitrary agent dir for the **offline fallback** path. Keep `SkillTarget = 'claude' | 'codex'` for the existing CC/Codex callers, but let `installSkills`/`installSkillsWithReport` accept an explicit `targetDir` (already supported, lines 13/216/223) sourced from a descriptor's `skillsDir`. **Do not** change `defaultSkillTargetDir` (81-84) behavior for claude/codex. **Keep** the `plugin-active` skip (216-220) and the symlink-skip in `installSkillDir` (159-165) untouched — this is what makes skills.sh coexistence work. Reuse `discoverSkillNames` (185-201) and `installSkillDir` (150-183) as-is for the offline copy fallback into a descriptor dir.
- **Pattern:** Offline copy routes through `installSkillsWithReport({ target, targetDir: <descriptor skillsDir>, ignorePluginActive })`.
- **Verify:** `npm run typecheck && npx vitest run src/__tests__/install-skills.test.ts` (must stay green — proves claude/codex behavior unchanged)

### 6. Orchestrate the generalized setup flow (Tier 1 wrap + offline fallback + Tier 2)
- **File:** `src/commands/setup.ts` (MODIFY)
- **What:** Extend `SetupOptions` (19-27) with `target?: string`, `agent?: string`, `dryRun?: boolean`. After the existing init/dashboard flow, add the generalized path (setup.ts does NOT currently call `setupAdapterCommand` — this is net-new):
  1. **Tier 1:** shell out to `npx skills add <syntaur-source>` (default source `prong-horn/syntaur`) via `execSync`; pass `--agent` through from `--agent` or from registry `detect()`. Under `--dry-run`, print the exact `npx skills add …` command instead of running it.
  2. **Offline fallback:** if `npx` is unavailable or the call fails, fall back to `installSkillsWithReport` copying Syntaur's bundled `skills/` into the target descriptor's `skillsDir` (mitigates the external-dependency risk). Skills are not bundled in `node_modules` (`skills` CLI absent there) — the fallback uses the package's own `skills/` via `getSkillsDir()`.
  3. **Tier 2:** for each selected/detected agent with an `instructions` descriptor, render + write the protocol files (idempotent, `differs-preserved` + `--force`). Skip Tier-2 files for agents whose project dir doesn't already exist (no-littering hygiene, memo line 135). Under `--dry-run`, list the files it *would* write.
  4. **CC/Codex:** existing `installPluginCommand` (82) / `installCodexPluginCommand` (91) path stays exactly as-is.
- **Pattern:** Mirror `isCliInstalled` (10-17) for `npx` availability; reuse `confirmPrompt`/`isInteractiveTerminal` for any new prompts.
- **Verify:** `npm run typecheck`

### 7. Persist per-agent install records in config
- **File:** `src/utils/config.ts` (MODIFY)
- **What:** Extend `IntegrationConfig` (81-85) with an `installedAgents` map (agent id → scope `'project' | 'global'` or a small record). Update: `DEFAULT_CONFIG.integrations` (146-150) with an empty default; `serializeIntegrationConfig` (466-484) to emit the map as dotted FM keys; the parser block (1449-1462) to read them back. Keep the three existing fields (`claudePluginDir`, `codexPluginDir`, `codexMarketplacePath`) intact.
- **Pattern:** Follow the existing dotted-key FM convention (`integrations.claudePluginDir`) and `parseOptionalAbsolutePath` usage.
- **Verify:** `npm run typecheck && npx vitest run src/__tests__` (config round-trip tests must stay green)

### 8. Register new CLI flags
- **File:** `src/index.ts` (MODIFY)
- **What:** On the `setup` command (504-523) add `--target <id>` (single-agent install), `--agent <id>` (passthrough to `npx skills` / `detect()` override), and `--dry-run` (print intended actions, write nothing). These flow into `SetupOptions`. Leave `setup-adapter` (692-710) registration intact; only touch it if Task 4 requires surfacing a new agent id in its `<framework>` help text.
- **Pattern:** Match existing `.option()` style and the try/catch `action` wrappers in this file.
- **Verify:** `npm run typecheck && node dist/index.js setup --help` (after `npm run build`) shows the new flags

### 9. skills.sh subdir-discovery check (5-min, branch on result)
- **File:** (investigation; may CREATE `.well-known/agent-skills/index.json`)
- **What:** Run a non-destructive `npx skills add prong-horn/syntaur` dry/inspect check (e.g. `--help` / detection step / temp HOME) to confirm skills.sh auto-discovers the repo's `skills/` subdirectory. **Branch:** if it auto-scans `skills/`, do nothing. If it does NOT, add a minimal static `.well-known/agent-skills/index.json` (v0.2.0 shape: `name/type/description/url` per `SKILL.md`) to the repo so the GitHub-source channel resolves. (Phase 2 owns the *generator* + sha256 digests + hosting — do not build that here.) Record the outcome in `progress.md`.
- **Verify:** Document the discovery result; if an index was added, `node -e "JSON.parse(require('fs').readFileSync('.well-known/agent-skills/index.json','utf8'))"` parses clean.

### 10. Docs
- **File:** `references/tool-dialects.md` (CREATE) + `platforms/README.md` (MODIFY)
- **What:** New one-page dialect matrix (pi/openclaw lowercase `read/edit/bash`; hermes snake_case `read_file/patch/terminal`; CC/Codex native) noting Syntaur skills are `syntaur <cmd>`-driven so dialect is moot (memo line 70). Update the Supported Frameworks table + usage in `platforms/README.md` to list pi, hermes, openclaw and the `npx skills add prong-horn/syntaur` turnkey path.
- **Verify:** Manual read; links/paths resolve.

### 11. Tests
- **Files:** `src/__tests__/targets-registry.test.ts` (CREATE), `src/__tests__/adapter-templates.test.ts` (MODIFY), `src/__tests__/setup-adapter.test.ts` (MODIFY), `src/__tests__/setup-install.test.ts` (MODIFY)
- **What:**
  - **Registry unit:** assert each descriptor resolves the expected instruction file paths and skillsDir, and that renderer keys map to real functions.
  - **Renderer unit:** add a `describe('renderHermesSoul')` in `adapter-templates.test.ts` importing from the barrel and feeding `TEST_PARAMS` (9-15), asserting substrings (`SOUL`, protocol markers).
  - **setup-adapter integration:** add cases for `pi`, `hermes`, `openclaw` to `setup-adapter.test.ts` (mkdtemp → seed project.md + assignment.md → `process.chdir` → `setupAdapterCommand(id, opts)` → read written files); confirm cursor/codex/opencode outputs are unchanged.
  - **setup dry-run integration:** in `setup-install.test.ts` (temp-HOME pattern 70-83: `HOME=mkdtemp`, stub `stdin/stdout.isTTY`, `seedClaudeUserMarketplace()`, restore `afterEach`), assert `setup --target pi --dry-run` prints the `npx skills add` invocation + the Tier-2 files it would write, and writes nothing.
- **Verify:** `npm run build && npm install --prefix dashboard` then `npm test` (fresh-worktree gate); or targeted: `npx vitest run src/__tests__/adapter-templates.test.ts src/__tests__/setup-adapter.test.ts src/__tests__/targets-registry.test.ts src/__tests__/install-skills.test.ts src/__tests__/setup-install.test.ts src/__tests__/install-plugin-marketplace.test.ts`

## Provably-unchanged CC/Codex (sequencing guarantee)
- Task 4 keeps claude/codex as `nativePlugin` descriptors **without** `instructions`, so `setup-adapter` never renders for them (it throws/no-ops as today — they were never in `SUPPORTED_FRAMEWORKS`).
- Task 5 leaves `defaultSkillTargetDir`, `plugin-active` skip, and symlink-skip untouched; the existing `install-skills.test.ts` and `install-plugin-marketplace.test.ts` must pass **before and after** every task that touches shared code.
- Task 6 leaves `installPluginCommand` / `installCodexPluginCommand` calls byte-for-byte identical.
- Gate: run `npx vitest run src/__tests__/install-plugin-marketplace.test.ts src/__tests__/install-skills.test.ts` after Tasks 4, 5, 6, and 7.

## Dependencies
- `npx skills` (Vercel Labs `skills`, skills.sh) — invoked at runtime via `npx`; NOT bundled (confirmed absent from `node_modules`). Offline fallback (Task 6) removes the hard dependency.
- No new env vars. Hermes honors an existing `$HERMES_HOME` (default `~/.hermes`).

## Verification (all tasks complete)
```
npm run typecheck
npm run build && npm install --prefix dashboard   # fresh-worktree gate
npm test
# targeted adapter/skill/plugin gates:
npx vitest run \
  src/__tests__/adapter-templates.test.ts \
  src/__tests__/setup-adapter.test.ts \
  src/__tests__/targets-registry.test.ts \
  src/__tests__/install-skills.test.ts \
  src/__tests__/setup-install.test.ts \
  src/__tests__/install-plugin-marketplace.test.ts
# editing skills (if any SKILL.md changes during dialect-docs work): edit skills/<name>/SKILL.md then:
npm run mirror-skills
```
