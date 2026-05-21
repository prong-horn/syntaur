import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  generateShortBundleId,
  generateUniqueBundleId,
  parseBundleLine,
  serializeBundle,
  parseBundles,
  serializeBundles,
  readBundles,
  writeBundles,
} from '../todos/bundle-parser.js';
import { bundlesPath, bundlesDir } from '../utils/paths.js';
import type { TodoBundle } from '../todos/types.js';

function makeBundle(overrides: Partial<TodoBundle> & { id: string; scope: TodoBundle['scope']; scopeId: string; todoIds: string[]; createdAt: string; updatedAt: string }): TodoBundle {
  return {
    slug: null,
    planDir: null,
    branch: null,
    worktreePath: null,
    repository: null,
    ...overrides,
  };
}

describe('generateShortBundleId / generateUniqueBundleId', () => {
  it('returns a 4-hex id', () => {
    const id = generateShortBundleId();
    expect(id).toMatch(/^[a-f0-9]{4}$/);
  });

  it('never returns a colliding id given a populated set (1000 calls)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = generateUniqueBundleId(seen);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    expect(seen.size).toBe(1000);
  });
});

describe('parseBundleLine / serializeBundle round-trip', () => {
  it('minimal bundle (only required fields)', () => {
    const b = makeBundle({
      id: 'a3f1',
      scope: 'workspace',
      scopeId: 'alpha',
      todoIds: ['1aaa', '2bbb'],
      createdAt: '2026-05-21T13:00:00Z',
      updatedAt: '2026-05-21T13:00:00Z',
    });
    const line = serializeBundle(b);
    const parsed = parseBundleLine(line);
    expect(parsed).toEqual(b);
  });

  it('maximal bundle (every optional set)', () => {
    const b = makeBundle({
      id: 'beef',
      slug: 'auth-cleanup',
      scope: 'project',
      scopeId: 'syntaur-meta',
      todoIds: ['aaaa', 'bbbb', 'cccc'],
      planDir: '/Users/x/.syntaur/projects/y/todos/plans/syntaur-meta/bundles/beef',
      branch: 'feat/auth-cleanup',
      worktreePath: '/Users/x/repo/.worktrees/feat/auth-cleanup',
      repository: '/Users/x/repo',
      createdAt: '2026-05-21T13:00:00Z',
      updatedAt: '2026-05-21T14:00:00Z',
    });
    const line = serializeBundle(b);
    const parsed = parseBundleLine(line);
    expect(parsed).toEqual(b);
  });

  it('round-trips URL-unsafe characters in slug / branch / path', () => {
    const b = makeBundle({
      id: 'd00d',
      slug: 'cross-team',
      scope: 'global',
      scopeId: '_global',
      todoIds: ['1111', '2222'],
      branch: 'feat/oddly named branch=with;weird<chars>',
      worktreePath: '/tmp/path with spaces/=odd[bracket]',
      createdAt: '2026-05-21T13:00:00Z',
      updatedAt: '2026-05-21T13:00:00Z',
    });
    const line = serializeBundle(b);
    // The line uses one outer `<...>` container, but no INNER `<` or `>` may
    // survive in encoded values (they would break the regex).
    const innerBody = line.replace(/^.*?<(.*)>$/, '$1');
    expect(innerBody).not.toContain('<');
    expect(innerBody).not.toContain('>');
    expect(innerBody).not.toContain('=odd[');
    const parsed = parseBundleLine(line);
    expect(parsed).toEqual(b);
  });

  it('multi-todo todos= list', () => {
    const b = makeBundle({
      id: 'cafe',
      scope: 'workspace',
      scopeId: '_global',
      todoIds: ['aaaa', 'bbbb', 'cccc', 'dddd'],
      createdAt: '2026-05-21T13:00:00Z',
      updatedAt: '2026-05-21T13:00:00Z',
    });
    expect(serializeBundle(b)).toContain('todos=aaaa,bbbb,cccc,dddd');
    expect(parseBundleLine(serializeBundle(b))?.todoIds).toEqual(['aaaa', 'bbbb', 'cccc', 'dddd']);
  });

  it('returns null for a non-bundle line', () => {
    expect(parseBundleLine('# heading')).toBeNull();
    expect(parseBundleLine('- [ ] a todo [t:1234]')).toBeNull();
    expect(parseBundleLine('')).toBeNull();
  });

  it('drops unknown keys on read (forward-compat)', () => {
    const line = '- b:1234 <scope=workspace:foo;todos=aaaa,bbbb;futureKey=hello;created=2026-05-21T13:00:00Z;updated=2026-05-21T13:00:00Z>';
    const parsed = parseBundleLine(line);
    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe('1234');
    expect(parsed?.todoIds).toEqual(['aaaa', 'bbbb']);
  });

  it('rejects a line missing required scope token', () => {
    const line = '- b:1234 <todos=aaaa,bbbb;created=2026-05-21T13:00:00Z;updated=2026-05-21T13:00:00Z>';
    expect(parseBundleLine(line)).toBeNull();
  });

  it('rejects a line missing created/updated', () => {
    const line = '- b:1234 <scope=workspace:foo;todos=aaaa,bbbb>';
    expect(parseBundleLine(line)).toBeNull();
  });
});

