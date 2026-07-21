import { beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Point `SYNTAUR_HOME` at a throwaway root for every test in the calling file.
 *
 * Call once at module top (outside any describe). Registers a beforeEach that
 * runs BEFORE the file's own hooks (vitest runs beforeEach in registration
 * order), so fixture setup already sees the sandbox; the paired afterEach runs
 * LAST (reverse order), restoring the prior env and removing the root.
 *
 * Why: `syntaurRoot()`-based helpers (the per-file workflow loader, the
 * stages-migrated marker, config reads) resolve AMBIENT machine state. A test
 * that passes fixture configs without sandboxing `SYNTAUR_HOME` silently reads
 * the developer's real `~/.syntaur` — green or red depending on the machine.
 * This bit for real on 2026-07-21: the live stage-engine migration created
 * `~/.syntaur/workflows/`, and 16 unsandboxed tests started throwing false
 * DUAL_SOURCE errors (fixture config block + the real migrated dir). Tests
 * that sandbox via a temp `HOME` instead must keep doing that — `SYNTAUR_HOME`
 * would override their convention; this helper is for files that don't manage
 * a root of their own.
 */
export function useHermeticSyntaurHome(): void {
  let prior: string | undefined;
  let root: string | null = null;
  beforeEach(async () => {
    prior = process.env.SYNTAUR_HOME;
    root = await mkdtemp(join(tmpdir(), 'syntaur-hermetic-root-'));
    process.env.SYNTAUR_HOME = root;
  });
  afterEach(async () => {
    if (prior === undefined) delete process.env.SYNTAUR_HOME;
    else process.env.SYNTAUR_HOME = prior;
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
  });
}
