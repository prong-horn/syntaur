// Syntaur Tier-3 enforcement extension for pi-coding-agent (and OpenClaw, which
// runs on pi). Mirrors the Claude Code / Codex bash hooks:
//   - write-boundary enforcement  (pi `tool_call` event → { block, reason })
//   - session cleanup             (pi `session_shutdown` event → mark session stopped)
//   - Syntaur slash commands       (pi `registerCommand`)
//
// SELF-CONTAINED: this file is shipped verbatim into the user's pi extensions dir
// (~/.pi/agent/extensions/syntaur/ or ~/.openclaw/extensions/syntaur/) and loaded by
// pi via jiti. It must NOT import from Syntaur's `src/`. The pure functions are
// exported so Syntaur's vitest suite can verify the boundary logic directly.
//
// pi extension API (researched): `export default (pi) => { pi.on(event, handler);
// pi.registerCommand(name, { description, handler }) }`. The `tool_call` handler
// returns `{ block: true, reason }` to DENY a tool call; any other return allows.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';

export interface SyntaurContext {
  assignmentDir?: string;
  projectDir?: string;
  workspaceRoot?: string;
  sessionId?: string;
  projectSlug?: string;
}

/** Expand a leading `~` to the home dir (the only expansion the bash hooks do). */
function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

/** Read `<cwd>/.syntaur/context.json`; null when absent/unparseable (fail-open). */
export function loadContext(cwd: string): SyntaurContext | null {
  const file = resolve(cwd, '.syntaur', 'context.json');
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  const assignmentDir = str(data.assignmentDir);
  const projectDir = str(data.projectDir);
  const workspaceRoot = str(data.workspaceRoot);
  return {
    assignmentDir: assignmentDir ? expandHome(assignmentDir) : undefined,
    projectDir: projectDir ? expandHome(projectDir) : undefined,
    workspaceRoot: workspaceRoot ? expandHome(workspaceRoot) : undefined,
    sessionId: str(data.sessionId),
    projectSlug: str(data.projectSlug),
  };
}

