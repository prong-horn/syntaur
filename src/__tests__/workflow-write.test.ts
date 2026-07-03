import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  writeWorkflowBundle,
  deleteWorkflowFromConfig,
  setDefaultWorkflow,
} from '../utils/workflow-write.js';
import { readConfig, writeStatusConfig, type StatusConfig } from '../utils/config.js';

const originalHome = process.env.SYNTAUR_HOME;
let home: string;

const legacyStatuses: StatusConfig = {
  statuses: [
    { id: 'draft', label: 'Draft' },
    { id: 'in_progress', label: 'In Progress' },
    { id: 'done', label: 'Done', terminal: true },
  ],
  order: ['draft', 'in_progress', 'done'],
  transitions: [],
  derive: null,
  facts: null,
};

const bugBundle: StatusConfig = {
  statuses: [
    { id: 'open', label: 'Open' },
    { id: 'closed', label: 'Closed', terminal: true },
  ],
  order: ['open', 'closed'],
  transitions: [],
  derive: null,
  facts: null,
};

async function configText(): Promise<string> {
  // SYNTAUR_HOME is the syntaur root itself (no `.syntaur` suffix), so config.md
  // lives directly under it.
  return readFile(resolve(home, 'config.md'), 'utf-8');
}

/** True when config.md has a COLUMN-0 `statuses:` (legacy block), ignoring the
 * indented `statuses:` sub-key inside each workflow bundle. */
function hasTopLevelStatuses(text: string): boolean {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  return fm ? /^statuses:\s*$/m.test(fm[1]) : false;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wf-write-'));
  process.env.SYNTAUR_HOME = home;
  await mkdir(join(home, '.syntaur'), { recursive: true });
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = originalHome;
  await rm(home, { recursive: true, force: true });
});

describe('writeWorkflowBundle — lift-on-first-write (Task 10 / D4)', () => {
  it('lifts a legacy statuses: block to workflows.default and deletes the legacy block', async () => {
    await writeStatusConfig(legacyStatuses);
    expect(hasTopLevelStatuses(await configText())).toBe(true);

    await writeWorkflowBundle('bug', bugBundle);

    const config = await readConfig();
    // Legacy statuses lifted into workflows.default; new workflow added.
    expect(config.workflows?.default?.statuses.map((s) => s.id)).toEqual([
      'draft',
      'in_progress',
      'done',
    ]);
    expect(config.workflows?.bug?.statuses.map((s) => s.id)).toEqual(['open', 'closed']);
    // D4: the top-level statuses: block is gone (single source of truth).
    expect(hasTopLevelStatuses(await configText())).toBe(false);
    expect(config.statuses).toBeNull();
  });

  it('preserves other workflows and the current defaultWorkflow when upserting one', async () => {
    await writeWorkflowBundle('bug', bugBundle);
    await writeWorkflowBundle('chore', bugBundle);
    // Update bug again — chore + default must survive.
    await writeWorkflowBundle('bug', { ...bugBundle, order: ['closed', 'open'] });

    const config = await readConfig();
    expect(Object.keys(config.workflows ?? {}).sort()).toEqual(['bug', 'chore', 'default']);
    expect(config.workflows?.bug?.order).toEqual(['closed', 'open']);
  });

  it('honors label and setDefault', async () => {
    await writeWorkflowBundle('bug', bugBundle, { label: 'Bug Triage', setDefault: true });
    const config = await readConfig();
    expect(config.workflows?.bug?.label).toBe('Bug Triage');
    expect(config.defaultWorkflow).toBe('bug');
  });

  it('defaults a new workflow label to Title Case of the id', async () => {
    await writeWorkflowBundle('quick_fix', bugBundle);
    const config = await readConfig();
    expect(config.workflows?.quick_fix?.label).toBe('Quick Fix');
  });
});

describe('deleteWorkflowFromConfig + setDefaultWorkflow (Task 10)', () => {
  it('removes a workflow and falls the global default back to `default`', async () => {
    await writeWorkflowBundle('bug', bugBundle, { setDefault: true });
    expect((await readConfig()).defaultWorkflow).toBe('bug');

    await deleteWorkflowFromConfig('bug');
    const config = await readConfig();
    expect(config.workflows?.bug).toBeUndefined();
    expect(config.defaultWorkflow).toBe('default');
  });

  it('never removes the built-in default workflow', async () => {
    await writeWorkflowBundle('bug', bugBundle);
    await deleteWorkflowFromConfig('default');
    const config = await readConfig();
    expect(config.workflows?.default).toBeDefined();
  });

  it('setDefaultWorkflow updates only the scalar', async () => {
    await writeWorkflowBundle('bug', bugBundle);
    await setDefaultWorkflow('bug');
    expect((await readConfig()).defaultWorkflow).toBe('bug');
    // bug bundle untouched.
    expect((await readConfig()).workflows?.bug?.statuses.map((s) => s.id)).toEqual([
      'open',
      'closed',
    ]);
  });
});
