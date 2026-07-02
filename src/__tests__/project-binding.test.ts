import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectBinding } from '../utils/project-binding.js';

describe('readProjectBinding (Node-safe project workflow binding reader)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'syntaur-pb-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeProject(fm: string): Promise<void> {
    await writeFile(join(dir, 'project.md'), `---\n${fm}\n---\n\n# Project\n`);
  }

  it('reads the defaultWorkflow scalar and the workflowByType map', async () => {
    await writeProject(
      ['slug: p', 'defaultWorkflow: feature', 'workflowByType:', '  bug: bugfix', '  spike: research'].join('\n'),
    );

    const binding = await readProjectBinding(dir);

    expect(binding.defaultWorkflow).toBe('feature');
    expect(binding.workflowByType).toEqual({ bug: 'bugfix', spike: 'research' });
  });

  it('defaults to null + empty map when the fields are absent', async () => {
    await writeProject('slug: p');

    const binding = await readProjectBinding(dir);

    expect(binding.defaultWorkflow).toBeNull();
    expect(binding.workflowByType).toEqual({});
  });

  it('treats an explicit null defaultWorkflow / empty type map as unset', async () => {
    await writeProject('slug: p\ndefaultWorkflow: null');

    const binding = await readProjectBinding(dir);

    expect(binding.defaultWorkflow).toBeNull();
    expect(binding.workflowByType).toEqual({});
  });

  it('returns defaults when project.md does not exist', async () => {
    const binding = await readProjectBinding(dir);

    expect(binding).toEqual({ defaultWorkflow: null, workflowByType: {} });
  });

  it('does not confuse a later top-level key for a workflowByType entry', async () => {
    await writeProject(
      ['slug: p', 'workflowByType:', '  bug: bugfix', 'tags: []', 'created: "2026-07-02T00:00:00Z"'].join('\n'),
    );

    const binding = await readProjectBinding(dir);

    expect(binding.workflowByType).toEqual({ bug: 'bugfix' });
  });
});