/** True if `child` is strictly under `parent` (mirrors the bash `"$X"/*` test). */
function isUnder(child: string, parent: string): boolean {
  if (!parent) return false;
  const c = resolve(child);
  const p = resolve(parent);
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

function basename(p: string): string {
  const norm = resolve(p);
  const idx = norm.lastIndexOf(sep);
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

/**
 * Decide whether a write to `absFilePath` is allowed under the active assignment.
 * Mirrors `platforms/claude-code/hooks/enforce-boundaries.sh` exactly:
 *  - allow under assignmentDir
 *  - allow under projectDir/resources/ and projectDir/memories/ EXCEPT derived `_*` files
 *  - allow the `.syntaur/context.json` file itself (caller passes cwd-resolved path)
 *  - allow under workspaceRoot (if set)
 *  - otherwise block
 */
export function isWriteAllowed(
  absFilePath: string,
  ctx: SyntaurContext,
  contextFileAbs?: string,
): { allowed: boolean; reason?: string } {
  // Parity with the bash hook (enforce-boundaries.sh:69): enforcement requires
  // BOTH assignmentDir and projectDir. If either is missing (standalone / old /
  // partially-written context), fail OPEN — allow everything.
  if (!ctx.assignmentDir || !ctx.projectDir) return { allowed: true };

  const file = resolve(absFilePath);

  if (ctx.assignmentDir && isUnder(file, ctx.assignmentDir)) return { allowed: true };

  if (ctx.projectDir) {
    const resourcesDir = resolve(ctx.projectDir, 'resources');
    const memoriesDir = resolve(ctx.projectDir, 'memories');
    for (const dir of [resourcesDir, memoriesDir]) {
      if (isUnder(file, dir) && !basename(file).startsWith('_')) return { allowed: true };
    }
  }

  if (contextFileAbs && file === resolve(contextFileAbs)) return { allowed: true };

  if (ctx.workspaceRoot && isUnder(file, ctx.workspaceRoot)) return { allowed: true };

  const reason =
    `Syntaur write boundary violation: cannot write to '${file}'. Allowed: assignment dir ` +
    `(${ctx.assignmentDir ?? 'n/a'}), project resources/memories, workspace ` +
    `(${ctx.workspaceRoot ?? 'n/a'}).`;
  return { allowed: false, reason };
}

/** pi write-ish tool names (lowercase dialect), matched case-insensitively. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'edit',
  'write',
  'multi_edit',
  'multiedit',
  'create',
  'create_file',
  'str_replace',
  'str_replace_editor',
  'apply_patch',
]);

const PATH_KEYS = ['file_path', 'path', 'filePath', 'filename', 'target_file'];

/** Extract the write target path from a tool call; null if not a write / no path. */
export function extractWritePath(toolName: unknown, input: unknown): string | null {
  if (typeof toolName !== 'string') return null;
  if (!WRITE_TOOLS.has(toolName.toLowerCase())) return null;
  if (typeof input !== 'object' || input === null) return null;
  const obj = input as Record<string, unknown>;
  for (const k of PATH_KEYS) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function resolveAbs(p: string, cwd: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

export interface CoreCommand {
  name: string;
  description: string;
  kind: 'passthrough' | 'guidance';
  /** For `passthrough`: argv passed to the `syntaur` CLI. */
  argv?: string[];
  /** For `guidance`: the installed Tier-1 skill the agent should follow. */
  skill?: string;
}

// Slash commands match the existing CC/Codex bare command names for parity. Only
// `doctor-syntaur` shells out (no required args); the rest point the agent at the
// installed Tier-1 skill, which derives assignment/session from .syntaur/context.json.
export const CORE_COMMANDS: CoreCommand[] = [
  { name: 'doctor-syntaur', description: 'Run `syntaur doctor` diagnostics', kind: 'passthrough', argv: ['doctor'] },
  { name: 'grab-assignment', description: 'Claim a Syntaur assignment into this session', kind: 'guidance', skill: 'grab-assignment' },
  { name: 'log-progress', description: 'Append a progress entry to the active assignment', kind: 'guidance', skill: 'log-progress' },
  { name: 'complete-assignment', description: 'Write a handoff and complete the assignment', kind: 'guidance', skill: 'complete-assignment' },
  { name: 'save-session-summary', description: 'Save a session continuity summary', kind: 'guidance', skill: 'save-session-summary' },
  { name: 'resume-session', description: 'Re-orient on the active assignment', kind: 'guidance', skill: 'resume-session' },
  { name: 'set-workspace', description: 'Set workspace fields on the active assignment', kind: 'guidance', skill: 'set-workspace' },
  { name: 'track-session', description: 'Register this session in the Syntaur dashboard', kind: 'guidance', skill: 'track-session' },
];

function dashboardPort(): string {
  const env = process.env.SYNTAUR_DASHBOARD_PORT;
  if (env && env.length > 0) return env;
  try {
    return readFileSync(resolve(homedir(), '.syntaur', 'dashboard-port'), 'utf-8').trim() || '4800';
  } catch {
    return '4800';
  }
}

/** Mark the dashboard session stopped (best-effort, swallow every error). */
export async function markSessionStopped(ctx: SyntaurContext | null): Promise<void> {
  if (!ctx?.sessionId) return;
  const body = JSON.stringify(
    ctx.projectSlug ? { status: 'stopped', projectSlug: ctx.projectSlug } : { status: 'stopped' },
  );
  try {
    await fetch(`http://127.0.0.1:${dashboardPort()}/api/agent-sessions/${ctx.sessionId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    /* dashboard not running / unreachable — ignore */
  }
}

function notify(ctx: unknown, message: string, level: 'info' | 'error' = 'info'): void {
  const ui = (ctx as { ui?: { notify?: (m: string, l?: string) => void } } | undefined)?.ui;
  if (ui?.notify) {
    try {
      ui.notify(message, level);
      return;
    } catch {
      /* fall through to console */
    }
  }
  // eslint-disable-next-line no-console
  console.log(message);
}

/** pi/OpenClaw extension entry point. */
export default function activate(pi: {
  on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => void;
  registerCommand: (
    name: string,
    spec: { description: string; handler: (args: string, ctx: unknown) => unknown },
  ) => void;
}): void {
  // --- write-boundary enforcement ---
  pi.on('tool_call', (event: unknown) => {
    const e = (event ?? {}) as { toolName?: unknown; input?: unknown };
    const path = extractWritePath(e.toolName, e.input);
    if (!path) return; // not a write → allow
    const cwd = process.cwd();
    const ctx = loadContext(cwd);
    if (!ctx) return; // no active assignment → allow
    const abs = resolveAbs(path, cwd);
    const contextFileAbs = resolve(cwd, '.syntaur', 'context.json');
    const { allowed, reason } = isWriteAllowed(abs, ctx, contextFileAbs);
    if (!allowed) return { block: true, reason };
    return undefined;
  });

  // --- session cleanup ---
  pi.on('session_shutdown', async () => {
    await markSessionStopped(loadContext(process.cwd()));
  });

  // --- slash commands ---
  for (const cmd of CORE_COMMANDS) {
    pi.registerCommand(cmd.name, {
      description: cmd.description,
      handler: async (_args: string, ctx: unknown) => {
        if (cmd.kind === 'passthrough' && cmd.argv) {
          const { spawnSync } = await import('node:child_process');
          const r = spawnSync('syntaur', cmd.argv, { encoding: 'utf-8' });
          notify(ctx, (r.stdout || '') + (r.stderr || '') || `ran: syntaur ${cmd.argv.join(' ')}`);
          return;
        }
        notify(
          ctx,
          `Follow the Syntaur "${cmd.skill}" skill (installed via skills). It derives the active ` +
            `assignment/session from .syntaur/context.json — run its steps to ${cmd.description.toLowerCase()}.`,
        );
      },
    });
  }
}
