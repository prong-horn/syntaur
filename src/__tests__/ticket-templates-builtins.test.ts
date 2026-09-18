import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  BUILTIN_TEMPLATE_IDS,
  builtinStatus,
  resetBuiltin,
  seedMissingBuiltins,
  builtinTemplatesDir,
} from '../ticket-templates/builtins.js';
import { loadTemplate } from '../ticket-templates/registry.js';
import { validateTemplateDir } from '../ticket-templates/registry.js';

describe('built-in template lifecycle', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'syntaur-builtin-test-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('seeds when absent, never overwrites', async () => {
    const first = await seedMissingBuiltins(root);
    expect(first).toEqual([...BUILTIN_TEMPLATE_IDS]);

    for (const id of BUILTIN_TEMPLATE_IDS) {
      const path = resolve(root, 'templates', id, 'template.md');
      const content = await readFile(path, 'utf-8');
      expect(content).toContain(`id: ${id}`);
    }

    const manifestPath = resolve(root, 'templates', 'feature', 'template.md');
    await writeFile(manifestPath, '---\nid: feature\nversion: 1\n---\nmodified\n', 'utf-8');

    const second = await seedMissingBuiltins(root);
    expect(second).toEqual([]);

    const after = await readFile(manifestPath, 'utf-8');
    expect(after).toContain('modified');
  });

  it('reports current, modified, outdated, missing', async () => {
    expect(await builtinStatus(root, 'feature')).toBe('missing');

    await seedMissingBuiltins(root);
    expect(await builtinStatus(root, 'feature')).toBe('current');

    const manifestPath = resolve(root, 'templates', 'feature', 'template.md');
    const content = await readFile(manifestPath, 'utf-8');
    await writeFile(manifestPath, content + '\n# edited', 'utf-8');
    expect(await builtinStatus(root, 'feature')).toBe('modified');

    const shipped = await readFile(resolve(builtinTemplatesDir(), 'feature', 'template.md'), 'utf-8');
    const outdated = shipped.replace('feature@2', 'feature@999');
    await writeFile(manifestPath, outdated, 'utf-8');
    expect(await builtinStatus(root, 'feature')).toBe('outdated');
  });

  it('re-stamped feature@1 reports outdated then current after reset', async () => {
    await seedMissingBuiltins(root);
    const manifestPath = resolve(root, 'templates', 'feature', 'template.md');
    const content = await readFile(manifestPath, 'utf-8');
    const restamped = content.replace('feature@2', 'feature@1');
    await writeFile(manifestPath, restamped, 'utf-8');
    expect(await builtinStatus(root, 'feature')).toBe('outdated');

    await resetBuiltin(root, 'feature');
    expect(await builtinStatus(root, 'feature')).toBe('current');
    const restored = await readFile(manifestPath, 'utf-8');
    expect(restored).toContain('builtin: feature@2');
  });

  it('ships bug@2 with a cursor reviewer stage target', async () => {
    const shipped = await readFile(resolve(builtinTemplatesDir(), 'bug', 'template.md'), 'utf-8');
    expect(shipped).toContain('builtin: bug@2');
    expect(shipped).toContain('reviewer: cursor');
    expect(shipped).not.toContain('reviewer: pi');
  });

  it('feature@2 and bug@2 seed, validate, and load as built-ins', async () => {
    await seedMissingBuiltins(root);
    for (const id of ['feature', 'bug'] as const) {
      const content = await readFile(resolve(root, 'templates', id, 'template.md'), 'utf-8');
      expect(content).toContain(`builtin: ${id}@2`);
      const { issues } = await validateTemplateDir(root, id);
      expect(issues).toEqual([]);
      const manifest = await loadTemplate(root, id);
      for (const stage of manifest.stages) {
        expect(Boolean(stage.agent) && Boolean(stage.reviewer)).toBe(false);
      }
    }
  });

  it('reset restores shipped files, keeps extras', async () => {
    await seedMissingBuiltins(root);
    const extraPath = resolve(root, 'templates', 'feature', 'extra.txt');
    await writeFile(extraPath, 'keep me', 'utf-8');

    const manifestPath = resolve(root, 'templates', 'feature', 'template.md');
    await writeFile(manifestPath, '---\nid: feature\n---\n', 'utf-8');

    await resetBuiltin(root, 'feature');

    const restored = await readFile(manifestPath, 'utf-8');
    expect(restored).toContain('builtin: feature@2');
    expect(await readFile(extraPath, 'utf-8')).toBe('keep me');
    expect(await builtinStatus(root, 'feature')).toBe('current');
  });
});
