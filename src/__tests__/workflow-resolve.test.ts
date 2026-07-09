import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveWorkflowId, getWorkflowBundle, getWorkflowLibrary } from '../utils/workflow-resolve.js';
import type { WorkflowDefinition } from '../utils/config.js';

const available = new Set(['default', 'feature', 'bugfix', 'research']);

function base() {
  return {
    assignmentWorkflow: null as string | null,
    assignmentType: null as string | null,
    projectDefaultWorkflow: null as string | null,
    projectWorkflowByType: null as Record<string, string> | null,
    globalDefaultWorkflow: null as string | null,
    available,
  };
}

describe('resolveWorkflowId — first-hit-wins binding', () => {
  it('an explicit assignment workflow always wins', () => {
    expect(
      resolveWorkflowId({
        ...base(),
        assignmentWorkflow: 'feature',
        assignmentType: 'bug',
        projectWorkflowByType: { bug: 'bugfix' },
        projectDefaultWorkflow: 'research',
        globalDefaultWorkflow: 'research',
      }),
    ).toBe('feature');
  });

  it('falls to the type map when there is no assignment override', () => {
    expect(
      resolveWorkflowId({
        ...base(),
        assignmentType: 'bug',
        projectWorkflowByType: { bug: 'bugfix' },
        projectDefaultWorkflow: 'research',
      }),
    ).toBe('bugfix');
  });

  it('falls to the project default when the type is unmapped', () => {
    expect(
      resolveWorkflowId({
        ...base(),
        assignmentType: 'chore',
        projectWorkflowByType: { bug: 'bugfix' },
        projectDefaultWorkflow: 'research',
        globalDefaultWorkflow: 'feature',
      }),
    ).toBe('research');
  });

  it('falls to the global default when the project sets nothing', () => {
    expect(resolveWorkflowId({ ...base(), globalDefaultWorkflow: 'feature' })).toBe('feature');
  });

  it("terminates at 'default' when nothing is bound", () => {
    expect(resolveWorkflowId(base())).toBe('default');
  });

  it('skips a candidate id that is not in the available set (deleted/renamed) and falls through', () => {
    expect(
      resolveWorkflowId({
        ...base(),
        assignmentWorkflow: 'ghost', // deleted workflow
        assignmentType: 'bug',
        projectWorkflowByType: { bug: 'gone' }, // also deleted
        projectDefaultWorkflow: 'research', // resolvable
      }),
    ).toBe('research');
  });

  it("terminates at 'default' even when every candidate is unavailable", () => {
    expect(
      resolveWorkflowId({
        ...base(),
        assignmentWorkflow: 'ghost',
        globalDefaultWorkflow: 'also-gone',
      }),
    ).toBe('default');
  });
});

describe('getWorkflowBundle', () => {
  const feature: WorkflowDefinition = {
    label: 'Feature',
    statuses: [{ id: 'draft', label: 'Draft' }],
    order: ['draft'],
    transitions: [],
    derive: null,
    facts: null,
  };

  it('returns the named workflow bundle when present', () => {
    expect(getWorkflowBundle({ workflows: { feature } }, 'feature')).toBe(feature);
  });

  it('synthesizes the default from config.statuses when no workflows block exists', () => {
    const statuses = {
      statuses: [{ id: 'todo', label: 'Todo' }],
      order: ['todo'],
      transitions: [],
    };
    const bundle = getWorkflowBundle({ workflows: null, statuses }, 'default');
    expect(bundle.label).toBe('Default');
    expect(bundle.order).toEqual(['todo']);
  });

  it('synthesizes from the built-in defaults when both workflows and statuses are absent', () => {
    const bundle = getWorkflowBundle({ workflows: null, statuses: null }, 'default');
    expect(bundle.label).toBe('Default');
    // Built-in default lifecycle includes the canonical in_progress/completed set.
    expect(bundle.order).toContain('in_progress');
    expect(bundle.statuses.find((s) => s.id === 'completed')?.terminal).toBe(true);
  });
});

describe('getWorkflowLibrary — in-memory {default} view of a legacy config', () => {
  const feature: WorkflowDefinition = {
    label: 'Feature',
    statuses: [{ id: 'draft', label: 'Draft' }],
    order: ['draft'],
    transitions: [],
    derive: null,
    facts: null,
  };

  it('returns the explicit workflows library verbatim when present', () => {
    const lib = getWorkflowLibrary({ workflows: { feature } });
    expect(lib).toEqual({ feature });
  });

  it('treats a legacy statuses-only config as { default }', () => {
    const statuses = { statuses: [{ id: 'todo', label: 'Todo' }], order: ['todo'], transitions: [] };
    const lib = getWorkflowLibrary({ workflows: null, statuses });
    expect(Object.keys(lib)).toEqual(['default']);
    expect(lib.default.label).toBe('Default');
    expect(lib.default.order).toEqual(['todo']);
  });

  it('falls back to the built-in default when neither is present', () => {
    const lib = getWorkflowLibrary({ workflows: null, statuses: null });
    expect(Object.keys(lib)).toEqual(['default']);
    expect(lib.default.order).toContain('in_progress');
  });
});

// Purity guard (WS-0): `workflow-resolve.ts` and `stage-model.ts` are aliased
// into the dashboard SPA via `@shared`, so a stray Node import (`node:fs`,
// `fs`, `node:path`, …) would break the browser bundle. This test reads the
// source and fails on any Node-builtin import — a tripwire so a future edit
// can't silently re-introduce disk I/O into the browser-safe modules. All fs
// lives in the Node-only `workflow-library.ts` loader.
describe('browser-safe purity guard', () => {
  const NODE_IMPORT = /(?:from\s+['"]|import\s*\(\s*['"]|require\(\s*['"])(?:node:|fs|path|os|child_process|crypto|stream|util|worker_threads)(?:['"/])/;

  for (const rel of ['../utils/workflow-resolve.ts', '../utils/stage-model.ts']) {
    it(`${rel} imports no Node builtins`, () => {
      const src = readFileSync(new URL(rel, import.meta.url), 'utf-8');
      const offending = src
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
        .filter((line) => NODE_IMPORT.test(line));
      expect(offending).toEqual([]);
    });
  }
});
