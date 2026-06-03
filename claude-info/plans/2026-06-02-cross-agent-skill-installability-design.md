# Cross-agent skill installability — design memo

**Status:** approved design (brainstorming output), pre-implementation
**Assignment:** `syntaur-meta / make-syntaur-skills-installable-in-any-agent-agent-skills-spec-skillssh-interop`
**Branch/worktree:** `feat/cross-agent-skill-install`
**Date:** 2026-06-02

## Problem

Syntaur skills/plugins install into only two agents today, via two unrelated tiers:

- **Plugin tier** (Claude Code, Codex): full install — the 30 `SKILL.md` skills + hooks
  + slash commands + agents, via platform-specific manifests. Canonical source is
  top-level `skills/`, mirrored verbatim into `platforms/<kind>/skills/` by
  `scripts/mirror-skills-to-platforms.mjs`. Tool-name dialect is handled at *runtime*
  via doc-mappings, not at build time.
- **Adapter tier** (Cursor, OpenCode): instruction-file generation only
  (`.cursor/rules/*.mdc`, `AGENTS.md`) via `src/commands/setup-adapter.ts`. Installs no
  executable skills.

We want Syntaur skills installable in **any** coding agent — concretely **pi-agent**,
**Hermes Agent**, and **OpenClaw** — and structurally open to the long tail beyond them.

## Key findings (grounding)

1. **pi, Hermes, OpenClaw all natively load the same Agent Skills `SKILL.md` standard**
   that Claude Code uses. So Syntaur's 30 skills — the bulk of its value — are nearly
   **write-once, install-everywhere**.
   - pi → `~/.pi/agent/skills/` (global), `.pi/skills/` (project). Reads `AGENTS.md` *or*
     `CLAUDE.md`. Config `~/.pi/agent/settings.json`. Tool dialect lowercase
     `read/edit/bash`.
   - OpenClaw → `~/.openclaw/skills/` (skills.sh path) / workspace
     `~/.openclaw/workspace/skills/`. Built on pi (`pi-coding-agent`), same lc dialect.
     Reads workspace `AGENTS.md`/`SOUL.md`. Config JSON5 `~/.openclaw/openclaw.json`.
   - Hermes → `$HERMES_HOME/skills/` (default `~/.hermes/skills/`), with a `metadata.hermes`
     frontmatter block. Reads `SOUL.md`/context files. Config YAML `~/.hermes/config.yaml`.
     Tool dialect is its own snake_case (`read_file/patch/terminal`).
2. **Where they diverge is hooks/commands/enforcement**: pi & OpenClaw want imperative
   **TypeScript** extensions/plugins; Hermes wants **Python** plugins. None use Claude
   Code's declarative JSON hooks. Full enforcement parity is a per-agent code lift.
3. **`npx skills add` (Vercel Labs `skills`, skills.sh) already solves cross-agent skill
   distribution** and already supports all three targets:
   - Fully **data-driven registry** (`src/agents.ts`): 56 agents, each just
     `{ name, displayName, skillsDir, globalSkillsDir, detectInstalled() }`. No
     per-agent behavioral code beyond an `existsSync` detection probe.
   - **Canonical store + per-agent symlink**: every skill copied once into a neutral
     `.agents/skills/` (the AGENTS.md-ecosystem universal dir), then each agent dir gets
     a relative symlink back. Copy-mode fallback when symlinks aren't available. Agents
     with no bespoke dir just use `.agents/skills/`.
   - **No tool-name dialect translation** — `SKILL.md` ships verbatim to all 56; compat
     nuances live in a *docs* matrix, not code.
   - **Conforms to a spec**: the open Agent Skills spec (agentskills.io), discoverable via
     `/.well-known/agent-skills/index.json` (v0.2.0: `name/type/description/url/sha256`).
     skills.sh is a *search index* over GitHub/well-known sources, not a central host.
   - The one thing it deliberately does **not** do: emit per-agent **instruction/adapter
     files** (no `AGENTS.md` / `.mdc` generation). It owns Tier 1, not Tier 2.
4. Syntaur's `src/utils/install-skills.ts` already **detects and preserves skills.sh
   symlinks** (`skipped-symlink` status) — they already coexist. The repo already ships
   `skills/` in its npm `files` array and has a `.agents/` dir (currently only holds
   `plugins/`, not skills).

## Decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| **Install depth** | **Tier 1 (skills) + Tier 2 (protocol instructions)**. No Tier-3 per-agent enforcement hooks. |
| **Structure** | **Target-descriptor registry** (Approach A) — one declarative descriptor per agent; generalize the existing seams to iterate it. |
| **Tier-1 distribution** | **Interop via the Agent Skills spec** — publish Syntaur's existing `skills/` as a spec-compliant source; ride `npx skills add` + any spec installer. Not locked to one vendor. `syntaur setup` wraps `npx skills` for turnkey UX. |
| **CC/Codex** | Keep their existing **full-plugin (Tier-3) path unchanged**. Generalize everything *beyond* them. |
| **Tool dialect** | Ship **verbatim** `SKILL.md` (skills.sh proves this across 56 agents). Syntaur skills are `syntaur <cmd>`-driven, so dialect is moot. Document a one-page dialect matrix instead of transforming. |
| **New repo?** | **No.** Source is the existing `prong-horn/syntaur` repo + published `syntaur` npm package (already ships `skills/`). Phase-2 `.well-known` index is generated from `skills/` onto the existing site/repo. |

## Architecture — three layers, only one is new code

| Layer | What | Owner |
|---|---|---|
| **CLI** (prereq) | `npm i -g syntaur`. Every skill shells out to `syntaur <cmd>`, so the CLI is the real runtime dependency. | Unchanged |
| **Tier 1 — Skills** | The 30 `SKILL.md` bundles, distributed to any agent via the Agent Skills spec. | **Delegated** to skills.sh / spec installers (with an offline copy fallback) |
| **Tier 2 — Protocol instructions** | Per-agent always-on protocol/boundary context (`.mdc`, `AGENTS.md`, `SOUL.md`). | **Syntaur-owned** descriptor registry |

## Tier 1 — publish Syntaur as a spec source

- **Primary channel (zero hosting):** `npx skills add prong-horn/syntaur` reads `skills/*/SKILL.md`
  straight from the existing repo.
