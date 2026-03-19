import { readFile, readdir } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { fileExists } from '../utils/fs.js';
import {
  parseFrontmatter,
  extractBody,
  parseSessionsTable,
  countUnansweredQuestions,
  parseLatestDecision,
} from './parser.js';
import type {
  MissionData,
  ParsedAssignment,
  ParsedPlan,
  ParsedDecisionRecord,
  ParsedResource,
  ParsedMemory,
} from './types.js';

/**
 * Read a file and return its content, or null if the file does not exist.
 */
async function readFileOrNull(filePath: string): Promise<string | null> {
  if (!(await fileExists(filePath))) return null;
  return readFile(filePath, 'utf-8');
}

/**
 * Parse a plan.md file. Returns default values if the file is missing.
 */
function parsePlanFile(
  assignmentSlug: string,
  content: string | null,
): ParsedPlan {
  if (!content) {
    return {
      assignmentSlug,
      status: 'draft',
      updated: '',
    };
  }
  const fm = parseFrontmatter(content);
  return {
    assignmentSlug,
    status: (fm['status'] as string) || 'draft',
    updated: (fm['updated'] as string) || '',
  };
}

/**
 * Parse a decision-record.md file. Returns default values if the file is missing.
 */
function parseDecisionRecordFile(
  assignmentSlug: string,
  content: string | null,
): ParsedDecisionRecord {
  if (!content) {
    return {
      assignmentSlug,
      decisionCount: 0,
      latestDecision: null,
      updated: '',
    };
  }
  const fm = parseFrontmatter(content);
  const body = extractBody(content);
  const latestDecision = parseLatestDecision(body);
  return {
    assignmentSlug,
    decisionCount: (fm['decisionCount'] as number) || 0,
    latestDecision,
    updated: (fm['updated'] as string) || '',
  };
}

/**
 * Scan a single assignment folder and return parsed data.
 */
async function scanAssignment(
  assignmentDir: string,
): Promise<ParsedAssignment | null> {
  const assignmentPath = resolve(assignmentDir, 'assignment.md');
  const assignmentContent = await readFileOrNull(assignmentPath);
  if (!assignmentContent) return null;

  const fm = parseFrontmatter(assignmentContent);
  const body = extractBody(assignmentContent);

  const slug = (fm['slug'] as string) || basename(assignmentDir);
  const planContent = await readFileOrNull(
    resolve(assignmentDir, 'plan.md'),
  );
  const decisionContent = await readFileOrNull(
    resolve(assignmentDir, 'decision-record.md'),
  );

  const dependsOnRaw = fm['dependsOn'];
  const dependsOn: string[] = Array.isArray(dependsOnRaw)
    ? (dependsOnRaw as string[])
    : [];

  return {
    slug,
    title: (fm['title'] as string) || slug,
    status: (fm['status'] as string) || 'pending',
    priority: (fm['priority'] as string) || 'medium',
    assignee: (fm['assignee'] as string) || null,
    dependsOn,
    updated: (fm['updated'] as string) || '',
    sessions: parseSessionsTable(body),
    unansweredQuestions: countUnansweredQuestions(body),
    plan: parsePlanFile(slug, planContent),
    decisionRecord: parseDecisionRecordFile(slug, decisionContent),
  };
}

/**
 * Scan the resources/ directory for resource files (excluding _index.md).
 */
async function scanResources(
  resourcesDir: string,
): Promise<ParsedResource[]> {
  if (!(await fileExists(resourcesDir))) return [];

  const files = await readdir(resourcesDir);
  const resources: ParsedResource[] = [];

  for (const file of files) {
    if (!file.endsWith('.md') || file.startsWith('_')) continue;
    const content = await readFile(
      resolve(resourcesDir, file),
      'utf-8',
    );
    const fm = parseFrontmatter(content);
    if (fm['type'] !== 'resource') continue;

    const relatedRaw = fm['relatedAssignments'];
    const relatedAssignments: string[] = Array.isArray(relatedRaw)
      ? (relatedRaw as string[])
      : [];

    resources.push({
      fileName: file.replace(/\.md$/, ''),
      name: (fm['name'] as string) || file.replace(/\.md$/, ''),
      category: (fm['category'] as string) || 'other',
      source: (fm['source'] as string) || 'unknown',
      relatedAssignments,
      updated: (fm['updated'] as string) || '',
    });
  }

  return resources;
}

/**
 * Scan the memories/ directory for memory files (excluding _index.md).
 */
async function scanMemories(
  memoriesDir: string,
): Promise<ParsedMemory[]> {
  if (!(await fileExists(memoriesDir))) return [];

  const files = await readdir(memoriesDir);
  const memories: ParsedMemory[] = [];

  for (const file of files) {
    if (!file.endsWith('.md') || file.startsWith('_')) continue;
    const content = await readFile(
      resolve(memoriesDir, file),
      'utf-8',
    );
    const fm = parseFrontmatter(content);
    if (fm['type'] !== 'memory') continue;

    memories.push({
      fileName: file.replace(/\.md$/, ''),
      name: (fm['name'] as string) || file.replace(/\.md$/, ''),
      source: (fm['source'] as string) || 'unknown',
      scope: (fm['scope'] as string) || 'assignment',
      sourceAssignment: (fm['sourceAssignment'] as string) || null,
      updated: (fm['updated'] as string) || '',
    });
  }

  return memories;
}

/**
 * Scan an entire mission directory and return all parsed data.
 *
 * Reads:
 * - mission.md (for slug, title, archived flag)
 * - assignments/ subdirectories (each with assignment.md, plan.md, decision-record.md)
 * - resources/ directory (for resource files)
 * - memories/ directory (for memory files)
 */
export async function scanMission(
  missionDir: string,
): Promise<MissionData> {
  // Read mission.md for the slug, title, and archived flag
  const missionMdPath = resolve(missionDir, 'mission.md');
  const missionContent = await readFile(missionMdPath, 'utf-8');
  const missionFm = parseFrontmatter(missionContent);

  const slug =
    (missionFm['slug'] as string) || basename(missionDir);
  const title =
    (missionFm['title'] as string) || slug;
  const archived = missionFm['archived'] === true;

  // Scan assignments
  const assignmentsDir = resolve(missionDir, 'assignments');
  const assignments: ParsedAssignment[] = [];

  if (await fileExists(assignmentsDir)) {
    const entries = await readdir(assignmentsDir, {
      withFileTypes: true,
    });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    for (const dirName of dirs) {
      const parsed = await scanAssignment(
        resolve(assignmentsDir, dirName),
      );
      if (parsed) {
        assignments.push(parsed);
      }
    }
  }

  // Scan resources and memories
  const resources = await scanResources(
    resolve(missionDir, 'resources'),
  );
  const memories = await scanMemories(
    resolve(missionDir, 'memories'),
  );

  return {
    slug,
    title,
    archived,
    assignments,
    resources,
    memories,
  };
}
