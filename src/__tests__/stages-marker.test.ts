import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isStagesMigrated,
  markStagesMigrated,
  isDeriveMigrated,
  markDeriveMigrated,
} from '../lifecycle/recompute.js';

// WS-2 Task 2.1: the `stages-migrated` activation marker. Separate from
// `derive-migrated` (Decision 2) — flipping one must not flip the other.
describe('stages-migrated marker', () => {
  let home: string;
  let priorHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'stages-marker-'));
    priorHome = process.env.SYNTAUR_HOME;
    process.env.SYNTAUR_HOME = home;
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.SYNTAUR_HOME;
    else process.env.SYNTAUR_HOME = priorHome;
    await rm(home, { recursive: true, force: true });
  });

  it('is false when the marker file is absent', async () => {
    await expect(isStagesMigrated()).resolves.toBe(false);
  });

  it('is true after markStagesMigrated()', async () => {
    await markStagesMigrated();
    await expect(isStagesMigrated()).resolves.toBe(true);
  });

  it('is independent of the derive-migrated marker (Decision 2)', async () => {
    await markDeriveMigrated();
    // derive-migrated set, stages-migrated NOT set → the live ladder still runs.
    await expect(isDeriveMigrated()).resolves.toBe(true);
    await expect(isStagesMigrated()).resolves.toBe(false);

    await markStagesMigrated();
    await expect(isStagesMigrated()).resolves.toBe(true);
    await expect(isDeriveMigrated()).resolves.toBe(true);
  });
});