describe('parseBundles / serializeBundles', () => {
  it('emits frontmatter version + header + lines', () => {
    const out = serializeBundles([
      makeBundle({ id: 'aaaa', scope: 'workspace', scopeId: '_global', todoIds: ['1', '2'], createdAt: '2026-05-21T13:00:00Z', updatedAt: '2026-05-21T13:00:00Z' }),
    ]);
    expect(out).toMatch(/^---\nversion: "1"\n---/);
    expect(out).toContain('# Todo Bundles');
    expect(out).toContain('- b:aaaa ');
  });

  it('round-trips an empty bundle list', () => {
    const out = serializeBundles([]);
    expect(parseBundles(out).bundles).toEqual([]);
  });

  it('parses an old-version file forward-compat (any version string accepted)', () => {
    const content = '---\nversion: "99"\n---\n\n# Todo Bundles\n\n- b:dead <scope=global:_global;todos=aaaa,bbbb;created=2026-05-21T13:00:00Z;updated=2026-05-21T13:00:00Z>\n';
    const parsed = parseBundles(content);
    expect(parsed.version).toBe('99');
    expect(parsed.bundles).toHaveLength(1);
  });
});

describe('readBundles / writeBundles file I/O', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'syntaur-bundle-parser-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('readBundles returns [] when bundles/ dir is absent', async () => {
    expect(await readBundles(dir)).toEqual([]);
  });

  it('readBundles returns [] when bundles/index.md is absent', async () => {
    // dir/bundles exists but no index.md
    const { mkdir } = await import('node:fs/promises');
    await mkdir(bundlesDir(dir), { recursive: true });
    expect(await readBundles(dir)).toEqual([]);
  });

  it('writeBundles creates the bundles/ subdirectory if absent', async () => {
    const b = makeBundle({
      id: 'aaaa',
      scope: 'workspace',
      scopeId: '_global',
      todoIds: ['1111', '2222'],
      createdAt: '2026-05-21T13:00:00Z',
      updatedAt: '2026-05-21T13:00:00Z',
    });
    await writeBundles(dir, [b]);
    const content = await readFile(bundlesPath(dir), 'utf-8');
    expect(content).toContain('- b:aaaa');
    const round = await readBundles(dir);
    expect(round).toEqual([b]);
  });

  it('does not register as a top-level workspace checklist (discovery non-interference)', async () => {
    await writeBundles(dir, [
      makeBundle({
        id: 'aaaa',
        scope: 'workspace',
        scopeId: '_global',
        todoIds: ['1111', '2222'],
        createdAt: '2026-05-21T13:00:00Z',
        updatedAt: '2026-05-21T13:00:00Z',
      }),
    ]);
    // Mimic the api-todos.ts discovery glob: list top-level *.md.
    const entries = await readdir(dir, { withFileTypes: true });
    const topLevelMd = entries.filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.endsWith('-log.md')).map((e) => e.name);
    expect(topLevelMd).toEqual([]); // bundles live in a subdir; discovery sees nothing
    // Sanity: bundles/index.md exists.
    const bundleEntries = await readdir(resolve(dir, 'bundles'));
    expect(bundleEntries).toContain('index.md');
  });
});
