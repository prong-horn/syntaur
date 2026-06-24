import { resolve, relative, dirname } from 'node:path';
import { copyFile, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolveAssignmentTarget } from '../utils/assignment-target.js';
import { resolveSessionEngagement } from '../utils/engagement-binding.js';
import { assertMayMutate } from '../utils/session-id.js';
import { initSessionDb } from '../dashboard/session-db.js';
import { proofDir } from '../utils/paths.js';
import {
  generateArtifactId,
  extensionForKind,
  isArtifactKind,
  ARTIFACT_KINDS,
} from '../utils/proof-artifact-id.js';
import { fileExists } from '../utils/fs.js';
import { captureScreenshot, type ScreenshotMode } from '../utils/screencapture.js';
import { captureAsciinema } from '../utils/asciinema.js';
import { startRecording, stopRecording } from '../utils/recording.js';
import type { ResolvedAssignment } from '../utils/assignment-resolver.js';
import { initProofDb, insertArtifact, type ArtifactKind } from '../db/proof-db.js';
import {
  getTranscriber,
  TranscribeFfmpegError,
  TranscribeFfmpegMissingError,
  TranscribeNoAudioError,
} from '../utils/transcribers/index.js';
import { groupIntoPhrases, renderMarkdown } from '../utils/transcribers/pack.js';

export interface CaptureOptions {
  kind?: string;
  file?: string;
  criterion?: string | number;
  note?: string;
  project?: string;
  dir?: string;
  cwd?: string;
  interactive?: boolean;
  window?: boolean;
  fullscreen?: boolean;
  commandArgv?: string[];
  start?: boolean;
  stop?: boolean;
  device?: string;
  fps?: string;
  transcribe?: boolean;
}

const MAX_ID_RETRIES = 5;

function normalizeCriterionIndex(raw: string | number | undefined): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 0) {
      throw new Error(`--criterion must be a non-negative integer (got "${raw}")`);
    }
    return raw;
  }
  // Strings must be all digits — `parseInt` would silently accept "1foo" or "1.5".
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) {
    throw new Error(`--criterion must be a non-negative integer (got "${raw}")`);
  }
  return parseInt(s, 10);
}

function isUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string };
  if (e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || e.code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
  if (e.code === 'SQLITE_CONSTRAINT' && /UNIQUE|PRIMARY KEY/i.test(e.message ?? '')) return true;
  return false;
}

/**
 * Resolve the capture's artifact-filing target with ambient-vs-targeted
 * semantics. An explicit target (positional / `--project`) files the artifact
 * against B via Cases 1/2; with no explicit target it files against the
 * session's OPEN engagement A. Capture NEVER opens or switches an engagement and
 * never charges tokens — interval-based usage attribution (usage/session-join)
 * charges whichever engagement is open (the ambient A), so filing against an
 * explicit B leaves token/stage attribution on A. The mutation is gated:
 * a WEAK-provenance session with no explicit selector is refused
 * (fail-with-selector), per the no-session/ambiguous acceptance criterion.
 */
async function resolveCaptureTarget(
  target: string | undefined,
  options: CaptureOptions,
): Promise<ResolvedAssignment> {
  const cwd = options.cwd ?? process.cwd();
  // getOpenEngagement reads the session DB; ensure it is open (idempotent).
  initSessionDb();
  const se = await resolveSessionEngagement(cwd);
  if (se) {
    assertMayMutate(se.session, {
      hasSelector: Boolean(target) || Boolean(options.project),
    });
  }
  return resolveAssignmentTarget(target, {
    project: options.project,
    dir: options.dir,
    cwd,
    resolveEngagement: async () => se?.open ?? null,
  });
}

