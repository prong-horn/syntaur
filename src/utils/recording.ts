// Background screen-recording lifecycle helper. Lifts the ffmpeg avfoundation
// pattern from ~/agent-demo-recorder/bin/{start,stop}-rec.sh.
//
// State files live under syntaurRoot() so $SYNTAUR_HOME overrides apply:
//   recording.pid   — atomic lockfile + PID source of truth
//   recording.log   — ffmpeg stdout/stderr, persistent for post-mortem
//   recording.json  — sidecar: assignmentDir/criterionIndex/note/mp4Path for --stop
//
// Tests override `process.env.SYNTAUR_RECORDING_WARMUP_MS=0` to skip the real
// 1.5s post-spawn warm-up wait used to detect macOS Screen Recording
// permission failures.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { syntaurRoot } from './paths.js';
import { isProcessAlive } from '../dashboard/autodiscovery.js';

function sigintPollIntervalMs(): number {
  const raw = process.env.SYNTAUR_RECORDING_POLL_INTERVAL_MS;
  if (raw === undefined) return 500;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

function sigintPollCount(): number {
  const raw = process.env.SYNTAUR_RECORDING_POLL_COUNT;
  if (raw === undefined) return 20; // 20 * 500ms = 10s total bounded wait
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 20;
}

function sigtermWaitMs(): number {
  const raw = process.env.SYNTAUR_RECORDING_SIGTERM_WAIT_MS;
  if (raw === undefined) return 1000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1000;
}

function pidfilePath(): string {
  return resolve(syntaurRoot(), 'recording.pid');
}

function logPath(): string {
  return resolve(syntaurRoot(), 'recording.log');
}

function sidecarPath(): string {
  return resolve(syntaurRoot(), 'recording.json');
}

export interface StartRecordingInput {
  device: string;
  fps: string;
  assignmentDir: string;
  assignmentId: string;
  projectSlug: string | null;
  assignmentSlug: string;
  standalone: boolean;
  criterionIndex: number | null;
  note: string | null;
  warmupMs?: number;
}

export interface StartRecordingResult {
  pid: number;
  logPath: string;
  mp4Path: string;
  sidecarPath: string;
  pidfilePath: string;
}

export interface RecordingSidecar {
  pid: number;
  logPath: string;
  mp4Path: string;
  assignmentDir: string;
  assignmentId: string;
  projectSlug: string | null;
  assignmentSlug: string;
  standalone: boolean;
  criterionIndex: number | null;
  note: string | null;
  startedAt: string;
  device: string;
  fps: string;
}

export interface StopRecordingResult {
  mp4Path: string;
  sidecar: RecordingSidecar;
}

function ffmpegArgs(device: string, fps: string, mp4Path: string): string[] {
  return [
    '-y',
    '-f',
    'avfoundation',
    '-capture_cursor',
    '1',
    '-framerate',
    String(fps),
    '-i',
    `${device}:none`,
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    mp4Path,
  ];
}

function defaultWarmupMs(): number {
  const raw = process.env.SYNTAUR_RECORDING_WARMUP_MS;
  if (raw === undefined) return 1500;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1500;
}

const STARTING_SENTINEL_PREFIX = 'STARTING:';

// Atomically create the pidfile and seed it with a `STARTING:<parentPid>`
// sentinel so a concurrent --start that races during the
// open('wx') → spawn() → writeFile(realPid) window sees an "in progress"
// marker rather than an empty file. The sentinel encodes the parent syntaur
// PID so a crashed-during-startup pidfile (parent gone) is still recoverable
// as stale.
//
// On EEXIST:
//   - Sentinel with a live parent PID → another --start is in progress; throw.
//   - Sentinel with a dead parent PID → orphaned-from-crashed-startup; treat
//     as stale (unlink + retry).
//   - Empty content → a concurrent --start raced and is mid-write; throw.
//   - Numeric PID, alive → recording in progress; throw.
//   - Numeric PID, dead → stale (unlink + retry).
//   - Anything else → surface a clear error so the user can rm manually.
async function acquirePidfile(pidfile: string): Promise<void> {
  const sentinel = `${STARTING_SENTINEL_PREFIX}${process.pid}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(pidfile, 'wx');
      try {
        await handle.write(sentinel);
      } finally {
        await handle.close();
      }
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (attempt === 1) throw err;

      const existing = (await readFile(pidfile, 'utf-8').catch(() => '')).trim();

      if (existing.startsWith(STARTING_SENTINEL_PREFIX)) {
        const parentPidRaw = existing.slice(STARTING_SENTINEL_PREFIX.length);
        const parentPid = Number.parseInt(parentPidRaw, 10);
        if (Number.isInteger(parentPid) && parentPid > 0 && (await isProcessAlive(parentPid))) {
          throw new Error(
            `Recording startup already in progress (parent PID ${parentPid}). Wait a moment and retry, or kill ${parentPid} and remove ${pidfile} manually if it's truly stuck.`,
          );
        }
        // Parent crashed during startup — stale.
        await unlink(pidfile).catch(() => {});
        continue;
      }

      if (existing === '') {
        throw new Error(
          `Recording startup is mid-write (empty pidfile at ${pidfile}). Retry in a moment.`,
        );
      }

      const existingPid = Number.parseInt(existing, 10);
      if (Number.isInteger(existingPid) && existingPid > 0) {
        if (await isProcessAlive(existingPid)) {
          throw new Error(
            `Recording already in progress (PID ${existingPid}). Stop with: syntaur capture --kind video --stop`,
          );
        }
        await unlink(pidfile).catch(() => {});
        continue;
      }

      throw new Error(
        `Pidfile at ${pidfile} contains unexpected content "${existing}". Delete it manually and retry.`,
      );
    }
  }
}

