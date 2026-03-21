import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileExists } from '../utils/fs.js';
import {
  parseMission,
  parseStatus,
  parseAssignmentSummary,
  parseAssignmentFull,
  parsePlan,
  parseScratchpad,
  parseHandoff,
  parseDecisionRecord,
  parseResource,
  parseMemory,
  extractMermaidGraph,
} from './parser.js';
import type {
  MissionSummary,
  MissionDetail,
  AssignmentDetail,
  AssignmentSummary,
  ProgressCounts,
  NeedsAttention,
  ResourceSummary,
  MemorySummary,
} from './types.js';

/**
 * List all missions with summary data.
 * GET /api/missions
 */
export async function listMissions(missionsDir: string): Promise<MissionSummary[]> {
  if (!(await fileExists(missionsDir))) {
    return [];
  }

  const entries = await readdir(missionsDir, { withFileTypes: true });
  const missionDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));

  const results: MissionSummary[] = [];

  for (const dir of missionDirs) {
    const missionPath = resolve(missionsDir, dir.name);
    const missionMdPath = resolve(missionPath, 'mission.md');

    if (!(await fileExists(missionMdPath))) continue;

    const missionContent = await readFile(missionMdPath, 'utf-8');
    const mission = parseMission(missionContent);

    // Try to read _status.md for progress/needsAttention
    let progress: ProgressCounts = {
      total: 0, completed: 0, in_progress: 0, blocked: 0, pending: 0, review: 0, failed: 0,
    };
    let needsAttention: NeedsAttention = {
      blockedCount: 0, failedCount: 0, unansweredQuestions: 0,
    };
    let status = 'pending';

    const statusPath = resolve(missionPath, '_status.md');
    if (await fileExists(statusPath)) {
      const statusContent = await readFile(statusPath, 'utf-8');
      const parsed = parseStatus(statusContent);
      progress = parsed.progress;
      needsAttention = parsed.needsAttention;
      status = parsed.status;
    } else {
      // Fallback: compute from source assignment files
      const computed = await computeProgressFromSource(missionPath);
      progress = computed.progress;
      needsAttention = computed.needsAttention;
      status = computed.status;
    }

    results.push({
      slug: mission.slug || dir.name,
      title: mission.title,
      status,
      archived: mission.archived,
      created: mission.created,
      updated: mission.updated,
      tags: mission.tags,
      progress,
      needsAttention,
    });
  }

  // Sort by updated descending
  results.sort((a, b) => b.updated.localeCompare(a.updated));
  return results;
}

/**
 * Get full mission detail with assignments, resources, and memories.
 * GET /api/missions/:slug
 */
export async function getMissionDetail(
  missionsDir: string,
  slug: string,
): Promise<MissionDetail | null> {
  const missionPath = resolve(missionsDir, slug);
  const missionMdPath = resolve(missionPath, 'mission.md');

  if (!(await fileExists(missionMdPath))) return null;

  const missionContent = await readFile(missionMdPath, 'utf-8');
  const mission = parseMission(missionContent);

  // Progress and status
  let progress: ProgressCounts = {
    total: 0, completed: 0, in_progress: 0, blocked: 0, pending: 0, review: 0, failed: 0,
  };
  let needsAttention: NeedsAttention = {
    blockedCount: 0, failedCount: 0, unansweredQuestions: 0,
  };
  let missionStatus = 'pending';
  let dependencyGraph: string | null = null;

  const statusPath = resolve(missionPath, '_status.md');
  if (await fileExists(statusPath)) {
    const statusContent = await readFile(statusPath, 'utf-8');
    const parsed = parseStatus(statusContent);
    progress = parsed.progress;
    needsAttention = parsed.needsAttention;
    missionStatus = parsed.status;
    dependencyGraph = extractMermaidGraph(parsed.body);
  } else {
    const computed = await computeProgressFromSource(missionPath);
    progress = computed.progress;
    needsAttention = computed.needsAttention;
    missionStatus = computed.status;
    dependencyGraph = computed.dependencyGraph;
  }

  // Assignments
  const assignments = await listAssignments(missionPath);

  // Resources
  const resources = await listResources(missionPath);

  // Memories
  const memories = await listMemories(missionPath);

  return {
    slug: mission.slug || slug,
    title: mission.title,
    status: missionStatus,
    archived: mission.archived,
    created: mission.created,
    updated: mission.updated,
    tags: mission.tags,
    body: mission.body,
    progress,
    needsAttention,
    assignments,
    resources,
    memories,
    dependencyGraph,
  };
}

