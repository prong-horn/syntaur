import { resolve } from 'node:path';
import { syntaurRoot } from '../utils/paths.js';
import {
  acquireOwnerRecord,
  ownerIdentityMatches,
  readOwnerRecord,
  recoverStaleOwnerRecord,
  type AcquiredOwnerHandle,
  type OwnerRecord,
} from '../utils/process-owner.js';
export type HomeOwnerHandle = AcquiredOwnerHandle;

export interface HomeRuntimeIdentity {
  pid: number;
  processStartedAt: string | null;
  ownerToken: string;
  port: number;
}

export function brokerOwnerPath(root?: string): string {
  return resolve(root ?? syntaurRoot(), 'runtime', 'broker-owner');
}

export async function acquireHomeOwnerLock(
  port?: number,
  root?: string,
): Promise<HomeOwnerHandle> {
  const path = brokerOwnerPath(root);
  return acquireOwnerRecord(path, port, root);
}

export async function readHomeOwnerRecord(root?: string): Promise<OwnerRecord | null> {
  return readOwnerRecord(brokerOwnerPath(root));
}

export async function recoverHomeOwnerRecord(root?: string): Promise<boolean> {
  return recoverStaleOwnerRecord(brokerOwnerPath(root), root);
}

/**
 * Verify that a runtime identity response matches the live broker-owner record
 * for this home. Returns false when the record is missing or mismatched.
 */
export async function verifyHomeOwnerRuntime(
  runtime: HomeRuntimeIdentity,
  root?: string,
): Promise<boolean> {
  const record = await readHomeOwnerRecord(root);
  if (!record) return false;
  if (record.port !== undefined && record.port !== runtime.port) return false;
  return ownerIdentityMatches(
    record,
    runtime.pid,
    runtime.processStartedAt,
    runtime.ownerToken,
  );
}
