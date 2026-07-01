import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  slugifyAgentId,
  uniqueAgentId,
  buildRegisteredAgent,
  authorAgentDef,
  inferManualAdd,
  requireAbsolutePath,
} from '../targets/agent-authoring.js';
import { discoverAgents } from '../targets/agent-discovery.js';

describe('agent authoring', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'syntaur-authoring-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('slugifies names and makes ids unique', () => {
    expect(slugifyAgentId('My Cool Agent!')).toBe('my-cool-agent');
    expect(slugifyAgentId('  Spaces  ')).toBe('spaces');
    expect(uniqueAgentId('dir-bot', ['dir-bot'])).toBe('dir-bot-2');
    expect(uniqueAgentId('fresh', ['dir-bot'])).toBe('fresh');
  });

  it('builds a thin claude agent (agentName, no workdir)', () => {
    const a = buildRegisteredAgent({
      name: 'My Agent',
      runner: 'claude',
      sourceKind: 'claude-global',
      sourcePath: '/x/my-agent.md',
      existingIds: [],
    });
    expect(a).toMatchObject({
      id: 'my-agent',
      label: 'My Agent',
      command: 'claude',
      runner: 'claude',
      agentName: 'My Agent',
      sourceKind: 'claude-global',
      sourcePath: '/x/my-agent.md',
    });
    expect(a.workdir).toBeUndefined();
  });

  it('builds a thin directory agent (workdir, no agentName) with a unique id', () => {
    const d = buildRegisteredAgent({
      name: 'Dir Bot',
      runner: 'pi',
      sourceKind: 'directory',
      sourcePath: '/x/dir-bot',
      existingIds: ['dir-bot'],
    });
    expect(d.id).toBe('dir-bot-2');
    expect(d.workdir).toBe('/x/dir-bot');
    expect(d.runner).toBe('pi');
    expect(d.agentName).toBeUndefined();
  });

  it('authors a claude .md with frontmatter + syntaur: block and refuses overwrite', async () => {
    const dir = join(tmp, 'claude-agents');
    const authored = await authorAgentDef({
      name: 'Researcher',
      runner: 'claude',
      model: 'opus',
      description: 'Researches',
      instructions: 'You research.',
      location: dir,
    });
    expect(authored.sourceKind).toBe('claude-project');
    const content = await readFile(authored.path, 'utf-8');
    expect(content).toContain('name: "Researcher"');
    expect(content).toContain('model: "opus"');
    expect(content).toContain('syntaur:');
    expect(content).toContain('runner: claude');
    expect(content).toContain('You research.');

    await expect(
      authorAgentDef({ name: 'Researcher', runner: 'claude', instructions: 'x', location: dir }),
    ).rejects.toThrow(/refusing to overwrite/);
  });

  it('derives sourceRepo when authoring under <repo>/.claude/agents (Decision 3)', async () => {
    const repo = join(tmp, 'my-repo');
    const authored = await authorAgentDef({
      name: 'Proj Bot',
      runner: 'claude',
      instructions: 'hi',
      location: join(repo, '.claude', 'agents'),
    });
    expect(authored.sourceKind).toBe('claude-project');
    expect(authored.sourceRepo).toBe(repo);
  });

  it('authors a directory AGENTS.md that re-discovers as recommended (Decision 10)', async () => {
    const home = join(tmp, 'home');
    await mkdir(home, { recursive: true });
    const authored = await authorAgentDef({
      name: 'Dir Bot',
      runner: 'pi',
      description: 'A bot',
      instructions: 'Do things.',
      location: home,
    });
    expect(authored.sourceKind).toBe('directory');
    expect(authored.path).toBe(join(home, 'dir-bot'));
    const md = await readFile(join(authored.path, 'AGENTS.md'), 'utf-8');
    expect(md).toContain('syntaur:');
    expect(md).toContain('runner: pi');

    const cands = await discoverAgents({
      claudeGlobal: false,
      claudeProject: false,
      directory: true,
      roots: [home],
      agents: [],
    });
    const dirBot = cands.find((c) => c.name === 'Dir Bot');
    expect(dirBot).toMatchObject({ runner: 'pi', source: 'directory', recommended: true });
  });

  it('requires absolute paths for adoption + authoring (rejects relative)', async () => {
    expect(() => requireAbsolutePath('relative/dir')).toThrow(/absolute/);
    expect(requireAbsolutePath('/abs/dir')).toBe('/abs/dir');
    await expect(inferManualAdd('relative/thing')).rejects.toThrow(/absolute/);
    await expect(
      authorAgentDef({ name: 'X', runner: 'claude', instructions: 'y', location: 'rel/loc' }),
    ).rejects.toThrow(/absolute/);
    await expect(
      authorAgentDef({ name: 'Y', runner: 'pi', instructions: 'z', location: 'rel/loc' }),
    ).rejects.toThrow(/absolute/);
  });

  it('infers a manual-add for a claude .md file and a pi directory', async () => {
    const f = join(tmp, 'foo.md');
    await writeFile(f, '---\nname: foo\ndescription: bar\n---\nbody');
    expect(await inferManualAdd(f)).toMatchObject({
      name: 'foo',
      runner: 'claude',
      sourceKind: 'claude-global',
      sourcePath: f,
    });

    const dir = join(tmp, 'pi-dir');
    await mkdir(join(dir, '.pi'), { recursive: true });
    expect(await inferManualAdd(dir)).toMatchObject({
      name: 'pi-dir',
      runner: 'pi',
      sourceKind: 'directory',
      sourcePath: dir,
    });
  });
});
