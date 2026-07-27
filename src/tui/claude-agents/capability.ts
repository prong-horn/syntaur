import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { accessSync, constants } from 'node:fs';
import { join, delimiter } from 'node:path';

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

/**
 * Every `claude` executable reachable on PATH, deduped, in resolution order.
 * Wrappers/shims (cmux injects `$TMPDIR/cmux-cli-shims/<id>/claude` ahead of
 * the real install) mean "the first claude" and "a claude that supports
 * `attach`" can be DIFFERENT binaries — so capability resolution must
 * consider all of them, not just argv[0]-by-PATH.
 */
export function scanPathForClaude(pathEnv: string | undefined = process.env.PATH): string[] {
  const hits: string[] = [];
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, 'claude');
    if (hits.includes(candidate)) continue;
    try {
      accessSync(candidate, constants.X_OK);
      hits.push(candidate);
    } catch {
      /* not here */
    }
  }
  return hits;
}

export type AttachProbeFn = (binary: string) => Promise<{ stdout: string; stderr?: string }>;

const defaultAttachProbe: AttachProbeFn = async (binary) => {
  try {
    // 15s, not 5s: a cold-start claude (first run after an update, slow disk)
    // can exceed 5s just printing help; a timed-out probe must not silently
    // demote a fully capable claude to the picker fallback.
    return (await execFileAsync(binary, ['attach', '--help'], { timeout: 15000 })) as {
      stdout: string;
      stderr: string;
    };
  } catch (err) {
    // execFile rejects on non-zero exit but still attaches the captured
    // output. Some CLI versions/paths print usage to stderr or exit non-zero
    // for help on a hidden command — the usage TEXT is the capability
    // evidence, not the exit code, so surface whatever was captured and let
    // the matcher decide. A rejection with no usable output matches nothing
    // and is skipped like any non-attach-capable candidate.
    const e = err as { stdout?: unknown; stderr?: unknown };
    return { stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
  }
};

const ATTACH_USAGE = /^\s*Usage: claude attach\b/m;

let attachBinaryCache: Promise<string | null> | null = null;

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
/**
 * The absolute path of a claude binary that registers the hidden `attach <id>`
 * subcommand, or null when none on PATH does.
 *
 * Why per-candidate probing instead of probing bare `claude`: wrapper shims
 * can shadow the real install — root-caused live on a user machine where
 * cmux's CLI shim sat first on PATH and answered `attach --help` with the
 * GENERAL help (it doesn't forward hidden subcommands; `attach <id>` through
 * it opens a brand-new session prompted "attach <id>", the original 0.78.0
 * symptom) while the fully attach-capable real claude sat shadowed one entry
 * below. Probing each candidate and pinning the first that prints
 * `Usage: claude attach` finds the working binary regardless of shims.
 *
 * The usage TEXT is the evidence, not the exit code — general help and attach
 * help both exit 0 (see defaultAttachProbe for the non-zero/stderr salvage).
 * Cached process-wide; never rejects.
 */
export async function resolveClaudeAttachBinary(
  probe: AttachProbeFn = defaultAttachProbe,
  candidates: () => string[] = scanPathForClaude,
): Promise<string | null> {
  if (!attachBinaryCache) {
    attachBinaryCache = (async () => {
      for (const candidate of candidates()) {
        try {
          const { stdout, stderr } = await probe(candidate);
          if (ATTACH_USAGE.test(`${stdout}\n${stderr ?? ''}`)) return candidate;
        } catch {
          /* candidate unusable — try the next */
        }
      }
      return null;
    })();
  }
  return attachBinaryCache;
}

/**
 * True when SOME claude on PATH supports direct attach (see
 * resolveClaudeAttachBinary — callers spawning the attach must use the
 * resolved binary, not bare `claude`, or a shim may swallow the subcommand).
 */
export async function checkClaudeAttachCommand(
  probe: AttachProbeFn = defaultAttachProbe,
  candidates: () => string[] = scanPathForClaude,
): Promise<boolean> {
  return (await resolveClaudeAttachBinary(probe, candidates)) != null;
}

/** Test-only: clear the memoized attach-binary resolution between cases. */
export function resetClaudeAttachCommandCache(): void {
  attachBinaryCache = null;
}
