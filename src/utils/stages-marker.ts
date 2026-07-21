/**
 * The stage-engine activation marker (Phase 1 / WS-2, flipped by WS-3's
 * `syntaur migrate-workflows`). Lives in its own LEAF module (paths/fs only) so
 * `config.ts` can consult it for the legacy-writer lockout (T9b) without a
 * config ⇄ lifecycle import cycle; `lifecycle/recompute.ts` re-exports these,
 * so the many existing `from '.../recompute.js'` import sites keep resolving.
 *
 * SEPARATE from `derive-migrated` on purpose (WS-2 Decision 2): the sweep
 * gates stay on `isDeriveMigrated()` so the ladder keeps moving the live
 * board; the engine-vs-ladder choice is a branch INSIDE `recomputeAndWrite`
 * gated on `isStagesMigrated() && ctx.stageWorkflow`.
 */

import { resolve } from 'node:path';
import { syntaurRoot } from './paths.js';
import { fileExists, writeFileForce } from './fs.js';
import { nowTimestamp } from './timestamp.js';

const STAGES_MARKER = 'stages-migrated';

export async function isStagesMigrated(): Promise<boolean> {
  return fileExists(resolve(syntaurRoot(), STAGES_MARKER));
}

export async function markStagesMigrated(): Promise<void> {
  await writeFileForce(resolve(syntaurRoot(), STAGES_MARKER), `${nowTimestamp()}\n`);
}
