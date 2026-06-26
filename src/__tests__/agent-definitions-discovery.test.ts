import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverClaudeAgents } from '../targets/agent-definitions.js';

describe('discoverClaudeAgents', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'syntaur-agents-disc-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const write = async (rel: string, content: string) => {
    const full = join(root, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  };

  it('parses frontmatter (name/description/model) from top-level and nested files', async () => {
    await write(
      'job-applier.md',
      '---\nname: job-applier\ndescription: Applies to jobs\nmodel: opus\n---\nbody',
    );
    await write(
      'nested/researcher.md',
      '---\nname: researcher\ndescription: Researches topics\n---\nbody',
    );
    const agents = await discoverClaudeAgents(root);
    expect(agents).toEqual([
      {
        name: 'job-applier',
        description: 'Applies to jobs',
        model: 'opus',
        path: join(root, 'job-applier.md'),
      },
      {
        name: 'researcher',
        description: 'Researches topics',
        model: undefined,
        path: join(root, 'nested', 'researcher.md'),
      },
    ]);
  });

  it('ignores files with no/invalid frontmatter or no name', async () => {
    await write('no-frontmatter.md', 'just a plain markdown body');
    await write('no-name.md', '---\ndescription: missing name\n---\n');
    await write('good.md', '---\nname: good\n---\n');
    const agents = await discoverClaudeAgents(root);
    expect(agents.map((a) => a.name)).toEqual(['good']);
  });

  it('dedupes by name (first sorted-path wins) and sorts by name', async () => {
    await write('b-first.md', '---\nname: dup\ndescription: from b\n---\n');
    await write('a-first.md', '---\nname: dup\ndescription: from a\n---\n');
    await write('z-other.md', '---\nname: aaa\n---\n');
    const agents = await discoverClaudeAgents(root);
    expect(agents.map((a) => a.name)).toEqual(['aaa', 'dup']);
    // a-first.md sorts before b-first.md → its description wins.
    expect(agents.find((a) => a.name === 'dup')?.description).toBe('from a');
  });

  it('returns [] for a missing directory', async () => {
    const agents = await discoverClaudeAgents(join(root, 'does-not-exist'));
    expect(agents).toEqual([]);
  });
});