/**
 * Get full assignment detail with plan, scratchpad, handoff, decision record.
 * GET /api/missions/:slug/assignments/:aslug
 */
export async function getAssignmentDetail(
  missionsDir: string,
  missionSlug: string,
  assignmentSlug: string,
): Promise<AssignmentDetail | null> {
  const assignmentDir = resolve(
    missionsDir,
    missionSlug,
    'assignments',
    assignmentSlug,
  );
  const assignmentMdPath = resolve(assignmentDir, 'assignment.md');

  if (!(await fileExists(assignmentMdPath))) return null;

  const assignmentContent = await readFile(assignmentMdPath, 'utf-8');
  const assignment = parseAssignmentFull(assignmentContent);

  // Plan
  let plan: AssignmentDetail['plan'] = null;
  const planPath = resolve(assignmentDir, 'plan.md');
  if (await fileExists(planPath)) {
    const planContent = await readFile(planPath, 'utf-8');
    const parsed = parsePlan(planContent);
    plan = { status: parsed.status, body: parsed.body };
  }

  // Scratchpad
  let scratchpad: AssignmentDetail['scratchpad'] = null;
  const scratchpadPath = resolve(assignmentDir, 'scratchpad.md');
  if (await fileExists(scratchpadPath)) {
    const scratchpadContent = await readFile(scratchpadPath, 'utf-8');
    const parsed = parseScratchpad(scratchpadContent);
    scratchpad = { body: parsed.body };
  }

  // Handoff
  let handoff: AssignmentDetail['handoff'] = null;
  const handoffPath = resolve(assignmentDir, 'handoff.md');
  if (await fileExists(handoffPath)) {
    const handoffContent = await readFile(handoffPath, 'utf-8');
    const parsed = parseHandoff(handoffContent);
    handoff = { handoffCount: parsed.handoffCount, body: parsed.body };
  }

  // Decision Record
  let decisionRecord: AssignmentDetail['decisionRecord'] = null;
  const decisionRecordPath = resolve(assignmentDir, 'decision-record.md');
  if (await fileExists(decisionRecordPath)) {
    const decisionRecordContent = await readFile(decisionRecordPath, 'utf-8');
    const parsed = parseDecisionRecord(decisionRecordContent);
    decisionRecord = { decisionCount: parsed.decisionCount, body: parsed.body };
  }

  return {
    slug: assignment.slug || assignmentSlug,
    title: assignment.title,
    status: assignment.status as AssignmentDetail['status'],
    priority: assignment.priority as AssignmentDetail['priority'],
    assignee: assignment.assignee,
    dependsOn: assignment.dependsOn,
    blockedReason: assignment.blockedReason,
    workspace: assignment.workspace,
    externalIds: assignment.externalIds,
    tags: assignment.tags,
    created: assignment.created,
    updated: assignment.updated,
    body: assignment.body,
    plan,
    scratchpad,
    handoff,
    decisionRecord,
  };
}

// --- Internal helpers ---

async function listAssignments(missionPath: string): Promise<AssignmentSummary[]> {
  const assignmentsDir = resolve(missionPath, 'assignments');
  if (!(await fileExists(assignmentsDir))) return [];

  const entries = await readdir(assignmentsDir, { withFileTypes: true });
  const results: AssignmentSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const assignmentMd = resolve(assignmentsDir, entry.name, 'assignment.md');
    if (!(await fileExists(assignmentMd))) continue;

    const content = await readFile(assignmentMd, 'utf-8');
    const parsed = parseAssignmentSummary(content);
    results.push({
      slug: parsed.slug || entry.name,
      title: parsed.title,
      status: parsed.status as AssignmentSummary['status'],
      priority: parsed.priority as AssignmentSummary['priority'],
      assignee: parsed.assignee,
      dependsOn: parsed.dependsOn,
      updated: parsed.updated,
    });
  }

  return results;
}

