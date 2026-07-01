import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverAgents } from '../targets/agent-discovery.js';
import type { AgentConfig } from '../utils/agents-schema.js';

describe('discoverAgents (multi-source)', () => {
  let base: string;
  let root: string; // directory-scan root
  let repo: string; // repo for the claude-project source

  const write = async (p: string, content: string) => {
    await mkdir(join(p, '..'), { recursive: true });
    await writeFile(p, content);
  };

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'syntaur-disc-'));
    root = join(base, 'home');
    repo = join(base, 'repo');
    await mkdir(root, { recursive: true });
    await mkdir(repo, { recursive: true });

    // directory-scan fixtures under `root` (depth-1 dirs)
    await mkdir(join(root, 'pi-agent', '.pi'), { recursive: true }); // .pi/ ⇒ pi
    await write(join(root, 'mcp-agent', '.mcp.json'), '{}'); // .mcp.json marker
    await write(join(root, 'bare-repo', 'AGENTS.md'), '# just a repo, no opt-in'); // NOT surfaced
    await write(join(root, 'noise', 'README.md'), '# nothing here'); // NOT surfaced
    await write(
      join(root, 'opt-in', 'AGENTS.md'),
      '---\nsyntaur:\n  name: cool-agent\n  runner: codex\n  description: A cool agent\n---\nbody',
    );

    // claude-project fixture under `repo`
    await write(
      join(repo, '.claude', 'agents', 'researcher.md'),
      '---\nname: researcher\ndescription: Researches\n---\nbody',
    );

    // per-dir claude-project fixture: a depth-1 dir under `root` with its own
    // .claude/agents (its inner def is surfaced as claude-project).
    await write(
      join(root, 'proj-dir', '.claude', 'agents', 'helper.md'),
      '---\nname: helper\n---\nbody',
    );
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const input = (agents: AgentConfig[] = []) => ({
    claudeGlobal: false, // real ~/.claude/agents — covered by discoverClaudeAgents test
    claudeProject: true,
    directory: true,
    roots: [root],
    repo,
    agents,
  });

  it('surfaces strong-marker dirs + claude-project defs; skips bare AGENTS.md and noise', async () => {
    const cands = await discoverAgents(input());
    const byName = new Map(cands.map((c) => [c.name, c]));

    // .pi/ ⇒ pi directory candidate
    expect(byName.get('pi-agent')).toMatchObject({ runner: 'pi', source: 'directory', recommended: false });
    // .mcp.json marker
    expect(byName.get('mcp-agent')).toMatchObject({ runner: 'pi', source: 'directory' });
    // syntaur: opt-in wins name + runner + recommended
    expect(byName.get('cool-agent')).toMatchObject({
      runner: 'codex',
      source: 'directory',
      recommended: true,
      description: 'A cool agent',
    });
    // claude-project def carries the repo pointer (Decision 3)
    expect(byName.get('researcher')).toMatchObject({
      runner: 'claude',
      source: 'claude-project',
      sourceRepo: repo,
    });
    // per-dir claude-project def: sourceRepo is the depth-1 dir it lives under
    expect(byName.get('helper')).toMatchObject({
      source: 'claude-project',
      sourceRepo: join(root, 'proj-dir'),
    });

    // bare AGENTS.md (no syntaur:) and README-only dir are NOT surfaced
    expect(byName.has('bare-repo')).toBe(false);
    expect(byName.has('noise')).toBe(false);
  });

  it('ranks recommended (syntaur:) candidates first', async () => {
    const cands = await discoverAgents(input());
    expect(cands[0]?.recommended).toBe(true);
    expect(cands[0]?.name).toBe('cool-agent');
  });

  it('computes alreadyRegistered against the registered agents list', async () => {
    const registered: AgentConfig[] = [
      { id: 'x', label: 'X', command: 'pi', workdir: join(root, 'pi-agent') },
    ];
    const cands = await discoverAgents(input(registered));
    expect(cands.find((c) => c.name === 'pi-agent')?.alreadyRegistered).toBe(true);
    expect(cands.find((c) => c.name === 'mcp-agent')?.alreadyRegistered).toBe(false);
  });

  it('honors source toggles (directory off → only claude-project)', async () => {
    const cands = await discoverAgents({ ...input(), directory: false });
    expect(cands.every((c) => c.source === 'claude-project')).toBe(true);
    expect(cands.map((c) => c.name)).toContain('researcher');
  });
});
