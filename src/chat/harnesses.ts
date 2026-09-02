/**
 * Harness catalog — the ACP adapters Syntaur can drive.
 *
 * Tier 1 only for phase 2 (design §5.4 describes Buzz's three tiers; presets and
 * custom harnesses are phase 3). Each entry carries the adapter command, how the
 * system prompt reaches the agent, the config-option ids the two adapters use for
 * the same knob, the adapter mode ids behind the three role names a definition may
 * name, an install hint, and an auth probe.
 *
 * Everything here is measured, not assumed — see `scripts/spike/acp/RESULTS.md`:
 * claude honours `_meta.systemPrompt.append` and codex ignores it (a `<system>`
 * section prepended to the first prompt sticks instead); the effort config id is
 * `effort` on claude and `reasoning_effort` on codex; codex routes approvals by
 * mode, so `read-only` is the only mode that asks the client.
 */

import { spawnSync } from 'node:child_process';
import type { Harness, HarnessSpec } from './types.js';

export const HARNESSES: Record<Harness, HarnessSpec> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    command: 'claude-agent-acp',
    args: [],
    systemPromptTransport: 'meta',
    configIds: { model: 'model', effort: 'effort' },
    // `auto` is 0.70.0's current mode; the three role names map to the modes the
    // adapter advertises. `plan` executes no tools.
    modeIds: { edits: 'acceptEdits', ask: 'default', plan: 'plan' },
    installHint: 'npm i -g @agentclientprotocol/claude-agent-acp',
    authProbe: { command: 'claude', args: ['auth', 'status'] },
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    command: 'codex-acp',
    args: [],
    systemPromptTransport: 'prompt',
    configIds: { model: 'model', effort: 'reasoning_effort' },
    // codex-acp 1.7 routes approvals by mode: only `read-only` sends
    // session/request_permission (`agent` hands escalations to Guardian and
    // `agent-full-access` never asks). All three keep a workspace-write sandbox.
    modeIds: { edits: 'agent', ask: 'read-only', plan: 'read-only' },
    installHint: 'npm i -g @agentclientprotocol/codex-acp',
    authProbe: { command: 'codex', args: ['login', 'status'] },
  },
};

export const HARNESS_IDS: readonly Harness[] = Object.keys(HARNESSES) as Harness[];

export function isHarnessId(value: unknown): value is Harness {
  return typeof value === 'string' && value in HARNESSES;
}

export interface CommandResolution {
  /** Absolute path of the resolved binary, or null when it is not on PATH. */
  path: string | null;
  /** The catalog's install hint, set only when `path` is null. */
  installHint: string | null;
}

/**
 * Locate the adapter binary on PATH. Uses `command -v` through the user's shell
 * lookup rather than probing `PATH` by hand so nvm shims resolve the same way the
 * spike harness's `spawn` does.
 */
export function resolveCommand(spec: HarnessSpec): CommandResolution {
  try {
    const res = spawnSync('command', ['-v', spec.command], {
      encoding: 'utf8',
      shell: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const out = (res.stdout ?? '').trim().split('\n')[0]?.trim();
    if (res.status === 0 && out) return { path: out, installHint: null };
  } catch {
    // fall through to the miss
  }
  return { path: null, installHint: spec.installHint };
}

/**
 * Run the harness's auth probe. Only ever called to EXPLAIN a failed
 * `initialize` — never as a gate before spawning (both adapters work off a
 * subscription login and the probes are slow).
 */
export function probeAuth(spec: HarnessSpec): string {
  try {
    const res = spawnSync(spec.authProbe.command, spec.authProbe.args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    // codex prints `login status` on stderr, claude on stdout.
    const text = ((res.stdout ?? '') + (res.stderr ?? '')).trim();
    return redactEmails(text.split('\n').slice(0, 3).join(' ').slice(0, 300));
  } catch (err) {
    return `auth probe failed: ${(err as Error).message}`;
  }
}

/** Auth probe output can carry the account e-mail; never surface it. */
export function redactEmails(s: string): string {
  return s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '[redacted-email]');
}

/**
 * Resolve a definition's `mode` — one of the three role names, or a raw adapter
 * mode id passed through untouched.
 */
export function resolveModeId(spec: HarnessSpec, mode: string): string {
  if (mode === 'edits' || mode === 'ask' || mode === 'plan') return spec.modeIds[mode];
  return mode;
}
