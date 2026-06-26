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

/** A session discovered on disk from an agent's transcript files. */
export interface DiscoveredSession {
  sessionId: string;
  cwd: string;
  startedAt: string | null;
  endedAt?: string | null;
  /** Absolute path to the transcript file backing this session. */
  transcriptPath: string;
}

export interface SessionsWalkOpts {
  /** Override the transcript root (tests). */
  root?: string;
  /** Skip transcript files modified before this epoch-ms watermark. */
  sinceMtimeMs?: number;
}

/**
 * Filesystem session discovery for an agent: where transcripts live (`globs`),
 * how to parse a single file (`parse`), and an efficient bulk walk over all of
 * them (`walk` — the scanner's path, backed by the usage walkers). Built-in
 * only: `UserAgentDescriptor` deliberately omits it (like `tier3`) because it
 * is behavioral code, not serializable data.
 */
export interface AgentSessionsDescriptor {
  globs: (root?: string) => string[];
  parse: (file: string) => Promise<DiscoveredSession | null>;
  walk: (opts?: SessionsWalkOpts) => AsyncGenerator<DiscoveredSession>;
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
  /**
   * Tier-3 deep-enforcement plugin (boundary hook + session cleanup + commands)
   * for non-native agents (pi/OpenClaw TypeScript extension, Hermes Python
   * plugin). Built-in-only — user descriptors can never set this. See
   * `src/commands/cross-agent-install.ts` (install) + the doctor cross-agent
   * check (status).
   */
  tier3?: Tier3Plugin;
  /**
   * Filesystem session discovery for the universal session scanner. Absent →
   * the agent's sessions are only tracked via hooks/launch (e.g. Cursor has no
   * parseable on-disk transcripts). Built-in-only, like `tier3`.
   */
  sessions?: AgentSessionsDescriptor;
  /**
   * Directory holding this agent's user-defined agent definitions (markdown with
   * `name`/`description`/`model` frontmatter), for `--agent <name>` identity
   * discovery. Set for Claude (`~/.claude/agents`); absent for agents with no
   * named-agent registry (pi/codex use directory-agents via `workdir` instead).
   */
  agentsDir?: string;
}

/**
 * A Tier-3 enforcement plugin shipped in `platforms/<kind>/…` and copied into the
 * agent's plugin/extension dir by the cross-agent install flow.
 */
export interface Tier3Plugin {
  kind: 'pi-extension' | 'hermes-plugin';
  /** Source dir relative to the package root (e.g. `platforms/pi/extensions/syntaur`). */
  source: string;
  /** Absolute, home-expanded install dir (e.g. `~/.pi/agent/extensions/syntaur`). */
  installDir: () => string;
  /** Entry file the doctor check probes to report installed/absent (e.g. `index.ts`). */
  entry: string;
}

/**
 * Declarative, serializable detect probe. User descriptors can't ship a `detect`
 * function, so they describe the probe as data and the loader compiles it into an
 * `AgentTarget['detect']` at load time.
 */
export type DetectSpec =
  | { kind: 'pathExists'; path: string } // true if the (home/env-expanded) path exists
  | { kind: 'anyPathExists'; paths: string[] } // true if ANY listed path exists
  | { kind: 'envSet'; env: string }; // true if process.env[env] is a non-empty string

/**
 * The serializable, user-authorable form of `AgentTarget`. Lives in a JSON file
 * under `~/.syntaur/targets/`. Deliberately omits `detect` (a function),
 * `nativePlugin`, and `tier3` — users register Tier-1+Tier-2 agents only, and
 * `detect` is supplied declaratively via `DetectSpec`. See
 * `references/user-targets.md` and `src/targets/user-descriptors.ts`.
 */
export interface UserAgentDescriptor {
  id: string; // ^[a-z0-9][a-z0-9_-]*$ and NOT a built-in id
  displayName: string; // non-empty
  skillsShAgentId?: string;
  detect: DetectSpec;
  skillsDir?: AgentSkillsDir;
  instructions?: { files: AgentInstructionFile[] }; // renderer must be an existing RendererKey
}
