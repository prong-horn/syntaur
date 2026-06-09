import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { getTargetStatus } from './state-machine.js';
import { appendStatusHistoryEntry, parseAssignmentFrontmatter, updateAssignmentFile } from './frontmatter.js';
import {
  completeLinkedTodos,
  reopenLinkedTodos,
  type LinkedTodosLookup,
} from './linked-todos.js';
import type { TransitionCommand, TransitionResult, AssignmentFrontmatter } from './types.js';

function linkedAssignmentRef(frontmatter: AssignmentFrontmatter): string {
  return frontmatter.project ? `${frontmatter.project}/${frontmatter.slug}` : frontmatter.id;
}

async function applyLinkedTodosSideEffect(
  lookup: LinkedTodosLookup | undefined,
  command: string,
  targetStatus: string,
  frontmatter: AssignmentFrontmatter,
): Promise<void> {
  if (!lookup) return;
  const ref = linkedAssignmentRef(frontmatter);
  if (targetStatus === 'completed') {
    await completeLinkedTodos(lookup, frontmatter.id, ref);
  } else if (command === 'reopen') {
    await reopenLinkedTodos(lookup, frontmatter.id, ref);
  }
}

function resolveAssignmentPath(projectDir: string, assignmentSlug: string): string {
  return resolve(projectDir, 'assignments', assignmentSlug, 'assignment.md');
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
  projectDir: string,
  dependsOn: string[],
  terminalStatuses?: ReadonlySet<string>,
): Promise<{ satisfied: boolean; unmet: string[] }> {
  const terminals = terminalStatuses ?? new Set(['completed']);
  const unmet: string[] = [];
  for (const depSlug of dependsOn) {
    const depPath = resolveAssignmentPath(projectDir, depSlug);
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
  /** Guard-free custom targets: when provided (and no transitionTable), the
   * command resolves to this map's target regardless of the current status —
   * preserving a CUSTOM terminal target (e.g. complete -> done) without the
   * from:command guard, even for assignments on legacy/undefined statuses. */
  commandTargets?: Map<string, string>;
  terminalStatuses?: ReadonlySet<string>;
  /**
   * When provided, on a transition to `completed` we scan the configured todos
   * dirs and auto-complete any todo whose `linkedAssignmentId` matches this
   * assignment's UUID. On `reopen` we auto-reopen any such todo whose most
   * recent log entry is the auto-complete marker (manual completions are left
   * untouched).
   */
  linkedTodosLookup?: LinkedTodosLookup;
}

const ASSIGNEE_SETTING_COMMANDS = new Set(['start', 'shape', 'plan-ready', 'implement']);

export async function executeTransition(
  projectDir: string,
  assignmentSlug: string,
  command: Exclude<TransitionCommand, 'assign'>,
  options: TransitionOptions = {},
): Promise<TransitionResult> {
  const filePath = resolveAssignmentPath(projectDir, assignmentSlug);
  const { content, frontmatter } = await readAssignment(filePath);

  // Resolution order: a from-specific custom mapping wins; the guard-free
  // commandTargets fallback covers legacy/undefined statuses; built-ins last
  // (only when neither custom mechanism was supplied).
  const targetStatus =
    (options.transitionTable
      ? getTargetStatus(frontmatter.status, command, options.transitionTable)
      : null) ??
    options.commandTargets?.get(command) ??
    (options.transitionTable ? null : getTargetStatus(frontmatter.status, command));

  if (!targetStatus) {
    return {
      success: false,
      message: `Unknown command '${command}' for assignment "${assignmentSlug}".`,
      fromStatus: frontmatter.status,
    };
  }

  const warnings: string[] = [];

  if (command === 'start' && frontmatter.dependsOn.length > 0) {
    const depCheck = await checkDependencies(projectDir, frontmatter.dependsOn, options.terminalStatuses);
    if (!depCheck.satisfied) {
      warnings.push(`Starting with unmet dependencies: ${depCheck.unmet.join(', ')}`);
    }
  }

  const now = nowTimestamp();
  const updates: Partial<
    Pick<AssignmentFrontmatter, 'status' | 'assignee' | 'blockedReason' | 'updated' | 'disposition'>
  > = {
    status: targetStatus,
    updated: now,
  };

  if (ASSIGNEE_SETTING_COMMANDS.has(command) && options.agent && !frontmatter.assignee) {
    updates.assignee = options.agent;
  }
  if (command === 'block') {
    // Derived-status v3: the blocked disposition keys on blockedReason
    // PRESENCE — a null reason would make block-without-reason a silent
    // no-op under derivation. Match the CLI verb's default.
    updates.blockedReason = options.reason ?? '(unspecified)';
  }
  if (command === 'unblock') {
    updates.blockedReason = null;
  }

  // Dimension-aware terminal cache (derived-status v3): entering a terminal
  // status sets `disposition: terminal` so payloads/queries never show a
  // terminal headline with a stale active/blocked disposition. Leaving
  // terminal (reopen) hands the cache back to derivation, which the CLI
  // reopen command runs immediately after this transition.
  const terminalSet = options.terminalStatuses ?? new Set(['completed', 'failed']);
  const enteringTerminal = terminalSet.has(targetStatus) && frontmatter.disposition !== 'terminal';
  if (enteringTerminal) {
    updates.disposition = 'terminal';
  }

  let updatedContent = updateAssignmentFile(content, updates);
  // Only record a history entry on an ACTUAL status change. CLI commands are
  // guard-free (getTargetStatus returns the canonical target regardless of the
  // current status), so re-running e.g. `complete` on an already-completed
  // assignment must not append a from===to entry and reset statusAge.
  if (targetStatus !== frontmatter.status) {
    updatedContent = appendStatusHistoryEntry(updatedContent, {
      at: now,
      from: frontmatter.status,
      to: targetStatus,
      command,
      by: options.agent ?? frontmatter.assignee ?? null,
      reason: command === 'block' ? options.reason : undefined,
      ...(enteringTerminal
        ? { dispositionFrom: frontmatter.disposition, dispositionTo: 'terminal' }
        : {}),
    });
  }
  await writeFileForce(filePath, updatedContent);

  await applyLinkedTodosSideEffect(options.linkedTodosLookup, command, targetStatus, frontmatter);

  return {
    success: true,
    message: `Assignment "${assignmentSlug}" transitioned: ${frontmatter.status} -> ${targetStatus}`,
    fromStatus: frontmatter.status,
    toStatus: targetStatus,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export async function executeAssign(
  projectDir: string,
  assignmentSlug: string,
  agent: string,
): Promise<TransitionResult> {
  const filePath = resolveAssignmentPath(projectDir, assignmentSlug);
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

export interface TransitionByDirOptions extends TransitionOptions {
  standalone?: boolean;
}

export async function executeTransitionByDir(
  assignmentDir: string,
  command: Exclude<TransitionCommand, 'assign'>,
  options: TransitionByDirOptions = {},
): Promise<TransitionResult> {
  const filePath = resolve(assignmentDir, 'assignment.md');
  const { content, frontmatter } = await readAssignment(filePath);

  // See executeTransition: from-specific mapping wins, commandTargets is the
  // guard-free fallback, built-ins only when no custom mechanism supplied.
  const targetStatus =
    (options.transitionTable
      ? getTargetStatus(frontmatter.status, command, options.transitionTable)
      : null) ??
    options.commandTargets?.get(command) ??
    (options.transitionTable ? null : getTargetStatus(frontmatter.status, command));
  if (!targetStatus) {
    return {
      success: false,
      message: `Unknown command '${command}' for assignment "${frontmatter.slug || assignmentDir}".`,
      fromStatus: frontmatter.status,
    };
  }

  const warnings: string[] = [];

  if (command === 'start' && !options.standalone && frontmatter.dependsOn.length > 0) {
    // Dependency check requires a project context — skip for standalone
    const projectDir = resolve(assignmentDir, '..', '..');
    const depCheck = await checkDependencies(
      projectDir,
      frontmatter.dependsOn,
      options.terminalStatuses,
    );
    if (!depCheck.satisfied) {
      warnings.push(`Starting with unmet dependencies: ${depCheck.unmet.join(', ')}`);
    }
  }

  const now = nowTimestamp();
  const updates: Partial<
    Pick<AssignmentFrontmatter, 'status' | 'assignee' | 'blockedReason' | 'updated' | 'disposition'>
  > = {
    status: targetStatus,
    updated: now,
  };

  if (ASSIGNEE_SETTING_COMMANDS.has(command) && options.agent && !frontmatter.assignee) {
    updates.assignee = options.agent;
  }
  if (command === 'block') {
    // Derived-status v3: the blocked disposition keys on blockedReason
    // PRESENCE — a null reason would make block-without-reason a silent
    // no-op under derivation. Match the CLI verb's default.
    updates.blockedReason = options.reason ?? '(unspecified)';
  }
  if (command === 'unblock') {
    updates.blockedReason = null;
  }

  // Dimension-aware terminal cache — see executeTransition.
  const terminalSetByDir = options.terminalStatuses ?? new Set(['completed', 'failed']);
  const enteringTerminalByDir =
    terminalSetByDir.has(targetStatus) && frontmatter.disposition !== 'terminal';
  if (enteringTerminalByDir) {
    updates.disposition = 'terminal';
  }

  let updatedContent = updateAssignmentFile(content, updates);
  // Only record a history entry on an ACTUAL status change (see executeTransition).
  if (targetStatus !== frontmatter.status) {
    updatedContent = appendStatusHistoryEntry(updatedContent, {
      at: now,
      from: frontmatter.status,
      to: targetStatus,
      command,
      by: options.agent ?? frontmatter.assignee ?? null,
      reason: command === 'block' ? options.reason : undefined,
      ...(enteringTerminalByDir
        ? { dispositionFrom: frontmatter.disposition, dispositionTo: 'terminal' }
        : {}),
    });
  }
  await writeFileForce(filePath, updatedContent);

  await applyLinkedTodosSideEffect(options.linkedTodosLookup, command, targetStatus, frontmatter);

  return {
    success: true,
    message: `Assignment "${frontmatter.slug || assignmentDir}" transitioned: ${frontmatter.status} -> ${targetStatus}`,
    fromStatus: frontmatter.status,
    toStatus: targetStatus,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export async function executeAssignByDir(
  assignmentDir: string,
  agent: string,
): Promise<TransitionResult> {
  const filePath = resolve(assignmentDir, 'assignment.md');
  const { content, frontmatter } = await readAssignment(filePath);

  const updates: Partial<Pick<AssignmentFrontmatter, 'status' | 'assignee' | 'blockedReason' | 'updated'>> = {
    assignee: agent,
    updated: nowTimestamp(),
  };

  const updatedContent = updateAssignmentFile(content, updates);
  await writeFileForce(filePath, updatedContent);

  return {
    success: true,
    message: `Assignment "${frontmatter.slug || assignmentDir}" assigned to '${agent}'.`,
    fromStatus: frontmatter.status,
  };
}

export async function executeUnassign(
  projectDir: string,
  assignmentSlug: string,
): Promise<TransitionResult> {
  const filePath = resolveAssignmentPath(projectDir, assignmentSlug);
  const { content, frontmatter } = await readAssignment(filePath);

  const updates: Partial<Pick<AssignmentFrontmatter, 'status' | 'assignee' | 'blockedReason' | 'updated'>> = {
    assignee: null,
    updated: nowTimestamp(),
  };

  const updatedContent = updateAssignmentFile(content, updates);
  await writeFileForce(filePath, updatedContent);

  return {
    success: true,
    message: `Assignment "${assignmentSlug}" unassigned (assignee cleared).`,
    fromStatus: frontmatter.status,
  };
}

export async function executeUnassignByDir(
  assignmentDir: string,
): Promise<TransitionResult> {
  const filePath = resolve(assignmentDir, 'assignment.md');
  const { content, frontmatter } = await readAssignment(filePath);

  const updates: Partial<Pick<AssignmentFrontmatter, 'status' | 'assignee' | 'blockedReason' | 'updated'>> = {
    assignee: null,
    updated: nowTimestamp(),
  };

  const updatedContent = updateAssignmentFile(content, updates);
  await writeFileForce(filePath, updatedContent);

  return {
    success: true,
    message: `Assignment "${frontmatter.slug || assignmentDir}" unassigned (assignee cleared).`,
    fromStatus: frontmatter.status,
  };
}
