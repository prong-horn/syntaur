import { Command } from 'commander';
import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveAssignmentTarget } from '../utils/assignment-target.js';
import { parseAcceptanceCriteria } from '../utils/acceptance-criteria-parse.js';
import { fileExists } from '../utils/fs.js';
import {
  initProofDb,
  listArtifactsByAssignment,
  type ArtifactRow,
} from '../db/proof-db.js';
import { renderProofMarkdown, type ProofRenderParams } from '../templates/proof-md.js';
import { renderProofHtml, INLINE_TEXT_LIMIT_BYTES } from '../templates/proof-html.js';

export interface ProofBuildOptions {
  project?: string;
  dir?: string;
  cwd?: string;
}

interface AssignmentMeta {
  title: string;
  body: string;
}

async function readAssignmentMeta(assignmentDir: string): Promise<AssignmentMeta> {
  const path = resolve(assignmentDir, 'assignment.md');
  if (!(await fileExists(path))) {
    return { title: '', body: '' };
  }
  const content = await readFile(path, 'utf-8');

  // Title from frontmatter `title: ...`
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  let title = '';
  if (fmMatch) {
    const titleLine = fmMatch[1].split('\n').find((l) => /^title:\s/i.test(l));
    if (titleLine) {
      const raw = titleLine.replace(/^title:\s*/i, '').trim();
      title = raw.replace(/^["']|["']$/g, '');
    }
  }
  return { title, body: content };
}

/**
 * Atomic-write `content` to `destPath` via a sibling `.tmp` file + rename.
 */
async function atomicWrite(destPath: string, content: string): Promise<void> {
  const tmp = `${destPath}.tmp`;
  await writeFile(tmp, content, 'utf-8');
  await rename(tmp, destPath);
}

function groupArtifacts(
  rows: ArtifactRow[],
  criterionCount: number,
): {
  artifactsByCriterion: Map<number, ArtifactRow[]>;
  untagged: ArtifactRow[];
  staleByOriginalIndex: ArtifactRow[];
} {
  const artifactsByCriterion = new Map<number, ArtifactRow[]>();
  const untagged: ArtifactRow[] = [];
  const staleByOriginalIndex: ArtifactRow[] = [];

  for (const row of rows) {
    const idx = row.criterion_index;
    if (idx === null || idx === undefined) {
      untagged.push(row);
      continue;
    }
    if (idx >= 0 && idx < criterionCount) {
      const list = artifactsByCriterion.get(idx) ?? [];
      list.push(row);
      artifactsByCriterion.set(idx, list);
    } else {
      staleByOriginalIndex.push(row);
    }
  }

  return { artifactsByCriterion, untagged, staleByOriginalIndex };
}

/**
 * Read inline contents for `text`/`http` artifacts that have a file. Files
 * larger than INLINE_TEXT_LIMIT_BYTES return null so the renderer can fall
 * back to a download link.
 */
async function loadInlineFiles(
  rows: ArtifactRow[],
  assignmentDir: string,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const r of rows) {
    if (!r.file_path) continue;
    if (r.kind !== 'http' && r.kind !== 'text') continue;
    const abs = resolve(assignmentDir, r.file_path);
    if (!(await fileExists(abs))) {
      out.set(r.file_path, null);
      continue;
    }
    const st = await stat(abs);
    if (st.size > INLINE_TEXT_LIMIT_BYTES) {
      out.set(r.file_path, null);
      continue;
    }
    try {
      out.set(r.file_path, await readFile(abs, 'utf-8'));
    } catch {
      out.set(r.file_path, null);
    }
  }
  return out;
}

export async function proofBuildCommand(
  target: string | undefined,
  options: ProofBuildOptions = {},
): Promise<{ htmlPath: string; mdPath: string }> {
  const resolved = await resolveAssignmentTarget(target, {
    project: options.project,
    dir: options.dir,
    cwd: options.cwd,
  });

  const meta = await readAssignmentMeta(resolved.assignmentDir);
  const criteria = parseAcceptanceCriteria(meta.body);

  initProofDb();
  const rows = listArtifactsByAssignment(resolved.id);

  const { artifactsByCriterion, untagged, staleByOriginalIndex } = groupArtifacts(
    rows,
    criteria.length,
  );

  const inlineFiles = await loadInlineFiles(rows, resolved.assignmentDir);

  const renderParams: ProofRenderParams = {
    assignment: resolved.standalone
      ? resolved.id
      : `${resolved.projectSlug}/${resolved.assignmentSlug}`,
    title: meta.title || resolved.assignmentSlug,
    generated: new Date().toISOString(),
    criteria,
    artifactsByCriterion,
    untagged,
    staleByOriginalIndex,
  };

  const md = renderProofMarkdown(renderParams);
  const html = renderProofHtml(renderParams, inlineFiles);

  const mdPath = resolve(resolved.assignmentDir, 'proof.md');
  const htmlPath = resolve(resolved.assignmentDir, 'proof.html');
  await atomicWrite(mdPath, md);
  await atomicWrite(htmlPath, html);

  console.log(`Wrote ${htmlPath}`);
  console.log(`Wrote ${mdPath}`);

  return { htmlPath, mdPath };
}

export const proofCommand = new Command('proof').description('Render proof artifacts for an assignment');

proofCommand
  .command('build')
  .description('Render proof.html and proof.md for an assignment')
  .argument('[target]', 'Assignment slug (with --project) or UUID; falls back to .syntaur/context.json')
  .option('--project <slug>', 'Project slug if the target is project-nested')
  .option('--dir <path>', 'Override default project directory')
  .action(async (target: string | undefined, options: ProofBuildOptions) => {
    try {
      await proofBuildCommand(target, options);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
