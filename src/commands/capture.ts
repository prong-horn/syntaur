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
  const parsed = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--criterion must be a non-negative integer (got "${raw}")`);
  }
  return parsed;
}

async function pickUniqueDestination(
  destDir: string,
  ext: string,
): Promise<{ id: string; absPath: string }> {
  for (let attempt = 0; attempt < MAX_ID_RETRIES; attempt += 1) {
    const id = generateArtifactId();
    const absPath = resolve(destDir, `${id}.${ext}`);
    const dbCollision = getArtifactById(id);
    const fsCollision = await fileExists(absPath);
    if (!dbCollision && !fsCollision) {
      return { id, absPath };
    }
  }
  throw new Error('Failed to generate a unique artifact id after several attempts.');
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

  // Initialize the DB (no-op after first call).
  initProofDb();

  // Build destination directory: <assignmentDir>/proof/<criterion-or-untagged>/.
  const subdir = criterionIndex === null ? 'untagged' : String(criterionIndex);
  const destDir = resolve(proofDir(resolved.assignmentDir), subdir);

  let id: string;
  let relativeFilePath: string | null = null;

  if (resolvedSource) {
    await mkdir(destDir, { recursive: true });
    const ext = extensionForKind(kind);
    const picked = await pickUniqueDestination(destDir, ext);
    id = picked.id;
    await copyFile(resolvedSource, picked.absPath);
    relativeFilePath = relative(resolved.assignmentDir, picked.absPath);
  } else {
    // Note-only artifact (text, or http with --note). No file written; still
    // pick a unique id against the DB.
    let candidate: string | null = null;
    for (let attempt = 0; attempt < MAX_ID_RETRIES; attempt += 1) {
      const trial = generateArtifactId();
      if (!getArtifactById(trial)) {
        candidate = trial;
        break;
      }
    }
    if (!candidate) {
      throw new Error('Failed to generate a unique artifact id after several attempts.');
    }
    id = candidate;
  }

  insertArtifact({
    id,
    assignmentId: resolved.id,
    assignmentDir: resolved.assignmentDir,
    criterionIndex,
    kind,
    filePath: relativeFilePath,
    note: options.note ?? null,
  });

  const ref = resolved.standalone ? resolved.id : `${resolved.projectSlug}/${resolved.assignmentSlug}`;
  const tagSuffix = criterionIndex === null ? 'untagged' : `criterion ${criterionIndex}`;
  console.log(`Captured artifact ${id} (${kind}) for ${ref} — ${tagSuffix}.`);
  if (relativeFilePath) {
    console.log(`  file: ${resolve(resolved.assignmentDir, relativeFilePath)}`);
  }
}
