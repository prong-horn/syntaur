import type { TodoItem, LogEntry } from '../todos/types.js';
import {
  readChecklist,
  writeChecklist,
  appendLogEntry,
} from '../todos/parser.js';
import { createAssignmentCommand } from '../commands/create-assignment.js';
import { isValidSlug } from './slug.js';

// Thrown when a promote target is rejected because one of the source todos
// belongs to a bundle. Dashboard routes catch this and translate to HTTP 400.
export class BundlePromoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundlePromoteError';
  }
}

export interface PromoteSourceGroup {
  /** Workspace todos dir OR projectTodosDir(...) for project-scope todos. */
  todosDir: string;
  /** Checklist workspace key (e.g. `_global`, `alpha`, or project slug for project todos). */
  workspace: string;
  /** Selected items from that checklist (already validated as non-completed). */
  items: TodoItem[];
  /** Human-readable scope label for log entries: `workspace:alpha` | `_global` | `project:foo`. */
  scopeLabel: string;
}

export type PromoteTarget =
  | { project: string }
  | { oneOff: true; workspaceGroup?: string };

export interface PromoteToNewAssignmentOptions {
  title: string;
  target: PromoteTarget;
  type?: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  keepSource?: boolean;
}

export interface PromoteToNewAssignmentResult {
  id: string;
  slug: string;
  projectSlug: string | null;
  assignmentDir: string;
  assignmentRef: string;
  promoted: Array<{ workspace: string; id: string }>;
  promotedByWorkspace: Array<{ workspace: string; ids: string[] }>;
}

/**
 * Parse the JSON `target` field from a promote request body into the helper's
 * typed target. Returns `{ error }` for invalid combinations so callers can
 * surface the message verbatim (matching legacy validation messages where
 * possible).
 */
export function parsePromoteTarget(
  target: unknown,
):
  | { ok: true; target: PromoteTarget }
  | { ok: false; error: string } {
  if (!target || typeof target !== 'object') {
    return { ok: false, error: 'target is required for new-assignment mode' };
  }
  const t = target as Record<string, unknown>;
  const hasProject = typeof t.project === 'string' && t.project.length > 0;
  const hasOneOff = t.oneOff === true;
  if (hasProject && hasOneOff) {
    return { ok: false, error: 'target cannot specify both project and oneOff' };
  }
  if (hasProject) {
    const project = t.project as string;
    if (!isValidSlug(project)) {
      return { ok: false, error: `Invalid target.project slug "${project}"` };
    }
    return { ok: true, target: { project } };
  }
  if (hasOneOff) {
    const wg = typeof t.workspaceGroup === 'string' ? t.workspaceGroup : undefined;
    if (wg !== undefined && !isValidSlug(wg)) {
      return { ok: false, error: `Invalid target.workspaceGroup slug "${wg}"` };
    }
    return { ok: true, target: { oneOff: true, workspaceGroup: wg } };
  }
  return { ok: false, error: 'target.project is required for new-assignment mode' };
}

function touchItem(item: TodoItem): void {
  const now = new Date().toISOString();
  if (item.createdAt === null) item.createdAt = now;
  item.updatedAt = now;
}

/**
 * Create a new assignment from the selected todos' descriptions and link the
 * source todos back to it. Source todos flip to `in_progress` with
 * `linkedAssignmentId` (UUID) and `linkedAssignmentRef` (`projectSlug/slug` or
 * bare UUID for one-off) populated, unless `keepSource` is true in which case
 * the source checklists are left untouched.
 */
export async function promoteTodosToNewAssignment(
  groups: PromoteSourceGroup[],
  options: PromoteToNewAssignmentOptions,
): Promise<PromoteToNewAssignmentResult> {
  if (groups.length === 0 || groups.every((g) => g.items.length === 0)) {
    throw new Error('At least one source todo is required to promote.');
  }
  if (!options.title.trim()) {
    throw new Error('Title is required.');
  }
  // Bundle exclusivity (Decision 4 of todo-bundles plan): a todo that is
  // part of a bundle cannot be promoted to an assignment. The bundle owns
  // a shared worktree/branch; promoting would fork it.
  for (const group of groups) {
    for (const it of group.items) {
      if (it.bundleId !== null) {
        throw new BundlePromoteError(
          `Todo [t:${it.id}] is part of bundle b:${it.bundleId}; run \`syntaur todo bundle remove b:${it.bundleId} ${it.id}\` first.`,
        );
      }
    }
  }

  const acceptanceCriteria: string[] = [];
  for (const g of groups) {
    for (const it of g.items) acceptanceCriteria.push(it.description);
  }

  const oneOff = 'oneOff' in options.target;
  const created = await createAssignmentCommand(options.title, {
    project: oneOff ? undefined : (options.target as { project: string }).project,
    oneOff: oneOff ? true : undefined,
    workspace: oneOff ? (options.target as { oneOff: true; workspaceGroup?: string }).workspaceGroup : undefined,
    type: options.type,
    priority: options.priority,
    acceptanceCriteria,
    withTodos: false,
    silent: true,
  });

  const assignmentRef = created.projectSlug
    ? `${created.projectSlug}/${created.slug}`
    : created.id;

  const promoted: Array<{ workspace: string; id: string }> = [];
  const promotedByWorkspace: Array<{ workspace: string; ids: string[] }> = [];

  if (!options.keepSource) {
    for (const group of groups) {
      // Re-read the checklist (caller is expected to hold the workspace lock
      // around this call when concurrency matters).
      const checklist = await readChecklist(group.todosDir, group.workspace);
      const idsTouched: string[] = [];
      for (const sel of group.items) {
        const item = checklist.items.find((i) => i.id === sel.id);
        if (!item) continue;
        item.status = 'in_progress';
        item.session = null;
        item.linkedAssignmentId = created.id;
        item.linkedAssignmentRef = assignmentRef;
        touchItem(item);
        idsTouched.push(item.id);
      }
      await writeChecklist(group.todosDir, checklist);
      for (const id of idsTouched) {
        const sourceItem = group.items.find((i) => i.id === id);
        const entry: LogEntry = {
          timestamp: new Date().toISOString(),
          itemIds: [id],
          items: sourceItem?.description ?? '',
          session: null,
          branch: sourceItem?.branch ?? null,
          summary: `Linked to assignment ${assignmentRef} (auto-promoted from ${group.scopeLabel})`,
          blockers: null,
          status: null,
        };
        await appendLogEntry(group.todosDir, group.workspace, entry);
        promoted.push({ workspace: group.workspace, id });
      }
      if (idsTouched.length > 0) {
        promotedByWorkspace.push({ workspace: group.workspace, ids: idsTouched });
      }
    }
  }

  return {
    id: created.id,
    slug: created.slug,
    projectSlug: created.projectSlug,
    assignmentDir: created.assignmentDir,
    assignmentRef,
    promoted,
    promotedByWorkspace,
  };
}
