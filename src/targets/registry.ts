import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileExists } from '../utils/fs.js';
import type { AgentTarget } from './types.js';

function home(...segments: string[]): string {
  return resolve(homedir(), ...segments);
}

/**
 * Hermes honors `$HERMES_HOME` (default `~/.hermes`). NOTE: skills.sh ignores
 * this env and always installs `hermes-agent` skills to `~/.hermes/skills`, so
 * the setup orchestration must reconcile a non-default `$HERMES_HOME` with an
 * explicit offline copy. (`expandHome` only handles `~`, not env vars.)
 */
export function hermesHome(): string {
  const env = process.env.HERMES_HOME;
  return env && env.length > 0 ? resolve(env) : home('.hermes');
}

export function hermesSkillsDir(): string {
  return resolve(hermesHome(), 'skills');
}

/**
 * True when `$HERMES_HOME` points somewhere other than the default `~/.hermes`.
 * In that case `npx skills add --agent hermes-agent` (which always targets
 * `~/.hermes/skills`) won't reach the real dir, so an explicit offline copy is
 * required.
 */
export function isHermesHomeCustom(): boolean {
  return hermesHome() !== home('.hermes');
}

function codexHome(): string {
  const env = process.env.CODEX_HOME;
  return env && env.length > 0 ? resolve(env) : home('.codex');
}

const detectDir = (dir: string) => (): Promise<boolean> => fileExists(dir);

/**
 * The declarative cross-agent target registry. Adding an agent = adding an
 * entry here. `instructions` is the Tier-2 adapter (protocol files); `skillsDir`
 * is where Tier-1 skills land (used for `doctor` + the offline copy fallback);
 * `nativePlugin` marks agents whose full-plugin path Syntaur owns separately.
 */
export const AGENT_TARGETS: AgentTarget[] = [
  {
    id: 'cursor',
    displayName: 'Cursor',
    skillsShAgentId: 'cursor',
    detect: detectDir(home('.cursor')),
    skillsDir: { global: home('.cursor', 'skills') },
    instructions: {
      files: [
        { path: '.cursor/rules/syntaur-protocol.mdc', renderer: 'cursorProtocol' },
        { path: '.cursor/rules/syntaur-assignment.mdc', renderer: 'cursorAssignment' },
      ],
    },
  },
  {
    // codex is BOTH an adapter (writes AGENTS.md) AND a native plugin.
    id: 'codex',
    displayName: 'Codex',
    skillsShAgentId: 'codex',
    nativePlugin: 'codex',
    detect: detectDir(codexHome()),
    skillsDir: { global: resolve(codexHome(), 'skills') },
    instructions: { files: [{ path: 'AGENTS.md', renderer: 'codexAgents' }] },
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    skillsShAgentId: 'opencode',
    detect: detectDir(home('.config', 'opencode')),
    skillsDir: { global: home('.config', 'opencode', 'skills') },
    instructions: {
      files: [
        { path: 'AGENTS.md', renderer: 'codexAgents' },
        { path: 'opencode.json', renderer: 'openCodeConfig' },
      ],
    },
  },
  {
    // claude has NO adapter today (not in the old SUPPORTED_FRAMEWORKS) — the
    // full plugin path owns its skills/hooks/commands. Native-plugin only.
    id: 'claude',
    displayName: 'Claude Code',
    skillsShAgentId: 'claude-code',
    nativePlugin: 'claude',
    detect: detectDir(home('.claude')),
    skillsDir: { global: home('.claude', 'skills') },
  },
  {
    id: 'pi',
    displayName: 'Pi',
    skillsShAgentId: 'pi',
    detect: detectDir(home('.pi')),
    skillsDir: { global: home('.pi', 'agent', 'skills') },
    instructions: { files: [{ path: 'AGENTS.md', renderer: 'codexAgents' }] },
  },
  {
    id: 'openclaw',
    displayName: 'OpenClaw',
    skillsShAgentId: 'openclaw',
    detect: detectDir(home('.openclaw')),
    skillsDir: { global: home('.openclaw', 'skills') },
    instructions: { files: [{ path: 'AGENTS.md', renderer: 'codexAgents' }] },
  },
  {
    id: 'hermes',
    displayName: 'Hermes Agent',
    skillsShAgentId: 'hermes-agent',
    detect: () => fileExists(hermesHome()),
    skillsDir: { global: hermesSkillsDir() },
    instructions: { files: [{ path: 'SOUL.md', renderer: 'hermesSoul' }] },
  },
];

export const AGENT_TARGETS_BY_ID: Record<string, AgentTarget> = Object.fromEntries(
  AGENT_TARGETS.map((t) => [t.id, t]),
);

export function getAgentTarget(id: string): AgentTarget | undefined {
  return AGENT_TARGETS_BY_ID[id];
}

/** Every Syntaur target id, for validation + help text. */
export function agentTargetIds(): string[] {
  return AGENT_TARGETS.map((t) => t.id);
}

/** Targets that expose a Tier-2 protocol-instruction adapter. */
export function adapterTargets(): AgentTarget[] {
  return AGENT_TARGETS.filter((t) => t.instructions !== undefined);
}

/** Probe the machine and return the subset of targets that appear installed. */
export async function detectInstalledTargets(): Promise<AgentTarget[]> {
  const flags = await Promise.all(AGENT_TARGETS.map((t) => t.detect()));
  return AGENT_TARGETS.filter((_, i) => flags[i]);
}