async function listResources(missionPath: string): Promise<ResourceSummary[]> {
  const resourcesDir = resolve(missionPath, 'resources');
  if (!(await fileExists(resourcesDir))) return [];

  const entries = await readdir(resourcesDir, { withFileTypes: true });
  const results: ResourceSummary[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('_')) continue;
    const filePath = resolve(resourcesDir, entry.name);
    const content = await readFile(filePath, 'utf-8');
    const parsed = parseResource(content);
    const slug = entry.name.replace(/\.md$/, '');
    results.push({
      name: parsed.name,
      slug,
      category: parsed.category,
      source: parsed.source,
      relatedAssignments: parsed.relatedAssignments,
      updated: parsed.updated,
    });
  }

  return results;
}

async function listMemories(missionPath: string): Promise<MemorySummary[]> {
  const memoriesDir = resolve(missionPath, 'memories');
  if (!(await fileExists(memoriesDir))) return [];

  const entries = await readdir(memoriesDir, { withFileTypes: true });
  const results: MemorySummary[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('_')) continue;
    const filePath = resolve(memoriesDir, entry.name);
    const content = await readFile(filePath, 'utf-8');
    const parsed = parseMemory(content);
    const slug = entry.name.replace(/\.md$/, '');
    results.push({
      name: parsed.name,
      slug,
      source: parsed.source,
      scope: parsed.scope,
      sourceAssignment: parsed.sourceAssignment,
      updated: parsed.updated,
    });
  }

  return results;
}

async function computeProgressFromSource(missionPath: string): Promise<{
  progress: ProgressCounts;
  needsAttention: NeedsAttention;
  status: string;
  dependencyGraph: string | null;
}> {
  const assignments = await listAssignments(missionPath);
  const progress: ProgressCounts = {
    total: assignments.length,
    completed: 0,
    in_progress: 0,
    blocked: 0,
    pending: 0,
    review: 0,
    failed: 0,
  };

  for (const a of assignments) {
    const key = a.status;
    if (key === 'completed' || key === 'in_progress' || key === 'blocked' ||
        key === 'pending' || key === 'review' || key === 'failed') {
      progress[key]++;
    }
  }

  const needsAttention: NeedsAttention = {
    blockedCount: progress.blocked,
    failedCount: progress.failed,
    unansweredQuestions: 0,
  };

  // Determine mission status
  let status = 'pending';
  if (progress.total === 0) {
    status = 'pending';
  } else if (progress.completed === progress.total) {
    status = 'completed';
  } else if (progress.in_progress > 0 || progress.review > 0) {
    status = 'active';
  } else if (progress.blocked > 0 && progress.in_progress === 0) {
    status = 'blocked';
  }

  // Build a simple dependency graph from assignments
  let dependencyGraph: string | null = null;
  const edges: string[] = [];
  for (const a of assignments) {
    for (const dep of a.dependsOn) {
      edges.push(`    ${dep}:::${assignments.find(x => x.slug === dep)?.status ?? 'pending'} --> ${a.slug}:::${a.status}`);
    }
  }
  if (edges.length > 0) {
    const classDefs = [
      'classDef completed fill:#22c55e',
      'classDef in_progress fill:#3b82f6',
      'classDef pending fill:#6b7280',
      'classDef blocked fill:#ef4444',
      'classDef failed fill:#dc2626',
      'classDef review fill:#f59e0b',
    ];
    dependencyGraph = `graph TD\n${edges.join('\n')}\n    ${classDefs.join('\n    ')}`;
  }

  return { progress, needsAttention, status, dependencyGraph };
}
