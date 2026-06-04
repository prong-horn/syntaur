---
title: Cross-agent skill installability — Phase 1 (Tier 1 + Tier 2) — DRAFT (superseded)
assignment: make-syntaur-skills-installable-in-any-agent-agent-skills-spec-skillssh-interop
date: 2026-06-02
status: superseded-by-canonical-plan
---

# Cross-agent skill installability — Phase 1 (sun-tzu-lite draft)

> **This is the pre-review draft.** The canonical, post-codex-plan-review (r2) task list lives in
> the assignment's `plan.md` (dashboard) and is the implementation source of truth. The approved
> architecture is in `claude-info/plans/2026-06-02-cross-agent-skill-installability-design.md`.

This draft seeded the plan. Codex plan-review (gpt-5.5) flagged six must-fix items, all adopted in
the canonical `plan.md` revision **r2**:

1. **codex is BOTH an adapter and a plugin.** It is in `SUPPORTED_FRAMEWORKS` (`setup-adapter.ts:10`)
   and writes `AGENTS.md`. The `codex` descriptor keeps its `instructions` (AGENTS.md) AND carries
   `nativePlugin:'codex'`. Only `claude` is plugin-only (no adapter today). Adapter output for
   cursor/codex/opencode stays byte-identical.
2. **Renderer-by-key, not inline closures.** A typed `RENDERERS: Record<RendererKey, fn>` map;
   descriptors reference `renderer: <key>`.
3. **Syntaur drives agent selection.** Compute `selectedTargets` from `--target`/`--agent`/detection,
   pass exact **skills.sh agent IDs** to `npx skills add --agent …`, reuse for offline fallback + Tier 2.
   skills.sh IDs differ (`hermes`→`hermes-agent`, `claude`→`claude-code`) — each descriptor has a
   `skillsShAgentId`.
4. **Real content-diff idempotence** (`writeFileReport` → `written|already-current|differs-preserved|
   overwritten`), not skip-if-exists.
5. **`$HERMES_HOME` is not expanded by `expandHome`** (`paths.ts:4` only handles `~`) — Hermes skills
   dir computed from `process.env.HERMES_HOME ?? ~/.hermes`. `installSkills` gets an
   `installSkillsToDir` overload (no fake `target`). Use `spawnSync` arg-array (no shell injection).
6. **Optional config schema + gated setup.** `installedAgents?` is OPTIONAL (existing config literals
   unaffected); all new `setup` behavior gated behind `--target`/`--agent` so default `setup`/`--yes`
   is unchanged. A minimal Phase-1 `doctor` cross-agent check satisfies that acceptance criterion.

See the assignment `decision-record.md` and `plan.md` for the full revised plan.
