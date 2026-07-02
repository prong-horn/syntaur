import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  readConfig,
  updateIntegrationConfig,
  writeStatusConfig,
  parseWorkflowsConfig,
  serializeWorkflowsConfig,
  writeWorkflowsConfig,
  deleteWorkflowsConfig,
  type WorkflowDefinition,
} from '../utils/config.js';

describe('config integrations', () => {
  const originalHome = process.env.HOME;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'syntaur-config-'));
    process.env.HOME = homeDir;
    await mkdir(resolve(homeDir, '.syntaur'), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    vi.restoreAllMocks();
    await rm(homeDir, { recursive: true, force: true });
  });

  it('reads optional integration paths and expands home-relative values', async () => {
    const configPath = resolve(homeDir, '.syntaur', 'config.md');
    await writeFile(
      configPath,
      '---\nversion: "1.0"\ndefaultProjectDir: ~/.syntaur/projects\nintegrations:\n  claudePluginDir: ~/.claude/plugins/syntaur\n  codexPluginDir: ~/plugins/syntaur\n  codexMarketplacePath: ~/.agents/plugins/marketplace.json\n---\n',
    );

    const config = await readConfig();

    expect(config.integrations.claudePluginDir).toBe(resolve(homeDir, '.claude', 'plugins', 'syntaur'));
    expect(config.integrations.codexPluginDir).toBe(resolve(homeDir, 'plugins', 'syntaur'));
    expect(config.integrations.codexMarketplacePath).toBe(resolve(homeDir, '.agents', 'plugins', 'marketplace.json'));
  });

  it('ignores malformed relative integration paths', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const configPath = resolve(homeDir, '.syntaur', 'config.md');
    await writeFile(
      configPath,
      '---\nversion: "1.0"\ndefaultProjectDir: ~/.syntaur/projects\nintegrations:\n  claudePluginDir: relative/path\n---\n',
    );

    const config = await readConfig();

    expect(config.integrations.claudePluginDir).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('updates integration keys without deleting existing status config or body content', async () => {
    await writeStatusConfig({
      statuses: [
        { id: 'todo', label: 'Todo' },
        { id: 'done', label: 'Done', terminal: true },
      ],
      order: ['todo', 'done'],
      transitions: [],
    });
    const configPath = resolve(homeDir, '.syntaur', 'config.md');
    await writeFile(
      configPath,
      `${await readFile(configPath, 'utf-8')}\nCustom config notes.\n`,
    );

    await updateIntegrationConfig({
      claudePluginDir: resolve(homeDir, '.claude', 'plugins', 'syntaur'),
      codexPluginDir: resolve(homeDir, 'plugins', 'syntaur'),
    });

    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('integrations:');
    expect(content).toContain('statuses:');
    expect(content).toContain('Custom config notes.');
  });
});

