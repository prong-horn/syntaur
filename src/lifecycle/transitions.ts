import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { resolveTicketMdPathInProject } from '../utils/ticket-resolver.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { getTargetStatus } from './state-machine.js';
import { appendStatusHistoryEntry, parseTicketFrontmatter, updateTicketFile } from './frontmatter.js';
import { recordStatusEvent, resolveActor, emitEvent } from './event-emit.js';
import type { TransitionCommand, TransitionResult, TicketFrontmatter } from './types.js';

async function resolveTicketPath(projectDir: string, ticketSlug: string): Promise<string> {
  const path = await resolveTicketMdPathInProject(projectDir, ticketSlug);
  return path ?? resolve(projectDir, 'tickets', ticketSlug, 'ticket.md');
}

async function readTicket(
  filePath: string,
): Promise<{ content: string; frontmatter: TicketFrontmatter }> {
  if (!(await fileExists(filePath))) {
    throw new Error(`Ticket file not found: ${filePath}`);
  }
  const content = await readFile(filePath, 'utf-8');
  const frontmatter = parseTicketFrontmatter(content);
  return { content, frontmatter };
}

/**
 * Resolve which of a ticket's `dependsOn` targets are not yet terminal.
 * Exported so derive verbs (`start`/`implement`) can surface the same
 * non-blocking unmet-dependency warning the legacy transition path emits.
 */
export async function checkDependencies(
  projectDir: string,
  dependsOn: string[],
  terminalStatuses?: ReadonlySet<string>,
): Promise<{ satisfied: boolean; unmet: string[] }> {
  const terminals = terminalStatuses ?? new Set(['completed']);
  const unmet: string[] = [];
  for (const depId of dependsOn) {
    const depPath = await resolveTicketPath(projectDir, depId);
    if (!(await fileExists(depPath))) {
      unmet.push(`${depId} (file not found)`);
      continue;
    }
    const depContent = await readFile(depPath, 'utf-8');
    const depFrontmatter = parseTicketFrontmatter(depContent);
    if (!terminals.has(depFrontmatter.status)) {
      unmet.push(`${depId} (status: ${depFrontmatter.status})`);
    }
  }
  return { satisfied: unmet.length === 0, unmet };
}

export interface TransitionOptions {
  reason?: string;
  agent?: string;
  /**
   * Actor to attribute the audit status-event to, INDEPENDENT of `agent` (which
   * drives assignee mutation). Dashboard transition routes pass `'human'` here
   * so a click on an already-assigned task is recorded as `human`, not the
   * assignee. When unset, falls back to `agent ?? frontmatter.assignee`.
   */
  auditActor?: string;
  transitionTable?: Map<string, string>;
  /** Guard-free custom targets: when provided (and no transitionTable), the
   * command resolves to this map's target regardless of the current status —
   * preserving a CUSTOM terminal target (e.g. complete -> done) without the
   * from:command guard, even for tickets on legacy/undefined statuses. */
  commandTargets?: Map<string, string>;
  terminalStatuses?: ReadonlySet<string>;
}

const ASSIGNEE_SETTING_COMMANDS = new Set(['start', 'shape', 'plan-ready', 'implement']);

