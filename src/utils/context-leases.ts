/**
 * Read / append / remove the `leases: []` array in `.syntaur/context.json`.
 *
 * Refuses to operate on a context file that is missing OR has neither
 * `sessionId` nor any assignment-binding field — writing a leases-only
 * context file would otherwise trip the doctor workspace check at
 * `src/utils/doctor/checks/workspace.ts:78–90`.
 *
 * Atomic write: read → mutate → write to `<path>.tmp` → `rename` into place.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface ContextLeaseEntry {
  lease_id: string;
  inventory_slug: string;
  member_id: string;
  expires_at: string;
  metadata: Record<string, unknown> | null;
  claimed_at: string;
}

export class MissingAssignmentContextError extends Error {
  constructor(public readonly contextPath: string) {
    super(
      `no Syntaur context at ${contextPath} — grab an assignment first (syntaur grab-assignment or /grab-assignment)`,
    );
    this.name = 'MissingAssignmentContextError';
  }
}

const ASSIGNMENT_KEYS = ['projectSlug', 'assignmentSlug', 'assignmentDir'] as const;

function contextPath(cwd: string): string {
  return resolve(cwd, '.syntaur', 'context.json');
}

async function loadContext(cwd: string): Promise<Record<string, unknown>> {
  const path = contextPath(cwd);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new MissingAssignmentContextError(path);
    }
    throw err;
  }
  const data = JSON.parse(raw) as Record<string, unknown>;
  // Presence gate only — "is there any real context here". The sessionId scalar
  // is a clobberable hint, not identity (resolve identity via
  // resolveOwnSessionId); its PRESENCE, or a transcriptPath, is enough to say a
  // standalone session context exists. Co-tenant-safe.
  const hasSession =
    (typeof data.sessionId === 'string' && data.sessionId.length > 0) ||
    (typeof data.transcriptPath === 'string' && data.transcriptPath.length > 0);
  const hasAssignment = ASSIGNMENT_KEYS.some((k) => {
    const v = data[k];
    return typeof v === 'string' && v.length > 0;
  });
  if (!hasSession && !hasAssignment) {
    throw new MissingAssignmentContextError(path);
  }
  return data;
}

async function saveContext(cwd: string, data: Record<string, unknown>): Promise<void> {
  const path = contextPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

function asLeaseArray(value: unknown): ContextLeaseEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (e): e is ContextLeaseEntry =>
      !!e &&
      typeof e === 'object' &&
      typeof (e as ContextLeaseEntry).lease_id === 'string',
  );
}

export async function readContextLeases(cwd: string): Promise<ContextLeaseEntry[]> {
  const data = await loadContext(cwd);
  return asLeaseArray(data.leases);
}

export async function appendContextLease(
  cwd: string,
  entry: ContextLeaseEntry,
): Promise<void> {
  const data = await loadContext(cwd);
  const existing = asLeaseArray(data.leases).filter((e) => e.lease_id !== entry.lease_id);
  data.leases = [...existing, entry];
  await saveContext(cwd, data);
}

export async function removeContextLease(cwd: string, lease_id: string): Promise<void> {
  const data = await loadContext(cwd);
  const existing = asLeaseArray(data.leases);
  data.leases = existing.filter((e) => e.lease_id !== lease_id);
  await saveContext(cwd, data);
}
