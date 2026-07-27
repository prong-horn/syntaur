import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ProbeFn = () => Promise<unknown>;

const defaultProbe: ProbeFn = () =>
  execFileAsync('claude', ['agents', '--json'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });

// Native background-agent support rarely changes over the process lifetime,
// but the probe is a real fork+exec — cache it process-wide, mirroring
// `checkTmuxAvailable` (`src/dashboard/scanner.ts`). Never rejects: any probe
// failure (binary missing, old CLI without `--bg`/`agents --json`) resolves
// to `false` so callers degrade to the tmux path.
let cache: Promise<boolean> | null = null;

export async function checkClaudeBgAvailable(probe: ProbeFn = defaultProbe): Promise<boolean> {
  if (!cache) {
    cache = probe().then(() => true).catch(() => false);
  }
  return cache;
}

/** Test-only: clear the memoized capability probe between cases. */
export function resetClaudeBgAvailableCache(): void {
  cache = null;
}

export type AttachProbeFn = () => Promise<{ stdout: string; stderr?: string }>;

const defaultAttachProbe: AttachProbeFn = async () => {
  try {
    // 15s, not 5s: a cold-start claude (first run after an update, slow disk)
    // can exceed 5s just printing help; a timed-out probe must not silently
    // demote a fully capable claude to the picker fallback.
    return (await execFileAsync('claude', ['attach', '--help'], { timeout: 15000 })) as {
      stdout: string;
      stderr: string;
    };
  } catch (err) {
    // execFile rejects on non-zero exit but still attaches the captured
    // output. Some CLI versions/paths print usage to stderr or exit non-zero
    // for help on a hidden command — the usage TEXT is the capability
    // evidence, not the exit code, so surface whatever was captured and let
    // the matcher decide. A rejection with no usable output matches nothing
    // and resolves false as before.
    const e = err as { stdout?: unknown; stderr?: unknown };
    return { stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
  }
};

let attachCache: Promise<boolean> | null = null;

/**
 * True when the installed claude registers the `attach <id>` subcommand.
 *
 * `claude attach` is a HIDDEN commander command (absent from `claude --help`;
 * present on 2.1.218+, verified 2026-07-27), so the only reliable probe is
 * invoking `claude attach --help` and checking WHICH usage text comes back:
 * a claude that registers it prints `Usage: claude attach <id>`; an older
 * claude prints the GENERAL help (`Usage: claude [options] [command]
 * [prompt]`) because `--help` is handled globally — same exit 0, different
 * text, so we must match the output, not the exit code.
 *
 * This gate matters because claude's CLI treats an unrecognized leading word
 * as the PROMPT: on an old claude, spawning `claude attach <short>` doesn't
 * fail — it silently launches a brand-new session prompted "attach <short>"
 * (user-reported against 0.78.0 from a second machine with an older claude).
 * Callers must fall back to the Agent View picker when this resolves false.
 * Never rejects: probe failure (binary missing, exec error) resolves false.
 */
export async function checkClaudeAttachCommand(probe: AttachProbeFn = defaultAttachProbe): Promise<boolean> {
  if (!attachCache) {
    attachCache = probe()
      .then(({ stdout, stderr }) => /^\s*Usage: claude attach\b/m.test(`${stdout}\n${stderr ?? ''}`))
      .catch(() => false);
  }
  return attachCache;
}

/** Test-only: clear the memoized attach-command probe between cases. */
export function resetClaudeAttachCommandCache(): void {
  attachCache = null;
}