- **npm channel:** the published `syntaur` package already ships `skills/`; after
  `npm i -g syntaur` the bundles are on disk (skills.sh `experimental_sync` can pull from
  `node_modules`; Syntaur's offline fallback reads its own bundled `skills/`).
- **Branded channel (Phase 2):** generate `/.well-known/agent-skills/index.json` (v0.2.0,
  sha256-digested) from `skills/`, host on the existing site → `npx skills add syntaur.sh`,
  content-verified.
- **Turnkey:** `syntaur setup` wraps `npx skills add <source>` so users never need to know
  skills.sh exists; skills.sh's detect→multiselect→symlink(+copy-fallback) does the work.
- **`syntaur-protocol` skill rides along for free**, so on-demand protocol knowledge reaches
  every agent via Tier 1 alone.
- **Open verification (Phase 1, 5-min test, non-blocking):** confirm skills.sh auto-discovers
  a `skills/` *subdirectory* in a GitHub repo vs. wanting a path hint / explicit index. If it
  doesn't auto-scan, add a `.well-known/agent-skills/index.json` to the existing repo.

## Tier 2 — the descriptor registry (the only real new code)

`src/targets/registry.ts` — mirrors skills.sh's `AgentConfig`, **plus** the `instructions`
emit field they omit:

```ts
interface AgentTarget {
  id: string;                         // 'pi' | 'hermes' | 'openclaw' | 'cursor' | ...
  displayName: string;
  detect(): Promise<boolean>;         // existsSync probe, exactly like skills.sh
  skillsDir?: { project?: string; global?: string };  // for `syntaur doctor` verify + offline fallback
  instructions?: {                    // ← Tier 2: what skills.sh can't do
    files: Array<{ path: string; render: (ctx: ProtocolContext) => string }>;
  };
  nativePlugin?: 'claude' | 'codex';  // ← Tier 3: deep-integrated agents, untouched
}
```

- Descriptors are kept **serializable-friendly** (render referenced by a renderer key) so a
  later "user-authored descriptors" evolution (the deferred "C" option) is a small step.
- `setup-adapter.ts` is refactored to **iterate this registry** instead of switch-casing
  `SUPPORTED_FRAMEWORKS`. Cursor/Codex/OpenCode become registry entries; pi/hermes/openclaw
  are one entry each.
- Renderers: pi reuses the existing `AGENTS.md` renderer (it reads `AGENTS.md`/`CLAUDE.md`);
  OpenClaw uses a workspace `AGENTS.md`; Hermes needs a small new `SOUL.md`/context renderer.
- Tier-2 files target agents needing **always-on** boundary reminders a lazily-loaded skill
  can't guarantee; where the `syntaur-protocol` skill suffices, Tier 2 is optional polish.

## Install flow (`syntaur setup`, generalized)

1. Ensure `syntaur` on PATH.
2. **Tier 1:** `npx skills add <syntaur-source>` (detection/multiselect via skills.sh, or pass
   `--agent` from our own `detect()`).
3. **Tier 2:** for each selected agent with an `instructions` descriptor, render + write the
   protocol files — idempotent, `differs-preserved` + `--force` (reusing `install-skills.ts`'s
   existing safety pattern). Skip Tier-2 files for agents whose project dir doesn't already
   exist (skills.sh's no-littering hygiene rule).
4. **CC/Codex:** existing plugin install path, unchanged.
5. `syntaur doctor` verifies CLI on PATH + skills present in each detected agent's dir + Tier-2
   files present.

## Hardening & fallbacks

- **No `npx`/offline:** fall back to `install-skills.ts` copy using each descriptor's
  `skillsDir` — keeps Syntaur functional without a hard skills.sh dependency (mitigates the
  external-dependency risk of the interop choice).
- **Symlink not permitted:** skills.sh already falls back to copy; our offline fallback copies
  too.
- **Agent not auto-detected but named by user:** `--agent` passthrough.
- **Tier-2 file exists & differs:** preserve, warn, `--force` to overwrite.

## Files to change / add

- **New:** `src/targets/types.ts` (`AgentTarget`, `ProtocolContext`), `src/targets/registry.ts`
  (descriptors), per-agent instruction renderers as needed (Hermes `SOUL.md`).
- **New (Phase 2):** `scripts/build-skills-index.mjs` — generate `.well-known/agent-skills/index.json`
  (sha256 digests) from `skills/`.
- **Refactor:** `src/commands/setup-adapter.ts` → registry-driven (drop the `SUPPORTED_FRAMEWORKS`
  switch).
- **Refactor:** `src/commands/setup.ts` → orchestrate the generalized flow + `npx skills` wrap.
- **Adjust:** `src/utils/install-skills.ts` → role narrows to offline fallback; reads descriptor
  `skillsDir`. Keep CC/Codex `plugin-active` skip behavior.
- **Adjust:** `scripts/mirror-skills-to-platforms.mjs` → still needed only for the CC/Codex native
  plugin (Tier-3); long-tail agents need no per-platform mirror.
- **Adjust:** `src/utils/config.ts` `IntegrationConfig` → per-agent install records (which agents,
  scope).
- **Docs:** `references/tool-dialects.md` matrix; update `platforms/README.md`.

## Testing

- Unit: registry descriptors resolve correct paths; instruction renderers produce valid output
  (extend `src/__tests__/adapter-templates.test.ts`).
- Unit: `.well-known` index generator → valid v0.2.0 schema + correct digests (Phase 2).
- Integration: `syntaur setup --target pi --dry-run` shows the `npx skills add` invocation + the
  Tier-2 files it would write, against a temp HOME.
- Keep existing CC/Codex install/uninstall tests green.
- Fresh-worktree note: run root `npm run build` + `npm install --prefix dashboard` before
  `npm test`.

## Phasing

- **Phase 1:** descriptor registry + `setup-adapter` refactor; pi/hermes/openclaw/cursor/opencode
  descriptors (Tier 2). Wrap `npx skills add` in `syntaur setup` (Tier 1) + offline fallback.
  GitHub-source channel; verify skills.sh subdir discovery.
- **Phase 2:** `.well-known/agent-skills/index.json` generator + hosting for branded
  `npx skills add syntaur.sh`; `syntaur doctor` cross-agent verification.
- **Phase 3 (later):** user-authored descriptors (the "C" evolution); optional Tier-3 deep
  plugins for pi/openclaw (TS) / hermes (Python) if demand appears.

## Open questions for the plan

1. Does skills.sh auto-discover a `skills/` subdir in `prong-horn/syntaur`, or do we add a
   `.well-known` index in Phase 1?
2. Should `syntaur setup` shell out to `npx skills` (zero bundling) or vendor a pinned `skills`
   version for determinism? (Leaning: shell out, offline fallback covers the gap.)
3. Where exactly do per-agent install records live in `config.md` frontmatter, and do we track
   scope (project vs global) per agent?
