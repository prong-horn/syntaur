import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { getTargetStatus } from './state-machine.js';
import { parseAssignmentFrontmatter, updateAssignmentFile } from './frontmatter.js';
import type { TransitionCommand, TransitionResult, AssignmentFrontmatter } from './types.js';

function resolveAssignmentPath(missionDir: string, assignmentSlug: string): string {
  return resolve(missionDir, 'assignments', assignmentSlug, 'assignment.md');
}

async function readAssignment(
  filePath: string,
): Promise<{ content: string; frontmatter: AssignmentFrontmatter }> {
  if (!(await fileExists(filePath))) {
    throw new Error(`Assignment file not found: ${filePath}`);
  }
  const content = await readFile(filePath, 'utf-8');
  const frontmatter = parseAssignmentFrontmatter(content);
  return { content, frontmatter };
}

async function checkDependencies(
  missionDir: string,
  dependsOn: string[],
  terminalStatuses?: ReadonlySet<string>,
): Promise<{ satisfied: boolean; unmet: string[] }> {
  const terminals = terminalStatuses ?? new Set(['completed']);
  const unmet: string[] = [];
  for (const depSlug of dependsOn) {
    const depPath = resolveAssignmentPath(missionDir, depSlug);
    if (!(await fileExists(depPath))) {
      unmet.push(`${depSlug} (file not found)`);
      continue;
    }
    const depContent = await readFile(depPath, 'utf-8');
    const depFrontmatter = parseAssignmentFrontmatter(depContent);
    if (!terminals.has(depFrontmatter.status)) {
      unmet.push(`${depSlug} (status: ${depFrontmatter.status})`);
    }
  }
  return { satisfied: unmet.length === 0, unmet };
}

export interface TransitionOptions {
  reason?: string;
  agent?: string;
  transitionTable?: Map<string, string>;
  terminalStatuses?: ReadonlySet<string>;
}

export async function executeTransition(
  missionDir: string,
  assignmentSlug: string,
  command: Exclude<TransitionCommand, 'assign'>,
  options: TransitionOptions = {},
): Promise<TransitionResult> {
  const filePath = resolveAssignmentPath(missionDir, assignmentSlug);
  const { content, frontmatter } = await readAssignment(filePath);

  const targetStatus = getTargetStatus(frontmatter.status, command, options.transitionTable);

  if (!targetStatus) {
    return {
      success: false,
      message: `Unknown command '${command}' for assignment "${assignmentSlug}".`,
      fromStatus: frontmatter.status,
    };
  }

  const warnings: string[] = [];

  if (command === 'start' && frontmatter.dependsOn.length > 0) {
    const depCheck = await checkDependencies(missionDir, frontmatter.dependsOn, options.terminalStatuses);
    if (!depCheck.satisfied) {
      warnings.push(`Starting with unmet dependencies: ${depCheck.unmet.join(', ')}`);
    }
  }

  const updates: Partial<Pick<AssignmentFrontmatter, 'status' | 'assignee' | 'blockedReason' | 'updated'>> = {
    status: targetStatus,
    updated: nowTimestamp(),
  };

  if (command === 'start' && options.agent && !frontmatter.assignee) {
    updates.assignee = options.agent;
  }
  if (command === 'block') {
    updates.blockedReason = options.reason ?? null;
  }
  if (command === 'unblock') {
    updates.blockedReason = null;
  }

  const updatedContent = updateAssignmentFile(content, updates);
  await writeFileForce(filePath, updatedContent);

  return {
    success: true,
    message: `Assignment "${assignmentSlug}" transitioned: ${frontmatter.status} -> ${targetStatus}`,
    fromStatus: frontmatter.status,
    toStatus: targetStatus,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export async function executeAssign(
  missionDir: string,
  assignmentSlug: string,
  agent: string,
): Promise<TransitionResult> {
  const filePath = resolveAssignmentPath(missionDir, assignmentSlug);
  const { content, frontmatter } = await readAssignment(filePath);

  const updates: Partial<Pick<AssignmentFrontmatter, 'status' | 'assignee' | 'blockedReason' | 'updated'>> = {
    assignee: agent,
    updated: nowTimestamp(),
  };

  const updatedContent = updateAssignmentFile(content, updates);
  await writeFileForce(filePath, updatedContent);

  return {
    success: true,
    message: `Assignment "${assignmentSlug}" assigned to '${agent}'.`,
    fromStatus: frontmatter.status,
  };
}
