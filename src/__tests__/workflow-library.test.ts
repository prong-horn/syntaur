import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadWorkflowLibrary,
  loadWorkflowIssues,
  invalidateWorkflowLibraryCache,
  DUAL_SOURCE_ERROR,
  type WorkflowLibraryConfigInput,
} from '../utils/workflow-library.js';

const originalHome = process.env.SYNTAUR_HOME;
let home: string;

// A minimal per-file workflow.
const FEATURE_MD = `id: feature
label: Feature
stages:
  - id: shaping
    next: [{ to: done }]
  - id: done
    terminal: true
`;

async function writeWorkflowFile(id: string, content: string): Promise<void> {
  const dir = join(home, 'workflows');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.md`), content, 'utf-8');
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wf-lib-'));
  process.env.SYNTAUR_HOME = home;
  invalidateWorkflowLibraryCache();
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = originalHome;
  invalidateWorkflowLibraryCache();
  await rm(home, { recursive: true, force: true });
});

const emptyConfig: WorkflowLibraryConfigInput = { workflows: null, statuses: null };

describe('loadWorkflowLibrary — single-source per-file loader (WS-0, D1)', () => {
  it('(a) dir-only: reads and parses each per-file workflow', async () => {
    await writeWorkflowFile('feature', FEATURE_MD);
    const library = loadWorkflowLibrary(emptyConfig);
    expect(Object.keys(library)).toEqual(['feature']);
    expect(library.feature.label).toBe('Feature');
    expect(library.feature.stages.map((s) => s.id)).toEqual(['shaping', 'done']);
  });

  it('(a) keys the map by the filename stem (the authoritative on-disk id)', async () => {
    // bug.md declares a mismatched internal id; the stem 'bug' is authoritative
    // and the parsed id is preserved for the doctor mismatch check.
    await writeWorkflowFile('bug', FEATURE_MD.replace('id: feature', 'id: bug-triage'));
    const library = loadWorkflowLibrary(emptyConfig);
    expect(Object.keys(library)).toEqual(['bug']);
    expect(library.bug.id).toBe('bug-triage');
  });

  it('(a) two files declaring the same internal id do NOT collide (keyed by stem)', async () => {
    await writeWorkflowFile('a', FEATURE_MD); // id: feature
    await writeWorkflowFile('b', FEATURE_MD); // id: feature
    const library = loadWorkflowLibrary(emptyConfig);
    expect(Object.keys(library).sort()).toEqual(['a', 'b']); // both present, no silent overwrite
  });

  it('(b) config-only: no per-file dir → returns {} and leaves the legacy library alone', async () => {
    // A live config.md workflows: block, but no per-file dir.
    const config: WorkflowLibraryConfigInput = { workflows: { default: {} }, statuses: null };
    expect(loadWorkflowLibrary(config)).toEqual({});
  });

  it('(c) both a per-file dir AND a PHYSICAL config.md block → hard-errors (no dual-source window)', async () => {
    await writeWorkflowFile('feature', FEATURE_MD);
    await writeFile(
      resolve(home, 'config.md'),
      '---\nversion: "2.0"\nworkflows:\n  default:\n    label: D\n---\n',
      'utf-8',
    );
    expect(() => loadWorkflowLibrary(emptyConfig)).toThrow(DUAL_SOURCE_ERROR);
  });

  it('(c) an INJECTED config block does NOT trip dual-source when the ambient config.md has none', async () => {
    // The dir is AMBIENT state, so the colliding block is judged from the
    // ambient config.md only. An injected config that came from anywhere else
    // (a test fixture, a stale pre-migration cache in a long-running dashboard)
    // says nothing about this machine — post-2026-07-21-migration, trusting it
    // produced false DUAL_SOURCE errors in 16 unsandboxed tests, and would have
    // bricked a stale-config dashboard instead of letting the dir win.
    await writeWorkflowFile('feature', FEATURE_MD);
    const withWorkflows: WorkflowLibraryConfigInput = { workflows: { default: {} }, statuses: null };
    expect(Object.keys(loadWorkflowLibrary(withWorkflows))).toEqual(['feature']); // dir wins

    const withStatuses: WorkflowLibraryConfigInput = { workflows: null, statuses: { statuses: [] } };
    expect(Object.keys(loadWorkflowLibrary(withStatuses))).toEqual(['feature']);
  });

  it('(c) also errors on an EMPTY/unparseable physical config block the in-memory config misses', async () => {
    // parseStatusConfig returns null for an empty `statuses:` block, so the
    // in-memory config shows no block — but the physical block is still a
    // colliding second source. config.md lives at <SYNTAUR_HOME>/config.md.
    await writeWorkflowFile('feature', FEATURE_MD);
    await writeFile(resolve(home, 'config.md'), '---\nversion: "2.0"\nstatuses:\n---\n', 'utf-8');
    expect(() => loadWorkflowLibrary(emptyConfig)).toThrow(DUAL_SOURCE_ERROR);
  });

  it('(d) neither dir nor block → {}', () => {
    expect(loadWorkflowLibrary(emptyConfig)).toEqual({});
  });

  it('caches by dir signature and re-reads after invalidation', async () => {
    await writeWorkflowFile('feature', FEATURE_MD);
    const first = loadWorkflowLibrary(emptyConfig);
    expect(first.feature.label).toBe('Feature');

    // Rewrite the file with a new label; without invalidation the cache holds.
    await writeWorkflowFile('feature', FEATURE_MD.replace('label: Feature', 'label: Renamed'));
    invalidateWorkflowLibraryCache();
    const second = loadWorkflowLibrary(emptyConfig);
    expect(second.feature.label).toBe('Renamed');
  });

  it('loadWorkflowIssues surfaces per-file parse issues keyed by stem', async () => {
    await writeWorkflowFile('feature', 'stages:\n  - id: done\n    terminal: true\n'); // no id:
    const issues = loadWorkflowIssues(emptyConfig);
    expect(issues.feature?.some((m) => m.includes("missing 'id'"))).toBe(true);
    // A well-formed file contributes no issues.
    await writeWorkflowFile('clean', FEATURE_MD);
    invalidateWorkflowLibraryCache();
    expect(loadWorkflowIssues(emptyConfig).clean).toBeUndefined();
  });

  it('ignores dotfiles and non-.md entries in the dir', async () => {
    await writeWorkflowFile('feature', FEATURE_MD);
    const dir = join(home, 'workflows');
    await writeFile(join(dir, '.hidden.md'), 'id: hidden\nstages: []\n', 'utf-8');
    await writeFile(join(dir, 'notes.txt'), 'ignore me', 'utf-8');
    expect(Object.keys(loadWorkflowLibrary(emptyConfig))).toEqual(['feature']);
  });
});
