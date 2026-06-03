// Declarative per-agent target descriptors for cross-agent skill installability.
//
// The model deliberately mirrors the data-driven `AgentConfig` registry in
// Vercel Labs' `skills` CLI (skills.sh) — one thin data record per agent, with
// no behavioral code beyond a `detect()` probe — PLUS the one field skills.sh
// omits: an `instructions` emit strategy (Tier 2 — per-agent protocol/adapter
// files like AGENTS.md / .mdc / SOUL.md). Tier 1 (the SKILL.md bundles
// themselves) is distributed via the Agent Skills spec / `npx skills add`.
//
// See claude-info/plans/2026-06-02-cross-agent-skill-installability-design.md.

/**
 * Context passed to every protocol-instruction renderer. Identical to the
 * existing template renderer param shapes (CursorAssignmentParams /
 * CodexAgentsParams), so descriptors can reference those renderers directly.
 */
export interface ProtocolContext {
  projectSlug: string;
  assignmentSlug: string;
  projectDir: string;
  assignmentDir: string;
}

/**
 * Renderers are referenced by a string key (not inline closures) so descriptors
 * stay serializable — a prerequisite for the deferred "user-authored
 * descriptors" evolution. The key → function mapping lives in
 * `src/targets/renderers.ts`.
 */
export type RendererKey =
  | 'codexAgents'
  | 'cursorProtocol'
  | 'cursorAssignment'
  | 'openCodeConfig'
  | 'hermesSoul';

/**
 * One protocol-instruction file emitted for an agent. `path` is resolved
 * relative to the current working directory at write time.
 */
export interface AgentInstructionFile {
  path: string;
  renderer: RendererKey;
}

/**
 * Optional install scope for an agent, mirroring skills.sh's project-vs-global
 * skills directories.
 */
export interface AgentSkillsDir {
  /** Project-relative skills dir (e.g. `.pi/skills`). */
  project?: string;
  /** Absolute, home-expanded global skills dir (e.g. `~/.pi/agent/skills`). */
  global?: string;
}

/**
 * A single agent target. Adding support for "any agent" is a matter of adding
 * one of these to the registry.
 */
export interface AgentTarget {
  /** Syntaur's id for this agent (e.g. `pi`, `hermes`, `openclaw`). */
  id: string;
  /** Human-readable name for prompts and `doctor` output. */
  displayName: string;
  /**
   * The agent id used by the Agent Skills ecosystem / `npx skills add --agent`.
   * Differs from Syntaur's id for some agents (e.g. Syntaur `hermes` →
   * skills.sh `hermes-agent`, Syntaur `claude` → skills.sh `claude-code`).
   */
  skillsShAgentId?: string;
  /** Probe whether the agent is installed on this machine (existsSync-style). */
  detect: () => Promise<boolean>;
  /** Where Tier-1 skills land — used for `doctor` verification + offline copy fallback. */
  skillsDir?: AgentSkillsDir;
  /** Tier-2 protocol-instruction files this agent reads. Absent → no adapter. */
  instructions?: { files: AgentInstructionFile[] };
  /**
   * Agents Syntaur deep-integrates as full plugins (skills + hooks + commands).
   * Their plugin path is owned by install-plugin / install-codex-plugin and is
   * left untouched by the cross-agent flow.
   */
  nativePlugin?: 'claude' | 'codex';
}