export async function captureCommand(
  target: string | undefined,
  options: CaptureOptions = {},
): Promise<void> {
  // Validate kind first so the error is the most meaningful one for malformed input.
  if (!options.kind) {
    throw new Error(
      `--kind is required. Must be one of: ${ARTIFACT_KINDS.join(', ')}.`,
    );
  }
  if (!isArtifactKind(options.kind)) {
    throw new Error(
      `Invalid --kind "${options.kind}". Must be one of: ${ARTIFACT_KINDS.join(', ')}.`,
    );
  }
  const kind: ArtifactKind = options.kind;

  // Shellout flags. --interactive is valid for screenshot OR asciinema;
  // --window and --fullscreen remain screenshot-only.
  const shelloutFlagCount = [
    options.interactive,
    options.window,
    options.fullscreen,
  ].filter(Boolean).length;
  if (shelloutFlagCount > 1) {
    throw new Error('--interactive, --window, --fullscreen are mutually exclusive.');
  }
  if ((options.window || options.fullscreen) && kind !== 'screenshot') {
    throw new Error('--window and --fullscreen require --kind=screenshot.');
  }
  if (options.interactive && kind !== 'screenshot' && kind !== 'asciinema') {
    throw new Error(
      '--interactive requires --kind=screenshot or --kind=asciinema.',
    );
  }
  if (options.file && (options.interactive || options.window || options.fullscreen)) {
    throw new Error(
      '--file cannot be combined with --interactive, --window, or --fullscreen.',
    );
  }
  if (options.file && (options.commandArgv?.length ?? 0) > 0) {
    throw new Error(
      '--file cannot be combined with a trailing -- <command>.',
    );
  }
  if ((options.commandArgv?.length ?? 0) > 0 && kind !== 'asciinema') {
    throw new Error('A trailing -- <command> is only valid with --kind=asciinema.');
  }
  if (options.interactive && (options.commandArgv?.length ?? 0) > 0) {
    throw new Error('--interactive and a trailing -- <command> are mutually exclusive.');
  }

  const screenshotShelloutMode: ScreenshotMode | null =
    kind === 'screenshot'
      ? options.interactive
        ? 'interactive'
        : options.window
          ? 'window'
          : options.fullscreen
            ? 'fullscreen'
            : null
      : null;

  const wantsAsciinemaShellout =
    kind === 'asciinema' &&
    (options.interactive === true || (options.commandArgv?.length ?? 0) > 0);

  // Video-mode shellout (start/stop lifecycle).
  if (options.start && options.stop) {
    throw new Error('--start and --stop are mutually exclusive.');
  }
  const videoShellout = Boolean(options.start || options.stop);
  if (videoShellout && kind !== 'video') {
    throw new Error('--start/--stop require --kind=video.');
  }
  if (videoShellout && (screenshotShelloutMode || wantsAsciinemaShellout)) {
    throw new Error('--start/--stop cannot be combined with screenshot or asciinema mode flags.');
  }
  if (videoShellout && options.file) {
    throw new Error('--file cannot be combined with --start/--stop.');
  }
  if ((options.device != null || options.fps != null) && !options.start) {
    throw new Error('--device/--fps require --start.');
  }
  if (options.transcribe && kind !== 'video') {
    throw new Error('--transcribe is only valid with --kind=video.');
  }

  // --start branch: spawn ffmpeg, write pidfile + sidecar, return. No DB row
  // is created here; --stop owns the artifact insertion.
  if (options.start) {
    const resolvedStart = await resolveCaptureTarget(target, options);
    if (!resolvedStart.id || resolvedStart.id.trim() === '') {
      throw new Error(
        `Resolved assignment is missing a frontmatter \`id\`: ${resolvedStart.assignmentDir}. Cannot record artifact.`,
      );
    }
    const startCriterionIndex = normalizeCriterionIndex(options.criterion);

    const { pid, logPath: logP } = await startRecording({
      device: options.device ?? '1',
      fps: options.fps ?? '30',
      assignmentDir: resolvedStart.assignmentDir,
      assignmentId: resolvedStart.id,
      projectSlug: resolvedStart.projectSlug,
      assignmentSlug: resolvedStart.assignmentSlug,
      standalone: resolvedStart.standalone,
      criterionIndex: startCriterionIndex,
      note: options.note ?? null,
    });

    console.log('Recording started.');
    console.log(`  PID: ${pid}`);
    console.log(`  Log: ${logP}`);
    console.log('  Stop with: syntaur capture --kind video --stop');
    return;
  }

  // Per-kind file/note rules.
  if (kind === 'text') {
    if (options.file) {
      throw new Error('--kind=text forbids --file. Use --note for text payloads.');
    }
    if (!options.note || options.note.trim() === '') {
      throw new Error('--kind=text requires --note.');
    }
  } else {
    if (
      kind !== 'http' &&
      !options.file &&
      !screenshotShelloutMode &&
      !wantsAsciinemaShellout &&
      !videoShellout
    ) {
      throw new Error(`--kind=${kind} requires --file.`);
    }
    // http allows either --file (transcript) or --note. If neither, the
    // captured artifact is empty, which is rarely useful — reject it.
    if (kind === 'http' && !options.file && (!options.note || options.note.trim() === '')) {
      throw new Error('--kind=http requires --file or --note (one or the other).');
    }
  }

  let criterionIndex = normalizeCriterionIndex(options.criterion);

  // --stop branch: read sidecar, finalize ffmpeg, route the mp4 through the
  // existing attach pipeline. Bypasses cwd-based assignment resolution.
  let resolved: ResolvedAssignment;
  let resolvedSource: string | null = null;
  let shelloutCleanup: (() => Promise<void>) | null = null;
  let stopNote: string | null = null;
  if (options.stop) {
    const { mp4Path, sidecar } = await stopRecording();
    resolved = {
      assignmentDir: sidecar.assignmentDir,
      projectSlug: sidecar.projectSlug,
      assignmentSlug: sidecar.assignmentSlug,
      id: sidecar.assignmentId,
      standalone: sidecar.standalone,
      workspaceGroup: null,
    };
    criterionIndex = sidecar.criterionIndex;
    stopNote = sidecar.note;
    resolvedSource = mp4Path;
    const mp4TmpDir = dirname(mp4Path);
    shelloutCleanup = async () => {
      await rm(mp4TmpDir, { recursive: true, force: true }).catch(() => {});
    };
  } else {
    // Resolve the artifact-filing target: explicit (--project + slug / bare UUID)
    // files against B; ambient files against the session's open engagement A.
    resolved = await resolveCaptureTarget(target, options);
  }

  // Validate --file before copying anything.
  if (options.file) {
    const expanded = options.file.startsWith('~/')
      ? resolve(process.env.HOME ?? '', options.file.slice(2))
      : resolve(options.file);
    if (!(await fileExists(expanded))) {
      throw new Error(`--file does not exist: ${options.file}`);
    }
    let real: string;
    try {
      real = await realpath(expanded);
    } catch (e) {
      throw new Error(
        `--file is unreadable: ${options.file} (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    const st = await stat(real);
    if (!st.isFile()) {
      throw new Error(`--file is not a regular file: ${options.file}`);
    }
    resolvedSource = real;
  } else if (wantsAsciinemaShellout) {
    // SIGINT handling lives inside captureAsciinema: it installs a no-op
    // listener so Ctrl-C in the recorded TTY does not kill the parent before
    // asciinema finalizes the cast. Any cast bytes already recorded survive,
    // and the standard content-based success check decides attach vs. throw.
    const result = await captureAsciinema({
      commandArgv: options.commandArgv ?? [],
    });
    resolvedSource = result.castPath;
    shelloutCleanup = result.cleanup;
    if (result.nonZeroExit) {
      console.warn(
        `Note: asciinema exited ${result.exitCode}, but the cast contains recorded events — attaching it.`,
      );
    }
  } else if (screenshotShelloutMode) {
    const { pngPath, cleanup } = await captureScreenshot(screenshotShelloutMode);
    resolvedSource = pngPath;
    shelloutCleanup = cleanup;
  }

  try {
    // The assignment id is the DB partition key; refuse to write with an empty one.
    if (!resolved.id || resolved.id.trim() === '') {
      throw new Error(
        `Resolved assignment is missing a frontmatter \`id\`: ${resolved.assignmentDir}. Cannot record artifact.`,
      );
    }

    // Initialize the DB (no-op after first call).
    initProofDb();

    // Build destination directory: <assignmentDir>/proof/<criterion-or-untagged>/.
    const subdir = criterionIndex === null ? 'untagged' : String(criterionIndex);
    const destDir = resolve(proofDir(resolved.assignmentDir), subdir);

    // Insert-with-retry on UNIQUE conflict. The id space (1ms timestamp + 16
    // random bits) makes collisions astronomically unlikely; the loop is for
    // theoretical safety against same-millisecond concurrent writers and acts
    // as the source of truth, replacing the racey check-then-act pattern.
    if (resolvedSource) await mkdir(destDir, { recursive: true });
    const ext = resolvedSource ? extensionForKind(kind) : null;

    let id: string | null = null;
    let relativeFilePath: string | null = null;
    let absPath: string | null = null;
    let lastErr: unknown = null;

    for (let attempt = 0; attempt < MAX_ID_RETRIES; attempt += 1) {
      const candidate = generateArtifactId();
      const candidateAbsPath = resolvedSource && ext ? resolve(destDir, `${candidate}.${ext}`) : null;
      const candidateRel = candidateAbsPath ? relative(resolved.assignmentDir, candidateAbsPath) : null;

      try {
        insertArtifact({
          id: candidate,
          assignmentId: resolved.id,
          assignmentDir: resolved.assignmentDir,
          criterionIndex,
          kind,
          filePath: candidateRel,
          note: stopNote ?? options.note ?? null,
        });
        id = candidate;
        absPath = candidateAbsPath;
        relativeFilePath = candidateRel;
        break;
      } catch (e) {
        if (isUniqueConstraintError(e)) {
          lastErr = e;
          continue;
        }
        throw e;
      }
    }

    if (!id) {
      throw new Error(
        `Failed to generate a unique artifact id after ${MAX_ID_RETRIES} attempts: ${
          lastErr instanceof Error ? lastErr.message : String(lastErr)
        }`,
      );
    }

    // File copy comes after the DB insert succeeded. If the file copy fails the
    // DB row is left orphaned (rare; surfaces clearly to the user). Doing it
    // this way means we never copy bytes to disk and then discover a DB
    // collision.
    if (resolvedSource && absPath) {
      try {
        await copyFile(resolvedSource, absPath);
      } catch (err) {
        if (shelloutCleanup) {
          const label =
            kind === 'video' ? 'Recording' : kind === 'asciinema' ? 'Asciicast' : 'Screenshot';
          console.error(
            `${label} saved at ${resolvedSource} — DB row inserted but copy to proof dir failed. Recover with: mv ${resolvedSource} ${absPath}`,
          );
          shelloutCleanup = null;
        }
        throw err;
      }
    }

    // Transcription is opt-in (--transcribe), video-only, never rolls back the
    // artifact: any failure becomes a console.warn and the captured mp4 is
    // preserved as proof.
    if (options.transcribe && kind === 'video' && absPath && id) {
      const sidecarPath = resolve(destDir, `${id}.transcript.md`);
      if (existsSync(sidecarPath)) {
        console.warn(
          `transcript: ${sidecarPath} already exists, skipping (delete to re-transcribe)`,
        );
      } else {
        try {
          const json = await getTranscriber().transcribe(absPath);
          const md = renderMarkdown(groupIntoPhrases(json.words ?? []));
          await writeFile(sidecarPath, md, 'utf8');
          console.log(`transcript: ${sidecarPath}`);
        } catch (err) {
          if (err instanceof TranscribeFfmpegMissingError) {
            console.warn(
              "transcript skipped: ffmpeg not found — install via 'brew install ffmpeg'",
            );
          } else if (err instanceof TranscribeNoAudioError) {
            console.warn('transcript skipped: video has no audio track');
          } else if (err instanceof TranscribeFfmpegError) {
            console.warn(`transcript skipped: ${err.message}`);
          } else {
            console.warn(
              `transcript skipped: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }

    const ref = resolved.standalone ? resolved.id : `${resolved.projectSlug}/${resolved.assignmentSlug}`;
    const tagSuffix = criterionIndex === null ? 'untagged' : `criterion ${criterionIndex}`;
    console.log(`Captured artifact ${id} (${kind}) for ${ref} — ${tagSuffix}.`);
    if (relativeFilePath) {
      console.log(`  file: ${resolve(resolved.assignmentDir, relativeFilePath)}`);
    }
  } catch (err) {
    // For the video --stop path, any post-stopRecording failure (mkdir,
    // insertArtifact, id-retry exhaustion, copyFile, ...) is a chance to lose
    // a recording that may represent minutes of user state. The pidfile + sidecar
    // have already been removed by stopRecording, so this is the only window
    // where we can preserve the mp4 for manual recovery. The inner copyFile
    // catch already handled its case (shelloutCleanup is null there) — this
    // outer catch covers every other failure.
    if (options.stop && kind === 'video' && shelloutCleanup && resolvedSource) {
      const ref = resolved.standalone
        ? resolved.id
        : `${resolved.projectSlug}/${resolved.assignmentSlug}`;
      const projectFlag = resolved.standalone ? '' : `--project ${resolved.projectSlug} `;
      const target = resolved.standalone ? resolved.id : resolved.assignmentSlug;
      console.error(
        `Recording saved at ${resolvedSource} — finalization failed but the mp4 is preserved. ` +
          `Re-attach with: syntaur capture --kind video ${projectFlag}--file ${resolvedSource} ${target} (assignment ${ref})`,
      );
      shelloutCleanup = null;
    }
    throw err;
  } finally {
    if (shelloutCleanup) {
      await shelloutCleanup();
      shelloutCleanup = null;
    }
  }
}
