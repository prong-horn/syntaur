import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildWorkflowContext,
  makeWorkflowContextResolver,
  resolveTicketWorkflowContext,
  resolveTicketWorkflowId,
  type WorkflowConfigView,
} from '../lifecycle/workflow-context.js';
import { DEFAULT_DERIVE_CONFIG } from '../utils/derive-config.js';
import type { ProjectWorkflowBinding } from '../utils/project-binding.js';
import type { StatusConfig, WorkflowDefinition } from '../utils/config.js';
import { useHermeticSyntaurHome } from './hermetic-root.js';

// Hermetic root: these tests pass fixture configs; without a sandboxed
// SYNTAUR_HOME they read the developer’s real ~/.syntaur (ambient workflows
// dir + stages-migrated marker) — false DUAL_SOURCE errors post-2026-07-21.
useHermeticSyntaurHome();

const EMPTY: ProjectWorkflowBinding = { defaultWorkflow: null, workflowByType: {} };

// A distinct derive object so we can assert per-workflow derive selection by
// REFERENCE (buildDeriveContext returns `bundle.derive ?? DEFAULT_DERIVE_CONFIG`).
const bugDerive = { ...DEFAULT_DERIVE_CONFIG };

const bug: WorkflowDefinition = {
  label: 'Bug Flow',
  statuses: [
    { id: 'open', label: 'Open', terminal: false },
    { id: 'fixing', label: 'Fixing In Progress', terminal: false },
    { id: 'verified', label: 'Verified', terminal: true },
  ],
  order: ['open', 'fixing', 'verified'],
  transitions: [
    { from: 'open', command: 'start', to: 'fixing' },
    { from: 'fixing', command: 'verify', to: 'verified' },
  ],
  derive: bugDerive,
  facts: null,
};

const feature: WorkflowDefinition = {
  label: 'Feature',
  statuses: [
    { id: 'todo', label: 'To Do', terminal: false },
    { id: 'shipped', label: 'Shipped', terminal: true },
  ],
  order: ['todo', 'shipped'],
  transitions: [{ from: 'todo', command: 'ship', to: 'shipped' }],
  derive: null,
  facts: null,
};

const config: WorkflowConfigView = {
  workflows: { bug, feature },
  statuses: null,
  defaultWorkflow: null,
};

describe('resolveTicketWorkflowId — first-hit-wins precedence', () => {
  it('ticket `workflow:` wins over everything', () => {
    const binding: ProjectWorkflowBinding = {
      defaultWorkflow: 'feature',
      workflowByType: { bug: 'feature' },
    };
    expect(resolveTicketWorkflowId(config, binding, { workflow: 'bug', template: 'bug' })).toBe(
      'bug',
    );
  });

  it('falls to project workflowByType[type] when no ticket override', () => {
    const binding: ProjectWorkflowBinding = {
      defaultWorkflow: 'feature',
      workflowByType: { bug: 'bug' },
    };
    expect(resolveTicketWorkflowId(config, binding, { workflow: null, template: 'bug' })).toBe(
      'bug',
    );
  });

  it('falls to project defaultWorkflow when type is unmapped', () => {
    const binding: ProjectWorkflowBinding = { defaultWorkflow: 'feature', workflowByType: {} };
    expect(resolveTicketWorkflowId(config, binding, { workflow: null, template: 'chore' })).toBe(
      'feature',
    );
  });

  it('falls to global defaultWorkflow when project has no binding', () => {
    const cfg: WorkflowConfigView = { ...config, defaultWorkflow: 'feature' };
    expect(resolveTicketWorkflowId(cfg, EMPTY, { workflow: null, template: null })).toBe('feature');
  });

  it('terminates at "default" when nothing else resolves', () => {
    expect(resolveTicketWorkflowId(config, EMPTY, { workflow: null, template: null })).toBe(
      'default',
    );
  });

  it('skips an unknown/deleted workflow id and falls through', () => {
    const binding: ProjectWorkflowBinding = { defaultWorkflow: 'bug', workflowByType: {} };
    // ticket override points at a ghost id → skipped → project default 'bug'
    expect(resolveTicketWorkflowId(config, binding, { workflow: 'ghost', template: null })).toBe(
      'bug',
    );
  });
});

