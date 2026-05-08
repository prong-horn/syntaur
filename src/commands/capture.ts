import { resolve, relative } from 'node:path';
import { copyFile, mkdir, realpath, stat } from 'node:fs/promises';
import { resolveAssignmentTarget } from '../utils/assignment-target.js';
import { proofDir } from '../utils/paths.js';
import {
  generateArtifactId,
  extensionForKind,
  isArtifactKind,
  ARTIFACT_KINDS,
} from '../utils/proof-artifact-id.js';
import { fileExists } from '../utils/fs.js';
import { initProofDb, insertArtifact, getArtifactById, type ArtifactKind } from '../db/proof-db.js';

export interface CaptureOptions {
  kind?: string;
  file?: string;
  criterion?: string | number;
  note?: string;
  project?: string;
  dir?: string;
  cwd?: string;
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

  // Per-kind file/note rules.
  if (kind === 'text') {
    if (options.file) {
      throw new Error('--kind=text forbids --file. Use --note for text payloads.');
    }
    if (!options.note || options.note.trim() === '') {
      throw new Error('--kind=text requires --note.');
    }
  } else {
    if (kind !== 'http' && !options.file) {
      throw new Error(`--kind=${kind} requires --file.`);
    }
    // http allows either --file (transcript) or --note. If neither, the
    // captured artifact is empty, which is rarely useful — reject it.
    if (kind === 'http' && !options.file && (!options.note || options.note.trim() === '')) {
      throw new Error('--kind=http requires --file or --note (one or the other).');
    }
  }

  const criterionIndex = normalizeCriterionIndex(options.criterion);

  // Resolve assignment target (--project + slug, bare UUID, or context.json fallback).
  const resolved = await resolveAssignmentTarget(target, {
    project: options.project,
    dir: options.dir,
    cwd: options.cwd,
  });

  // Validate --file before copying anything.
  let resolvedSource: string | null = null;
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
  }

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
        note: options.note ?? null,
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
    await copyFile(resolvedSource, absPath);
  }

  const ref = resolved.standalone ? resolved.id : `${resolved.projectSlug}/${resolved.assignmentSlug}`;
  const tagSuffix = criterionIndex === null ? 'untagged' : `criterion ${criterionIndex}`;
  console.log(`Captured artifact ${id} (${kind}) for ${ref} — ${tagSuffix}.`);
  if (relativeFilePath) {
    console.log(`  file: ${resolve(resolved.assignmentDir, relativeFilePath)}`);
  }
}
