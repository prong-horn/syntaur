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
    const outdated = shipped.replace('feature@1', 'feature@999');
    await writeFile(manifestPath, outdated, 'utf-8');
    expect(await builtinStatus(root, 'feature')).toBe('outdated');
  });

  it('reset restores shipped files, keeps extras', async () => {
    await seedMissingBuiltins(root);
    const extraPath = resolve(root, 'templates', 'feature', 'extra.txt');
    await writeFile(extraPath, 'keep me', 'utf-8');

    const manifestPath = resolve(root, 'templates', 'feature', 'template.md');
    await writeFile(manifestPath, '---\nid: feature\n---\n', 'utf-8');

    await resetBuiltin(root, 'feature');

    const restored = await readFile(manifestPath, 'utf-8');
    expect(restored).toContain('builtin: feature@1');
    expect(await readFile(extraPath, 'utf-8')).toBe('keep me');
    expect(await builtinStatus(root, 'feature')).toBe('current');
  });
});