export async function executeTransition(
  projectDir: string,
  ticketSlug: string,
  command: Exclude<TransitionCommand, 'assign'>,
  options: TransitionOptions = {},
): Promise<TransitionResult> {
  const filePath = await resolveTicketPath(projectDir, ticketSlug);
  const { content, frontmatter } = await readTicket(filePath);

  // Resolution order: a from-specific custom mapping wins; the guard-free
  // commandTargets fallback covers legacy/undefined statuses; built-ins last
  // (only when neither custom mechanism was supplied).
  const targetStatus =
    (options.transitionTable
      ? getTargetStatus(frontmatter.status, command, options.transitionTable)
      : null) ??
    options.commandTargets?.get(command) ??
    // Built-ins apply only when NEITHER custom mechanism was supplied — a
    // provided-but-miss commandTargets means "custom config had no answer",
    // which must refuse, not silently fall back (codex r4).
    (!options.transitionTable && !options.commandTargets
      ? getTargetStatus(frontmatter.status, command)
      : null);

  if (!targetStatus) {
    return {
      success: false,
      message: `Unknown command '${command}' for ticket "${ticketSlug}".`,
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
    Pick<TicketFrontmatter, 'status' | 'assignee' | 'blockedReason' | 'updated' | 'disposition'>
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

  let updatedContent = updateTicketFile(content, updates);
  // Only record a history entry on an ACTUAL status change. CLI commands are
  // guard-free (getTargetStatus returns the canonical target regardless of the
  // current status), so re-running e.g. `complete` on an already-completed
  // ticket must not append a from===to entry and reset statusAge.
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

  // Audit event (best-effort): self-guards on from===to (R5). The audit actor
  // is independent of `agent` (which drives assignee mutation) — dashboard
  // routes pass `auditActor: 'human'` so a click is not recorded as the
  // assignee (FIX 1).
  recordStatusEvent({
    ticketId: frontmatter.id,
    projectSlug: frontmatter.project,
    at: now,
    actor: resolveActor(options.auditActor ?? options.agent ?? frontmatter.assignee ?? null),
    from: frontmatter.status,
    to: targetStatus,
    command,
  });

  return {
    success: true,
    message: `Ticket "${ticketSlug}" transitioned: ${frontmatter.status} -> ${targetStatus}`,
    fromStatus: frontmatter.status,
    toStatus: targetStatus,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export async function executeAssign(
  projectDir: string,
  ticketSlug: string,
  agent: string,
): Promise<TransitionResult> {
  const filePath = await resolveTicketPath(projectDir, ticketSlug);
  const { content, frontmatter } = await readTicket(filePath);

  const updates: Partial<Pick<TicketFrontmatter, 'status' | 'assignee' | 'blockedReason' | 'updated'>> = {
    assignee: agent,
    updated: nowTimestamp(),
  };

  const updatedContent = updateTicketFile(content, updates);
  await writeFileForce(filePath, updatedContent);

  // Audit event (best-effort): assignee changed from prior to `agent`.
  if (frontmatter.assignee !== agent) {
    emitEvent({
      ticketId: frontmatter.id,
      projectSlug: frontmatter.project,
      type: 'assignee-change',
      actor: resolveActor(agent ?? frontmatter.assignee ?? null),
      details: { from: frontmatter.assignee, to: agent },
    });
  }

  return {
    success: true,
    message: `Ticket "${ticketSlug}" assigned to '${agent}'.`,
    fromStatus: frontmatter.status,
  };
}

export interface TransitionByDirOptions extends TransitionOptions {
  standalone?: boolean;
}

export async function executeTransitionByDir(
  ticketDir: string,
  command: Exclude<TransitionCommand, 'assign'>,
  options: TransitionByDirOptions = {},
): Promise<TransitionResult> {
  const filePath = resolve(ticketDir, 'ticket.md');
  const { content, frontmatter } = await readTicket(filePath);

  // See executeTransition: from-specific mapping wins, commandTargets is the
  // guard-free fallback, built-ins only when no custom mechanism supplied.
  const targetStatus =
    (options.transitionTable
      ? getTargetStatus(frontmatter.status, command, options.transitionTable)
      : null) ??
    options.commandTargets?.get(command) ??
    // Built-ins apply only when NEITHER custom mechanism was supplied — a
    // provided-but-miss commandTargets means "custom config had no answer",
    // which must refuse, not silently fall back (codex r4).
    (!options.transitionTable && !options.commandTargets
      ? getTargetStatus(frontmatter.status, command)
      : null);
  if (!targetStatus) {
    return {
      success: false,
      message: `Unknown command '${command}' for ticket "${frontmatter.slug || ticketDir}".`,
      fromStatus: frontmatter.status,
    };
  }

  const warnings: string[] = [];

  if (command === 'start' && !options.standalone && frontmatter.dependsOn.length > 0) {
    // Dependency check requires a project context — skip for standalone
    const projectDir = resolve(ticketDir, '..', '..');
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
    Pick<TicketFrontmatter, 'status' | 'assignee' | 'blockedReason' | 'updated' | 'disposition'>
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

  let updatedContent = updateTicketFile(content, updates);
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

  // Audit event (best-effort): self-guards on from===to (R5). The audit actor
  // is independent of `agent` (see executeTransition / FIX 1).
  recordStatusEvent({
    ticketId: frontmatter.id,
    projectSlug: frontmatter.project,
    at: now,
    actor: resolveActor(options.auditActor ?? options.agent ?? frontmatter.assignee ?? null),
    from: frontmatter.status,
    to: targetStatus,
    command,
  });

  return {
    success: true,
    message: `Ticket "${frontmatter.slug || ticketDir}" transitioned: ${frontmatter.status} -> ${targetStatus}`,
    fromStatus: frontmatter.status,
    toStatus: targetStatus,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export async function executeAssignByDir(
  ticketDir: string,
  agent: string,
): Promise<TransitionResult> {
  const filePath = resolve(ticketDir, 'ticket.md');
  const { content, frontmatter } = await readTicket(filePath);

  const updates: Partial<Pick<TicketFrontmatter, 'status' | 'assignee' | 'blockedReason' | 'updated'>> = {
    assignee: agent,
    updated: nowTimestamp(),
  };

  const updatedContent = updateTicketFile(content, updates);
  await writeFileForce(filePath, updatedContent);

  if (frontmatter.assignee !== agent) {
    emitEvent({
      ticketId: frontmatter.id,
      projectSlug: frontmatter.project,
      type: 'assignee-change',
      actor: resolveActor(agent ?? frontmatter.assignee ?? null),
      details: { from: frontmatter.assignee, to: agent },
    });
  }

  return {
    success: true,
    message: `Ticket "${frontmatter.slug || ticketDir}" assigned to '${agent}'.`,
    fromStatus: frontmatter.status,
  };
}

export async function executeUnassign(
  projectDir: string,
  ticketSlug: string,
): Promise<TransitionResult> {
  const filePath = await resolveTicketPath(projectDir, ticketSlug);
  const { content, frontmatter } = await readTicket(filePath);

  const updates: Partial<Pick<TicketFrontmatter, 'status' | 'assignee' | 'blockedReason' | 'updated'>> = {
    assignee: null,
    updated: nowTimestamp(),
  };

  const updatedContent = updateTicketFile(content, updates);
  await writeFileForce(filePath, updatedContent);

  if (frontmatter.assignee !== null) {
    emitEvent({
      ticketId: frontmatter.id,
      projectSlug: frontmatter.project,
      type: 'assignee-change',
      actor: resolveActor(frontmatter.assignee),
      details: { from: frontmatter.assignee, to: null },
    });
  }

  return {
    success: true,
    message: `Ticket "${ticketSlug}" unassigned (assignee cleared).`,
    fromStatus: frontmatter.status,
  };
}

export async function executeUnassignByDir(
  ticketDir: string,
): Promise<TransitionResult> {
  const filePath = resolve(ticketDir, 'ticket.md');
  const { content, frontmatter } = await readTicket(filePath);

  const updates: Partial<Pick<TicketFrontmatter, 'status' | 'assignee' | 'blockedReason' | 'updated'>> = {
    assignee: null,
    updated: nowTimestamp(),
  };

  const updatedContent = updateTicketFile(content, updates);
  await writeFileForce(filePath, updatedContent);

  if (frontmatter.assignee !== null) {
    emitEvent({
      ticketId: frontmatter.id,
      projectSlug: frontmatter.project,
      type: 'assignee-change',
      actor: resolveActor(frontmatter.assignee),
      details: { from: frontmatter.assignee, to: null },
    });
  }

  return {
    success: true,
    message: `Ticket "${frontmatter.slug || ticketDir}" unassigned (assignee cleared).`,
    fromStatus: frontmatter.status,
  };
}
