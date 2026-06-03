import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  readConfig,
  writeWorkspaceVisibilityConfig,
  deleteWorkspaceVisibilityConfig,
} from '../utils/config.js';
import {
  UNGROUPED_WORKSPACE,
  isWorkspaceHidden,
  normalizeHiddenList,
  visibleWorkspaces,
} from '../utils/workspace-visibility-schema.js';

describe('visibleWorkspaces', () => {
  it('shows everything when the blocklist is empty', () => {
    expect(visibleWorkspaces(['a', 'b', 'c'], [])).toEqual(['a', 'b', 'c']);
  });

  it('removes a hidden name and preserves input order', () => {
    expect(visibleWorkspaces(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c']);
  });

  it('treats an unknown blocklist entry as a harmless no-op', () => {
    expect(visibleWorkspaces(['a', 'b'], ['nope'])).toEqual(['a', 'b']);
  });

  it('hides the ungrouped section when its sentinel is blocked', () => {
    expect(
      visibleWorkspaces(['a', UNGROUPED_WORKSPACE], [UNGROUPED_WORKSPACE]),
    ).toEqual(['a']);
  });

  it('does not mutate the input array', () => {
    const all = ['a', 'b'];
    visibleWorkspaces(all, ['a']);
    expect(all).toEqual(['a', 'b']);
  });
});

describe('isWorkspaceHidden', () => {
  it('reports membership in the blocklist', () => {
    expect(isWorkspaceHidden('a', ['a', 'b'])).toBe(true);
    expect(isWorkspaceHidden('c', ['a', 'b'])).toBe(false);
  });
});

describe('normalizeHiddenList', () => {
  it('trims, drops empties/whitespace-only, dedupes preserving first-seen order', () => {
    expect(normalizeHiddenList(['a', ' a ', '', '  ', 'b', 'a'])).toEqual([
      'a',
      'b',
    ]);
  });

  it('ignores non-string entries and entries containing a newline', () => {
    expect(normalizeHiddenList(['ok', 42, null, 'bad\nname', undefined])).toEqual([
      'ok',
    ]);
  });

  it('returns an empty array for non-array input', () => {
    expect(normalizeHiddenList('nope')).toEqual([]);
    expect(normalizeHiddenList(null)).toEqual([]);
  });
});

describe('workspace-visibility config round-trip', () => {
  const originalHome = process.env.HOME;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'syntaur-wsvis-'));
    process.env.HOME = homeDir;
    await mkdir(resolve(homeDir, '.syntaur'), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('round-trips plain slugs and the ungrouped sentinel', async () => {
    await writeWorkspaceVisibilityConfig({
      hidden: ['archive', UNGROUPED_WORKSPACE],
    });
    const config = await readConfig();
    expect(config.workspaceVisibility.hidden).toEqual([
      'archive',
      UNGROUPED_WORKSPACE,
    ]);
  });

  it('round-trips names with spaces, quotes, and backslashes via JSON escaping', async () => {
    const tricky = ['my workspace', 'my "quoted" ws', 'path\\like'];
    await writeWorkspaceVisibilityConfig({ hidden: tricky });
    const config = await readConfig();
    expect(config.workspaceVisibility.hidden).toEqual(tricky);

    // On-disk entries are JSON-quoted so the hand-rolled parser can recover them.
    const raw = await readFile(resolve(homeDir, '.syntaur', 'config.md'), 'utf-8');
    expect(raw).toContain('    - "my workspace"');
    expect(raw).toContain('    - "my \\"quoted\\" ws"');
    expect(raw).toContain('    - "path\\\\like"');
  });

  it('normalizes (trims + dedupes) on write', async () => {
    await writeWorkspaceVisibilityConfig({
      hidden: ['a', ' a ', '', 'b'],
    });
    const config = await readConfig();
    expect(config.workspaceVisibility.hidden).toEqual(['a', 'b']);
  });

  it('writing an empty list yields hidden: [] (block omitted)', async () => {
    await writeWorkspaceVisibilityConfig({ hidden: ['a'] });
    await writeWorkspaceVisibilityConfig({ hidden: [] });
    const config = await readConfig();
    expect(config.workspaceVisibility.hidden).toEqual([]);
    const raw = await readFile(resolve(homeDir, '.syntaur', 'config.md'), 'utf-8');
    expect(raw).not.toContain('workspaceVisibility:');
  });

  it('deleteWorkspaceVisibilityConfig clears the blocklist', async () => {
    await writeWorkspaceVisibilityConfig({ hidden: ['a', 'b'] });
    await deleteWorkspaceVisibilityConfig();
    const config = await readConfig();
    expect(config.workspaceVisibility.hidden).toEqual([]);
  });

  it('defaults to an empty blocklist when the key is absent', async () => {
    const config = await readConfig();
    expect(config.workspaceVisibility.hidden).toEqual([]);
  });
});
