/**
 * Session profile — the ONE place session policy lives (§5.11, Decision 5).
 *
 * A chat session gets exactly what the same agent would get if it were launched
 * by hand in the worktree: the user's `~/.claude/settings.json` /
 * `~/.codex/config.toml`, their MCP servers, their model and effort. Every field
 * defaults to `inherit`; only what an agent definition explicitly sets is pinned,
 * and only pinned fields are applied.
 *
 * The measured price of inheriting is ~37 k tokens of standing context per claude
 * session (~23 k on codex) plus a forked copy of every configured MCP server per
 * live session. Phase 2 builds the seam, not the policy — shipping it costs a few
 * lines, retrofitting it means threading a parameter through the broker, the
 * persisted row and the UI.
 */

import type { AcpClient } from './acp-client.js';
import { resolveModeId } from './harnesses.js';
import {
  INHERIT,
  pin,
  type AgentDefinition,
  type AppliedProfile,
  type HarnessSpec,
  type SessionProfile,
  type CwdTier,
} from './types.js';

/** Every field inherits unless the definition sets it. */
export function inheritedProfile(): SessionProfile {
  return {
    mode: INHERIT,
    model: INHERIT,
    effort: INHERIT,
    settingSources: INHERIT,
    mcpServers: INHERIT,
    env: INHERIT,
  };
}

export function resolveSessionProfile(
  definition: AgentDefinition,
  _harness: HarnessSpec,
): SessionProfile {
  return {
    mode: definition.mode ? pin(definition.mode) : INHERIT,
    model: definition.model ? pin(definition.model) : INHERIT,
    effort: definition.effort ? pin(definition.effort) : INHERIT,
    // No definition field drives `settingSources` yet; pinning it is what a
    // future "isolated chat" profile would set, and the seam is here for it.
    settingSources: INHERIT,
    mcpServers: definition.mcpServers ? pin(definition.mcpServers) : INHERIT,
    env: definition.env ? pin(definition.env) : INHERIT,
  };
}

export interface NewSessionMeta {
  _meta?: Record<string, unknown>;
  /** What `session/new` should carry as `mcpServers` — `[]` unless pinned. */
  mcpServers: unknown[];
}

/**
 * Build `session/new`'s `_meta` and `mcpServers`.
 *
 * `_meta.systemPrompt.append` is honoured by claude-agent-acp and ignored by
 * codex-acp (RESULTS.md §"System prompt (03)"), which is why the catalog carries
 * a `systemPromptTransport` and codex gets a `<system>` block on its first prompt
 * instead. `claudeCode.options.settingSources` is sent only when pinned —
 * sending it at all changes what the session inherits.
 */
export function newSessionMeta(
  profile: SessionProfile,
  harness: HarnessSpec,
  systemPrompt: string,
): NewSessionMeta {
  const meta: Record<string, unknown> = {};

  if (harness.systemPromptTransport === 'meta' && systemPrompt.trim().length > 0) {
    meta.systemPrompt = { append: systemPrompt };
  }
  if (harness.id === 'claude' && profile.settingSources.kind === 'pinned') {
    meta.claudeCode = { options: { settingSources: profile.settingSources.value } };
  }

  return {
    ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
    // MCP servers named by a definition are client-provided servers; nothing is
    // requested when the profile inherits (the adapter still boots the user's).
    mcpServers: profile.mcpServers.kind === 'pinned' ? [...profile.mcpServers.value] : [],
  };
}

/**
 * Apply the pinned fields to a live session: mode first (it changes what the
 * other options mean), then model, then effort. Returns what was actually
 * applied so it can be recorded on the `session.created` event.
 *
 * A rejected option is not fatal — the adapter's mode/config ids drift between
 * releases (`dontAsk` is advertised by the installed 0.70.0 dist and absent from
 * its main branch), so a failure is reported and the session carries on with the
 * inherited value.
 */
export async function applyProfile(
  client: AcpClient,
  sessionId: string,
  profile: SessionProfile,
  harness: HarnessSpec,
): Promise<{ applied: AppliedProfile; errors: string[] }> {
  const applied: AppliedProfile = {};
  const errors: string[] = [];

  if (profile.mode.kind === 'pinned') {
    const modeId = resolveModeId(harness, profile.mode.value);
    try {
      await client.setMode(sessionId, modeId);
      applied.mode = modeId;
    } catch (err) {
      errors.push(`mode ${modeId}: ${(err as Error).message}`);
    }
  }
  if (profile.model.kind === 'pinned') {
    try {
      await client.setConfigOption(sessionId, harness.configIds.model, profile.model.value);
      applied.model = profile.model.value;
    } catch (err) {
      errors.push(`${harness.configIds.model} ${profile.model.value}: ${(err as Error).message}`);
    }
  }
  if (profile.effort.kind === 'pinned') {
    if (harness.configIds.effort) {
      try {
        await client.setConfigOption(sessionId, harness.configIds.effort, profile.effort.value);
        applied.effort = profile.effort.value;
      } catch (err) {
        errors.push(`${harness.configIds.effort} ${profile.effort.value}: ${(err as Error).message}`);
      }
    } else {
      errors.push(`effort ${profile.effort.value}: ignored — ${harness.label} has no effort config id`);
    }
  }

  return { applied, errors };
}

/** Environment overrides for the spawn — pinned only, never the whole env. */
export function profileEnv(profile: SessionProfile): Record<string, string> {
  return profile.env.kind === 'pinned' ? { ...profile.env.value } : {};
}

/** JSON for `chat_sessions.profile_json`. */
export function serializeProfile(profile: SessionProfile): string {
  return JSON.stringify(profile);
}

export function parseProfile(json: string | null): SessionProfile | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as SessionProfile;
  } catch {
    return null;
  }
}

/**
 * The profile a session actually runs with at a given cwd tier. At the `home`
 * tier a definition with no pinned mode opens in the read-only `ask` role:
 * codex's `agent` mode auto-approves inside a sandbox whose root would be the
 * whole home directory. Pure — the session's own profile is never mutated, so
 * a worktree created later gets the definition's mode back.
 */
export function profileForTier(profile: SessionProfile, tier: CwdTier | null): SessionProfile {
  if (tier === 'home' && profile.mode.kind === 'inherit') {
    return { ...profile, mode: pin('ask') };
  }
  return profile;
}

/**
 * Stage dispatch requires every pinned field to apply before a turn starts.
 * Ordinary chat keeps the softer applyProfile behaviour.
 */
export function verifyPinnedProfileApplied(
  profile: SessionProfile,
  applied: AppliedProfile,
  harness: HarnessSpec,
): string[] {
  const errors: string[] = [];
  if (profile.mode.kind === 'pinned') {
    const expected = resolveModeId(harness, profile.mode.value);
    if (applied.mode !== expected) {
      errors.push(`mode ${expected} was not applied`);
    }
  }
  if (profile.model.kind === 'pinned' && applied.model !== profile.model.value) {
    errors.push(`${harness.configIds.model} ${profile.model.value} was not applied`);
  }
  if (profile.effort.kind === 'pinned') {
    if (!harness.configIds.effort) {
      errors.push(`effort ${profile.effort.value}: ignored — ${harness.label} has no effort config id`);
    } else if (applied.effort !== profile.effort.value) {
      errors.push(`${harness.configIds.effort} ${profile.effort.value} was not applied`);
    }
  }
  return errors;
}