describe('buildWorkflowContext — per-workflow context', () => {
  it('produces workflow-specific terminal/known sets, transition table, labels', () => {
    const ctx = buildWorkflowContext(config, 'bug');
    expect(ctx.workflowId).toBe('bug');
    expect(ctx.bundle.label).toBe('Bug Flow');
    expect([...ctx.knownStatusIds].sort()).toEqual(['fixing', 'open', 'verified']);
    expect(ctx.terminalStatuses.has('verified')).toBe(true);
    expect(ctx.terminalStatuses.has('open')).toBe(false);
    expect(ctx.transitionTable.get('open:start')).toBe('fixing');
    expect(ctx.transitionTable.get('fixing:verify')).toBe('verified');
    expect(ctx.statusLabel('fixing')).toBe('Fixing In Progress');
    // unknown id → Title Case fallback
    expect(ctx.statusLabel('some_status')).toBe('Some Status');
  });

  it('selects THIS workflow’s derive block (by reference), not a shared one', () => {
    expect(buildWorkflowContext(config, 'bug').deriveContext.derive).toBe(bugDerive);
    // feature has no custom derive → the built-in default
    expect(buildWorkflowContext(config, 'feature').deriveContext.derive).toBe(DEFAULT_DERIVE_CONFIG);
  });

  it('two workflows carry independent fact registries (no cross-contamination)', () => {
    const a = buildWorkflowContext(config, 'bug');
    const b = buildWorkflowContext(config, 'feature');
    expect(a.deriveContext.registry).not.toBe(b.deriveContext.registry);
  });
});

describe('legacy config (no workflows: block)', () => {
  it('synthesizes `default` from the legacy `statuses:` bundle', () => {
    const legacyStatuses: StatusConfig = {
      statuses: [
        { id: 'a', label: 'A', terminal: false },
        { id: 'z', label: 'Z', terminal: true },
      ],
      order: ['a', 'z'],
      transitions: [{ from: 'a', command: 'finish', to: 'z' }],
    };
    const legacy: WorkflowConfigView = {
      workflows: null,
      statuses: legacyStatuses,
      defaultWorkflow: null,
    };
    expect(resolveTicketWorkflowId(legacy, EMPTY, { workflow: null, template: null })).toBe(
      'default',
    );
    const ctx = buildWorkflowContext(legacy, 'default');
    expect([...ctx.knownStatusIds].sort()).toEqual(['a', 'z']);
    expect(ctx.terminalStatuses.has('z')).toBe(true);
    expect(ctx.transitionTable.get('a:finish')).toBe('z');
  });

  it('empty config synthesizes the built-in default lifecycle', () => {
    const empty: WorkflowConfigView = { workflows: null, statuses: null, defaultWorkflow: null };
    const ctx = buildWorkflowContext(empty, 'default');
    expect(ctx.knownStatusIds.has('completed')).toBe(true);
    expect(ctx.terminalStatuses.has('completed')).toBe(true);
  });
});

describe('resolveTicketWorkflowContext (async)', () => {
  it('resolves via a pre-read projectBinding', async () => {
    const ctx = await resolveTicketWorkflowContext({
      ticket: { workflow: null, template: 'bug' },
      projectBinding: { defaultWorkflow: null, workflowByType: { bug: 'bug' } },
      config,
    });
    expect(ctx.workflowId).toBe('bug');
  });

  it('reads the binding from <projectDir>/project.md when not pre-supplied', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wf-ctx-'));
    try {
      await writeFile(
        join(dir, 'project.md'),
        '---\nid: p\ndefaultWorkflow: feature\n---\n# P\n',
        'utf-8',
      );
      const ctx = await resolveTicketWorkflowContext({
        ticket: { workflow: null, template: null },
        projectDir: dir,
        config,
      });
      expect(ctx.workflowId).toBe('feature');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('standalone (no project) resolves via global/default', async () => {
    const ctx = await resolveTicketWorkflowContext({
      ticket: { workflow: null, template: null },
      config,
    });
    expect(ctx.workflowId).toBe('default');
  });
});

describe('makeWorkflowContextResolver — sweep memoization', () => {
  it('memoizes contexts by workflow id (same reference)', () => {
    const resolver = makeWorkflowContextResolver(config);
    const a = resolver.context('bug');
    const b = resolver.context('bug');
    expect(a).toBe(b);
    expect(resolver.context('feature')).not.toBe(a);
  });

  it('forTicket resolves and returns the memoized context', async () => {
    const resolver = makeWorkflowContextResolver(config);
    const direct = resolver.context('bug');
    const viaTicket = await resolver.forTicket({ workflow: 'bug', template: null }, null);
    expect(viaTicket).toBe(direct);
  });
});