export async function startRecording(input: StartRecordingInput): Promise<StartRecordingResult> {
  if (process.platform !== 'darwin') {
    throw new Error(
      'Video recording via ffmpeg is only available on macOS. Use --file <path> to attach an existing mp4.',
    );
  }

  const root = syntaurRoot();
  await mkdir(root, { recursive: true });

  const pidfile = pidfilePath();
  const log = logPath();
  const sidecar = sidecarPath();
  const warmupMs = input.warmupMs ?? defaultWarmupMs();

  // 1. Acquire pidfile lock (sentinel-seeded; handles stale + concurrent cases).
  await acquirePidfile(pidfile);

  let logHandle: Awaited<ReturnType<typeof open>> | null = null;
  let tmpDir: string | null = null;
  // Once spawn returns a PID, the detached ffmpeg is the new orphan risk.
  // Any failure between here and a successful return must SIGINT/SIGKILL it.
  let acquiredPid: number | null = null;

  try {
    // 2. Truncate the log file and keep an FD open for ffmpeg's stdio.
    logHandle = await open(log, 'w');

    // 3. Allocate tmp dir for the mp4.
    tmpDir = await mkdtemp(join(tmpdir(), 'syntaur-recording-'));
    const mp4Path = join(tmpDir, 'recording.mp4');

    // 4. Spawn ffmpeg detached + unref'd so the parent Node can exit cleanly.
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('ffmpeg', ffmpegArgs(input.device, input.fps, mp4Path), {
        detached: true,
        stdio: ['ignore', logHandle.fd, logHandle.fd],
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('ffmpeg binary not found. Install with: brew install ffmpeg');
      }
      throw err;
    }

    // Capture spawn-time 'error' events (e.g. ENOENT on PATH lookup) before
    // they go unhandled. We resolve as soon as we have a PID; ENOENT
    // typically arrives on the next tick.
    const pidReady = new Promise<number>((resolvePromise, reject) => {
      let settled = false;
      child.once('error', (err) => {
        if (settled) return;
        settled = true;
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error('ffmpeg binary not found. Install with: brew install ffmpeg'));
          return;
        }
        reject(err);
      });
      if (child.pid != null) {
        settled = true;
        resolvePromise(child.pid);
        return;
      }
      child.once('spawn', () => {
        if (settled) return;
        if (child.pid != null) {
          settled = true;
          resolvePromise(child.pid);
        } else {
          settled = true;
          reject(new Error('ffmpeg failed to spawn (no PID assigned)'));
        }
      });
    });

    const pid = await pidReady;
    acquiredPid = pid;
    child.unref();

    // 5. Overwrite the sentinel with the real PID. writeFile opens its own fd,
    // truncating in one operation, so concurrent readers see either the
    // sentinel or the final PID — never a partial mix.
    await writeFile(pidfile, String(pid));
    await logHandle.close();
    logHandle = null;

    // 6. Warm-up wait: if ffmpeg dies during this window it's almost always a
    // macOS Screen Recording permission issue.
    if (warmupMs > 0) await sleep(warmupMs);
    if (!(await isProcessAlive(pid))) {
      const tail = await readFile(log, 'utf-8')
        .then((s) => s.split('\n').slice(-20).join('\n'))
        .catch(() => '');
      // The child is already dead — clear acquiredPid so the catch block
      // doesn't try to kill it again.
      acquiredPid = null;
      throw new Error(
        `ffmpeg exited during startup — likely macOS Screen Recording permission missing. ` +
          `Grant access to your terminal in System Settings → Privacy & Security → Screen Recording, then retry. ` +
          `Log: ${log}\n--- tail ---\n${tail}`,
      );
    }

    // 7. Write sidecar JSON (after warm-up passes).
    const sidecarData: RecordingSidecar = {
      pid,
      logPath: log,
      mp4Path,
      assignmentDir: input.assignmentDir,
      assignmentId: input.assignmentId,
      projectSlug: input.projectSlug,
      assignmentSlug: input.assignmentSlug,
      standalone: input.standalone,
      criterionIndex: input.criterionIndex,
      note: input.note,
      startedAt: new Date().toISOString(),
      device: input.device,
      fps: input.fps,
    };
    await writeFile(sidecar, JSON.stringify(sidecarData, null, 2));

    return {
      pid,
      logPath: log,
      mp4Path,
      sidecarPath: sidecar,
      pidfilePath: pidfile,
    };
  } catch (err) {
    // Cleanup on any post-acquire failure. Order matters: kill the orphan
    // ffmpeg BEFORE removing the pidfile, so a concurrent --stop racing in
    // can still find the PID. The log file is intentionally preserved.
    if (acquiredPid !== null) {
      try {
        process.kill(acquiredPid, 'SIGINT');
      } catch {
        /* already gone */
      }
      // Brief wait for a graceful exit, then SIGKILL if needed. We don't run
      // the full SIGTERM escalation here — this is best-effort cleanup.
      await sleep(100);
      if (await isProcessAlive(acquiredPid)) {
        try {
          process.kill(acquiredPid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
    if (logHandle) await logHandle.close().catch(() => {});
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await unlink(pidfile).catch(() => {});
    throw err;
  }
}

export async function stopRecording(): Promise<StopRecordingResult> {
  const pidfile = pidfilePath();
  const sidecar = sidecarPath();

  const pidRaw = await readFile(pidfile, 'utf-8').catch(() => null);
  if (pidRaw === null) {
    throw new Error(
      `No active recording found (no pidfile at ${pidfile}). Did you run --start?`,
    );
  }
  const pid = Number.parseInt(pidRaw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Pidfile at ${pidfile} is corrupt (got "${pidRaw}").`);
  }

  const sidecarRaw = await readFile(sidecar, 'utf-8').catch(() => null);
  if (sidecarRaw === null) {
    throw new Error(
      `No recording sidecar at ${sidecar}. The recording state is inconsistent — delete ${pidfile} and re-run --start.`,
    );
  }
  let sidecarData: RecordingSidecar;
  try {
    sidecarData = JSON.parse(sidecarRaw) as RecordingSidecar;
  } catch (err) {
    throw new Error(
      `Recording sidecar at ${sidecar} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Signal escalation: SIGINT → bounded poll → SIGTERM → wait → SIGKILL.
  try {
    process.kill(pid, 'SIGINT');
  } catch {
    /* already gone */
  }

  const pollIntervalMs = sigintPollIntervalMs();
  const pollCount = sigintPollCount();
  const termWaitMs = sigtermWaitMs();

  let alive = await isProcessAlive(pid);
  for (let i = 0; alive && i < pollCount; i += 1) {
    await sleep(pollIntervalMs);
    alive = await isProcessAlive(pid);
  }

  if (alive) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    await sleep(termWaitMs);
    alive = await isProcessAlive(pid);
  }

  if (alive) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    await sleep(termWaitMs);
    alive = await isProcessAlive(pid);
  }

  if (alive) {
    throw new Error(`ffmpeg (PID ${pid}) refused to die after SIGKILL`);
  }

  // Validate the mp4 was actually produced.
  const st = await stat(sidecarData.mp4Path).catch(() => null);
  if (st === null || st.size === 0) {
    // Pidfile + sidecar still cleaned so the user can retry --start.
    await unlink(pidfile).catch(() => {});
    await unlink(sidecar).catch(() => {});
    throw new Error(
      `ffmpeg produced no output at ${sidecarData.mp4Path}. Check ${sidecarData.logPath} for errors.`,
    );
  }

  // Cleanup state files. The mp4 (and its tmp dir) is the caller's
  // responsibility — they will copy it into proof/ and then rm the tmp dir.
  await unlink(pidfile).catch(() => {});
  await unlink(sidecar).catch(() => {});

  return { mp4Path: sidecarData.mp4Path, sidecar: sidecarData };
}
