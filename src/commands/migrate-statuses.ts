import { resolve } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { expandHome, assignmentsDir as getStandaloneDir } from '../utils/paths.js';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import { parseAssignmentFrontmatter, updateAssignmentFile } from '../lifecycle/frontmatter.js';
import { nowTimestamp } from '../utils/timestamp.js';
import type { AssignmentFrontmatter } from '../lifecycle/types.js';

export interface MigrateStatusesOptions {
  dir?: string;
  apply?: boolean;
}

interface Candidate {
  projectSlug: string | null;
  assignmentSlug: string;
  assignmentMd: string;
  fromStatus: string;
  toStatus: string;
}

const PROMOTABLE_STATUSES = new Set(['pending']);

function objectiveIsFleshedOut(content: string): boolean {
  const match = content.match(/##\s+Objective\s*\n([\s\S]*?)(?=\n##\s+|$)/);
  if (!match) return false;
  const body = match[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^<!--[\s\S]*-->$/.test(l))
    .join('\n')
    .trim();
  return body.length > 0;
}

function hasAcceptanceCriteria(content: string): boolean {
  const match = content.match(/##\s+Acceptance Criteria\s*\n([\s\S]*?)(?=\n##\s+|$)/);
  if (!match) return false;
  const acItems = match[1].match(/^-\s*\[[ x]\]\s+(?!<!--)/gm);
  return (acItems?.length ?? 0) > 0;
}

async function collectCandidates(baseDirs: string[]): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  for (const baseDir of baseDirs) {
    if (!(await fileExists(baseDir))) continue;
    const projects = await readdir(baseDir, { withFileTypes: true });
    for (const m of projects) {
      if (!m.isDirectory()) continue;
      if (m.name.startsWith('.') || m.name.startsWith('_')) continue;

      // Standalone shape: baseDir contains uuid folders directly with assignment.md
      const directAssignmentMd = resolve(baseDir, m.name, 'assignment.md');
      if (await fileExists(directAssignmentMd)) {
        const fm = await parseSafe(directAssignmentMd);
        if (fm && PROMOTABLE_STATUSES.has(fm.status)) {
          const content = await readFile(directAssignmentMd, 'utf-8');
          if (objectiveIsFleshedOut(content) && hasAcceptanceCriteria(content)) {
            candidates.push({
              projectSlug: null,
              assignmentSlug: m.name,
              assignmentMd: directAssignmentMd,
              fromStatus: fm.status,
              toStatus: 'ready_for_planning',
            });
          }
        }
        continue;
      }

      // Project shape: baseDir/projectSlug/assignments/<slug>/assignment.md
      const assignmentsDir = resolve(baseDir, m.name, 'assignments');
      if (!(await fileExists(assignmentsDir))) continue;
      const entries = await readdir(assignmentsDir, { withFileTypes: true });
      for (const a of entries) {
        if (!a.isDirectory()) continue;
        if (a.name.startsWith('.') || a.name.startsWith('_')) continue;
        const assignmentMd = resolve(assignmentsDir, a.name, 'assignment.md');
        if (!(await fileExists(assignmentMd))) continue;
        const fm = await parseSafe(assignmentMd);
        if (!fm || !PROMOTABLE_STATUSES.has(fm.status)) continue;
        const content = await readFile(assignmentMd, 'utf-8');
        if (!objectiveIsFleshedOut(content)) continue;
        if (!hasAcceptanceCriteria(content)) continue;
        candidates.push({
          projectSlug: m.name,
          assignmentSlug: a.name,
          assignmentMd,
          fromStatus: fm.status,
          toStatus: 'ready_for_planning',
        });
      }
    }
  }
  return candidates;
}

async function parseSafe(path: string): Promise<AssignmentFrontmatter | null> {
  try {
    const content = await readFile(path, 'utf-8');
    return parseAssignmentFrontmatter(content);
  } catch {
    return null;
  }
}

export async function migrateStatusesCommand(
  options: MigrateStatusesOptions,
): Promise<void> {
  const config = await readConfig();
  const projectsBase = options.dir ? expandHome(options.dir) : config.defaultProjectDir;
  const standaloneBase = getStandaloneDir();

  const candidates = await collectCandidates([projectsBase, standaloneBase]);

  if (candidates.length === 0) {
    console.log('No promotion candidates found. (Looking for pending assignments with a fleshed-out Objective and at least one Acceptance Criterion.)');
    return;
  }

  console.log(`Found ${candidates.length} candidate${candidates.length === 1 ? '' : 's'} for promotion ${options.apply ? '(applying)' : '(dry-run; use --apply to write)'}:`);
  console.log('');
  for (const c of candidates) {
    const label = c.projectSlug ? `${c.projectSlug}/${c.assignmentSlug}` : `standalone/${c.assignmentSlug}`;
    console.log(`  ${label}: ${c.fromStatus} -> ${c.toStatus}`);
  }
  console.log('');

  if (!options.apply) {
    console.log('Re-run with --apply to perform the migration.');
    return;
  }

  const now = nowTimestamp();
  let migrated = 0;
  for (const c of candidates) {
    const content = await readFile(c.assignmentMd, 'utf-8');
    const updated = updateAssignmentFile(content, {
      status: c.toStatus,
      updated: now,
    });
    await writeFileForce(c.assignmentMd, updated);
    migrated += 1;
  }
  console.log(`Migrated ${migrated} assignment${migrated === 1 ? '' : 's'}.`);
}
