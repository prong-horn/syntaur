import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { listPlaybookSlugs } from '../utils/playbooks.js';

let dir: string;

function withSlug(name: string, slug: string): string {
  return [
    '---',
    `name: "${name}"`,
    `slug: ${slug}`,
    'description: "test"',
    'when_to_use: "always"',
    'tags: []',
    '---',
    '',
    `# ${name}`,
    '',
    'body',
    '',
  ].join('\n');
}

function withoutSlug(name: string): string {
  return [
    '---',
    `name: "${name}"`,
    'description: "test"',
    'when_to_use: "always"',
    'tags: []',
    '---',
    '',
    `# ${name}`,
    '',
    'body',
    '',
  ].join('\n');
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'syntaur-list-slugs-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('listPlaybookSlugs', () => {
  it('uses the canonical frontmatter slug, not the filename stem', async () => {
    await writeFile(resolve(dir, 'file-a.md'), withSlug('A', 'canonical-a'), 'utf-8');
    const slugs = await listPlaybookSlugs(dir);
    expect(slugs.has('canonical-a')).toBe(true);
    expect(slugs.has('file-a')).toBe(false);
  });

  it('falls back to the filename stem when frontmatter has no slug', async () => {
    await writeFile(resolve(dir, 'stem-b.md'), withoutSlug('B'), 'utf-8');
    const slugs = await listPlaybookSlugs(dir);
    expect(slugs.has('stem-b')).toBe(true);
  });

  it('ignores hidden (_), non-.md, and manifest.md files', async () => {
    await writeFile(resolve(dir, '_hidden.md'), withSlug('H', 'hidden'), 'utf-8');
    await writeFile(resolve(dir, 'notes.txt'), 'not a playbook', 'utf-8');
    await writeFile(resolve(dir, 'manifest.md'), '# manifest', 'utf-8');
    await writeFile(resolve(dir, 'real.md'), withSlug('Real', 'real'), 'utf-8');
    const slugs = await listPlaybookSlugs(dir);
    expect(slugs.has('real')).toBe(true);
    expect(slugs.has('hidden')).toBe(false);
    expect(slugs.has('notes')).toBe(false);
    expect(slugs.has('manifest')).toBe(false);
    expect(slugs.size).toBe(1);
  });

  it('returns an empty set when the directory is absent', async () => {
    const slugs = await listPlaybookSlugs(join(dir, 'does-not-exist'));
    expect(slugs.size).toBe(0);
  });

  it('collects multiple slugs', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, 'one.md'), withSlug('One', 'one'), 'utf-8');
    await writeFile(resolve(dir, 'two.md'), withSlug('Two', 'two'), 'utf-8');
    const slugs = await listPlaybookSlugs(dir);
    expect(slugs).toEqual(new Set(['one', 'two']));
  });
});