describe('workflows config (multi-workflow library)', () => {
  const originalHome = process.env.HOME;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'syntaur-workflows-'));
    process.env.HOME = homeDir;
    await mkdir(resolve(homeDir, '.syntaur'), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    vi.restoreAllMocks();
    await rm(homeDir, { recursive: true, force: true });
  });

  // A feature workflow that exercises the derive block including a `when`
  // condition containing embedded double-quotes (the double-escape guard).
  const featureWf: WorkflowDefinition = {
    label: 'Feature',
    statuses: [
      { id: 'draft', label: 'Draft' },
      { id: 'in_progress', label: 'In Progress' },
      { id: 'done', label: 'Done', terminal: true },
    ],
    order: ['draft', 'in_progress', 'done'],
    transitions: [
      { from: 'draft', command: 'start', to: 'in_progress' },
      { from: 'in_progress', command: 'complete', to: 'done' },
    ],
    derive: {
      phaseLadder: [{ phase: 'active', when: 'status == "in_progress"', next: 'done' }],
      disposition: [
        { when: 'blocked == "true"', is: 'blocked' },
        { when: null, is: 'active' },
      ],
      headline: { terminal: 'passthrough', parked: 'Parked', blocked: 'Blocked', active: 'phase' },
    },
    facts: null,
  };

  const bugfixWf: WorkflowDefinition = {
    label: 'Bug Fix',
    statuses: [
      { id: 'triage', label: 'Triage' },
      { id: 'fixing', label: 'Fixing' },
      { id: 'verified', label: 'Verified', terminal: true },
    ],
    order: ['triage', 'fixing', 'verified'],
    transitions: [{ from: 'triage', command: 'start', to: 'fixing' }],
    derive: null,
    facts: null,
  };

  it('round-trips a two-workflow library preserving values incl. quoted-AQL when', () => {
    const block = serializeWorkflowsConfig({ feature: featureWf, bugfix: bugfixWf });
    const doc = `---\nversion: "2.0"\n${block}\n---\n`;

    const parsed = parseWorkflowsConfig(doc);

    expect(Object.keys(parsed ?? {})).toEqual(['feature', 'bugfix']);
    expect(parsed?.feature.label).toBe('Feature');
    expect(parsed?.bugfix.label).toBe('Bug Fix');
    expect(parsed?.feature.order).toEqual(['draft', 'in_progress', 'done']);
    expect(parsed?.feature.statuses.find((s) => s.id === 'done')?.terminal).toBe(true);
    expect(parsed?.feature.transitions.map((t) => ({ from: t.from, command: t.command, to: t.to }))).toEqual(
      featureWf.transitions,
    );
    // The embedded double-quotes survived the escape/unescape cycle intact.
    expect(parsed?.feature.derive?.phaseLadder[0].when).toBe('status == "in_progress"');
    expect(parsed?.feature.derive?.disposition).toEqual(featureWf.derive?.disposition);
    // bugfix carries no derive block.
    expect(parsed?.bugfix.derive ?? null).toBeNull();
  });

  it('is stable under serialize → parse → serialize (no double-escape accumulation)', () => {
    const block1 = serializeWorkflowsConfig({ feature: featureWf, bugfix: bugfixWf });
    const parsed1 = parseWorkflowsConfig(`---\n${block1}\n---\n`);
    const block2 = serializeWorkflowsConfig(parsed1!);

    expect(block2).toBe(block1);
  });

  it('preserves a malformed custom-fact row (empty name) rather than silently dropping it', () => {
    const withBadFact: WorkflowDefinition = {
      ...bugfixWf,
      facts: [{ name: '', type: 'bool', binds: null }],
    };
    const block = serializeWorkflowsConfig({ bugfix: withBadFact });

    const parsed = parseWorkflowsConfig(`---\n${block}\n---\n`);

    expect(parsed?.bugfix.facts).toEqual([{ name: '', type: 'bool', binds: null }]);
  });

  it('returns null when no workflows: block is present', () => {
    expect(parseWorkflowsConfig('---\nversion: "2.0"\n---\n')).toBeNull();
  });

  it('writeWorkflowsConfig persists the library + defaultWorkflow, read back by readConfig', async () => {
    await writeWorkflowsConfig({ feature: featureWf, bugfix: bugfixWf }, 'bugfix');

    const cfg = await readConfig();

    expect(Object.keys(cfg.workflows ?? {})).toEqual(['feature', 'bugfix']);
    expect(cfg.workflows?.feature.label).toBe('Feature');
    expect(cfg.workflows?.feature.derive?.phaseLadder[0].when).toBe('status == "in_progress"');
    expect(cfg.workflows?.bugfix.statuses.map((s) => s.id)).toEqual(['triage', 'fixing', 'verified']);
    expect(cfg.defaultWorkflow).toBe('bugfix');
  });

  it('writeWorkflowsConfig preserves an existing statuses: block and body content', async () => {
    await writeStatusConfig({
      statuses: [
        { id: 'todo', label: 'Todo' },
        { id: 'done', label: 'Done', terminal: true },
      ],
      order: ['todo', 'done'],
      transitions: [],
    });
    const configPath = resolve(homeDir, '.syntaur', 'config.md');
    await writeFile(configPath, `${await readFile(configPath, 'utf-8')}\nCustom config notes.\n`);

    await writeWorkflowsConfig({ feature: featureWf }, 'feature');

    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('workflows:');
    expect(content).toContain('statuses:');
    expect(content).toContain('defaultWorkflow: feature');
    expect(content).toContain('Custom config notes.');
  });

  it('deleteWorkflowsConfig removes the workflows: block and defaultWorkflow line', async () => {
    await writeWorkflowsConfig({ feature: featureWf }, 'feature');
    await deleteWorkflowsConfig();

    const cfg = await readConfig();
    expect(cfg.workflows).toBeNull();
    expect(cfg.defaultWorkflow ?? null).toBeNull();
  });
});
