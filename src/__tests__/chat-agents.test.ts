import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AGENT_COLORS,
  AgentDefinitionError,
  AgentWriteError,
  BASE_SYSTEM_PROMPT,
  BUILTIN_AGENT_DEFINITIONS,
  agentAvatar,
  agentsDir,
  deleteAgentDefinition,
  loadAgentDefinitions,
  parseAgentDefinition,
  resolveAgent,
  serializeAgentDefinition,
  toAgentSummary,
  validateAgentInput,
  writeAgentDefinition,
} from '../chat/agents.js';
import type { AgentDefinitionInput } from '../chat/types.js';
import { HARNESSES, isHarnessId, resolveCommand, resolveModeId } from '../chat/harnesses.js';

/**
 * Task 2 — the harness catalog and `~/.syntaur/agents/<id>.md` definitions.
 * Everything here is filesystem + pure parsing; no adapter is spawned.
 */

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-chat-agents-'));
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function writeDefinition(id: string, content: string): Promise<void> {
  const dir = agentsDir(sandbox);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.md`), content, 'utf-8');
}

describe('harness catalog', () => {
  it('carries the measured per-adapter differences', () => {
    expect(HARNESSES.claude.command).toBe('claude-agent-acp');
    expect(HARNESSES.codex.command).toBe('codex-acp');
    // RESULTS.md §"System prompt (03)": claude honours _meta.systemPrompt,
    // codex ignores it and needs a <system> block on the first prompt.
    expect(HARNESSES.claude.systemPromptTransport).toBe('meta');
    expect(HARNESSES.codex.systemPromptTransport).toBe('prompt');
    // The same knob under two config ids.
    expect(HARNESSES.claude.configIds.effort).toBe('effort');
    expect(HARNESSES.codex.configIds.effort).toBe('reasoning_effort');
    // Only codex's read-only mode asks the client for permission.
    expect(HARNESSES.codex.modeIds.ask).toBe('read-only');
    expect(HARNESSES.claude.modeIds.ask).toBe('default');
    expect(HARNESSES.cursor.command).toBe('cursor-agent');
    expect(HARNESSES.cursor.args).toEqual(['acp']);
    expect(HARNESSES.cursor.systemPromptTransport).toBe('prompt');
    expect(HARNESSES.cursor.reattach).toBe('load');
    expect(HARNESSES.cursor.usage).toEqual({ kind: 'none' });
    expect(HARNESSES.cursor.configIds.effort).toBeUndefined();
  });

  it('maps the three role names and passes raw mode ids through', () => {
    expect(resolveModeId(HARNESSES.claude, 'edits')).toBe('acceptEdits');
    expect(resolveModeId(HARNESSES.claude, 'plan')).toBe('plan');
    expect(resolveModeId(HARNESSES.codex, 'edits')).toBe('agent');
    expect(resolveModeId(HARNESSES.codex, 'agent-full-access')).toBe('agent-full-access');
    expect(resolveModeId(HARNESSES.claude, 'bypassPermissions')).toBe('bypassPermissions');
  });

  it('recognises harness ids and rejects anything else', () => {
    expect(isHarnessId('claude')).toBe(true);
    expect(isHarnessId('codex')).toBe(true);
    expect(isHarnessId('cursor')).toBe(true);
    expect(isHarnessId('goose')).toBe(false);
    expect(isHarnessId(undefined)).toBe(false);
  });

  it('returns the install hint when the binary is not on PATH', () => {
    const missing = resolveCommand({
      ...HARNESSES.claude,
      command: 'syntaur-definitely-not-a-real-binary',
    });
    expect(missing.path).toBeNull();
    expect(missing.installHint).toBe(HARNESSES.claude.installHint);

    // `node` is always on PATH in the test runner.
    const found = resolveCommand({ ...HARNESSES.claude, command: 'node' });
    expect(found.path).toMatch(/node$/);
    expect(found.installHint).toBeNull();
  });
});

describe('loadAgentDefinitions', () => {
  it('falls back to the builtins when the directory is absent', async () => {
    const { definitions, errors } = await loadAgentDefinitions(sandbox);
    expect(errors).toEqual([]);
    expect(definitions.map((d) => d.id)).toEqual(['claude', 'codex', 'cursor']);
    expect(definitions.find((d) => d.id === 'claude')?.default).toBe(true);
    expect(definitions.every((d) => d.source === null)).toBe(true);
  });

  it('falls back to the builtins when the directory is empty', async () => {
    await mkdir(agentsDir(sandbox), { recursive: true });
    const { definitions, errors } = await loadAgentDefinitions(sandbox);
    expect(errors).toEqual([]);
    expect(definitions).toHaveLength(BUILTIN_AGENT_DEFINITIONS.length);
  });

  it('lets a user file override a builtin wholesale', async () => {
    await writeDefinition(
      'claude',
      [
        '---',
        'id: claude',
        'name: Reviewer',
        'color: amber',
        'harness: claude',
        'model: claude-opus-5',
        'mode: plan',
        'effort: high',
        'mcpServers: [syntaur, context7]',
        'env: { FOO: bar }',
        'respondsTo: mentions',
        'default: true',
        '---',
        'You review, you do not edit.',
      ].join('\n'),
    );

    const { definitions, errors } = await loadAgentDefinitions(sandbox);
    expect(errors).toEqual([]);
    const claude = definitions.find((d) => d.id === 'claude');
    expect(claude).toBeDefined();
    expect(claude?.name).toBe('Reviewer');
    expect(claude?.color).toBe('amber');
    expect(claude?.model).toBe('claude-opus-5');
    expect(claude?.mode).toBe('plan');
    expect(claude?.effort).toBe('high');
    expect(claude?.mcpServers).toEqual(['syntaur', 'context7']);
    expect(claude?.env).toEqual({ FOO: 'bar' });
    expect(claude?.respondsTo).toBe('mentions');
    expect(claude?.systemPrompt).toBe('You review, you do not edit.');
    expect(claude?.source).toContain('claude.md');
    // The codex builtin is untouched.
    expect(definitions.find((d) => d.id === 'codex')?.source).toBeNull();
  });

  it('adds a new definition alongside the builtins', async () => {
    await writeDefinition(
      'planner',
      ['---', 'id: planner', 'name: Planner', 'harness: codex', '---', 'Plan only.'].join('\n'),
    );
    const { definitions } = await loadAgentDefinitions(sandbox);
    expect(definitions.map((d) => d.id)).toEqual(['claude', 'codex', 'cursor', 'planner']);
    expect(definitions.find((d) => d.id === 'planner')?.harness).toBe('codex');
  });

  it("moves the default to a user definition that claims it", async () => {
    await writeDefinition(
      'planner',
      ['---', 'id: planner', 'harness: codex', 'default: true', '---', 'Plan.'].join('\n'),
    );
    const { definitions } = await loadAgentDefinitions(sandbox);
    expect(definitions.filter((d) => d.default).map((d) => d.id)).toEqual(['planner']);
  });

  it('reports and skips an invalid definition without losing the rest', async () => {
    await writeDefinition('broken', ['---', 'id: broken', 'harness: goose', '---', 'x'].join('\n'));
    await writeDefinition(
      'planner',
      ['---', 'id: planner', 'harness: codex', '---', 'Plan.'].join('\n'),
    );
    const { definitions, errors } = await loadAgentDefinitions(sandbox);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/harness/);
    expect(definitions.map((d) => d.id)).toEqual(['claude', 'codex', 'cursor', 'planner']);
  });

  it('skips My Agent.md and ids with spaces for the slug reason', async () => {
    await writeDefinition(
      'My Agent',
      ['---', 'id: My Agent', 'harness: claude', '---', 'x'].join('\n'),
    );
    await writeDefinition(
      'bad id',
      ['---', 'id: bad id', 'harness: claude', '---', 'x'].join('\n'),
    );
    const { definitions, errors } = await loadAgentDefinitions(sandbox);
    expect(definitions.map((d) => d.id)).toEqual(['claude', 'codex', 'cursor']);
    expect(errors).toHaveLength(2);
    for (const err of errors) {
      expect(err).toMatch(/lowercase slug/);
    }
  });
});

describe('parseAgentDefinition validation', () => {
  const parse = (content: string, id = 'planner') => () => parseAgentDefinition(`${id}.md`, id, content);

  it('rejects a file with no frontmatter', () => {
    expect(parse('Just a body.')).toThrow(/no frontmatter/);
  });

  it('rejects a missing id', () => {
    expect(parse(['---', 'harness: claude', '---', 'x'].join('\n'))).toThrow(/missing `id`/);
  });

  it('rejects an id that does not match the filename', () => {
    expect(parse(['---', 'id: other', 'harness: claude', '---', 'x'].join('\n'))).toThrow(
      /but the file is planner\.md/,
    );
  });

  it('rejects an unknown harness', () => {
    expect(parse(['---', 'id: planner', 'harness: opencode', '---', 'x'].join('\n'))).toThrow(
      /`harness` must be one of/,
    );
  });

  it('rejects an unknown respondsTo', () => {
    expect(
      parse(['---', 'id: planner', 'harness: claude', 'respondsTo: sometimes', '---', 'x'].join('\n')),
    ).toThrow(/`respondsTo` must be one of/);
  });

  it('rejects a non-string mcpServers list', () => {
    expect(
      parse(['---', 'id: planner', 'harness: claude', 'mcpServers: [1, 2]', '---', 'x'].join('\n')),
    ).toThrow(/`mcpServers` must be a list of strings/);
  });

  it('rejects a non-string env map', () => {
    expect(
      parse(['---', 'id: planner', 'harness: claude', 'env: { A: 1 }', '---', 'x'].join('\n')),
    ).toThrow(/`env` must be a map of string values/);
  });

  it('rejects malformed YAML frontmatter', () => {
    expect(parse(['---', 'id: planner', 'harness: [claude', '---', 'x'].join('\n'))).toThrow(
      /invalid YAML frontmatter/,
    );
  });

  it('accepts a definition with no body and falls back to the base prompt', () => {
    const def = parseAgentDefinition('planner.md', 'planner', ['---', 'id: planner', 'harness: claude', '---'].join('\n'));
    expect(def.systemPrompt).toBe(BASE_SYSTEM_PROMPT);
    expect(def.promptIsDefault).toBe(true);
    expect(def.name).toBe('planner');
    expect(def.color).toBe('slate');
    // `mentions` is the parser default too, so `all-human` is opt-in fan-out
    // everywhere (Decision 2), not just for the builtins.
    expect(def.respondsTo).toBe('mentions');
    expect(def.default).toBe(false);
  });

  it('rejects an invalid colour', () => {
    expect(() =>
      parseAgentDefinition(
        'planner.md',
        'planner',
        ['---', 'id: planner', 'harness: claude', 'color: purple', '---', 'x'].join('\n'),
      ),
    ).toThrow(/`color` must be one of violet, emerald, amber, sky, rose, slate/);
  });

  it('rejects an id that is not a slug', () => {
    expect(() =>
      parseAgentDefinition(
        'bad.md',
        'bad',
        ['---', 'id: bad', 'harness: claude', '---', 'x'].join('\n'),
      ),
    ).not.toThrow();
    expect(() =>
      parseAgentDefinition(
        'UPPER.md',
        'UPPER',
        ['---', 'id: UPPER', 'harness: claude', '---', 'x'].join('\n'),
      ),
    ).toThrow(/lowercase slug/);
  });

  it('handles CRLF line endings', () => {
    const def = parseAgentDefinition(
      'planner.md',
      'planner',
      '---\r\nid: planner\r\nharness: codex\r\n---\r\nPlan only.\r\n',
    );
    expect(def.harness).toBe('codex');
    expect(def.systemPrompt).toBe('Plan only.');
  });
});

describe('resolveAgent', () => {
  it('picks the requested id, else the default', async () => {
    const { definitions } = await loadAgentDefinitions(sandbox);
    expect(resolveAgent(definitions, 'codex')?.id).toBe('codex');
    expect(resolveAgent(definitions)?.id).toBe('claude');
    expect(resolveAgent(definitions, 'nope')).toBeNull();
    expect(resolveAgent([], undefined)).toBeNull();
  });
});

describe('description, avatar and the API summary (Task 1)', () => {
  it('parses `description` and `avatar`', () => {
    const def = parseAgentDefinition(
      'planner.md',
      'planner',
      ['---', 'id: planner', 'harness: claude', 'description: Plans, never edits', 'avatar: "🗺️"', '---', 'x'].join('\n'),
    );
    expect(def.description).toBe('Plans, never edits');
    expect(def.avatar).toBe('🗺️');
  });

  it('rejects an avatar longer than an emoji', () => {
    expect(() =>
      parseAgentDefinition(
        'planner.md',
        'planner',
        ['---', 'id: planner', 'harness: claude', 'avatar: planner', '---', 'x'].join('\n'),
      ),
    ).toThrow(/`avatar` must be an emoji/);
  });

  it('falls back to the name initial when no avatar is set', () => {
    const def = parseAgentDefinition(
      'planner.md',
      'planner',
      ['---', 'id: planner', 'name: Planner', 'harness: claude', '---', 'x'].join('\n'),
    );
    expect(agentAvatar(def)).toBe('P');
  });

  it('summarizes a definition with everything the picker shows read-only', () => {
    const def = parseAgentDefinition(
      'planner.md',
      'planner',
      [
        '---',
        'id: planner',
        'name: Planner',
        'harness: claude',
        'model: claude-opus-5',
        'mode: plan',
        'effort: high',
        'respondsTo: mentions',
        'description: Plans, never edits',
        '---',
        'x',
      ].join('\n'),
    );
    expect(toAgentSummary(def)).toMatchObject({
      id: 'planner',
      name: 'Planner',
      harness: 'claude',
      model: 'claude-opus-5',
      mode: 'plan',
      effort: 'high',
      respondsTo: 'mentions',
      description: 'Plans, never edits',
      avatar: 'P',
      source: 'planner.md',
      builtin: false,
      overridesBuiltin: false,
    });
  });

  it('reports both builtins as `mentions`, so neither answers every message', () => {
    expect(BUILTIN_AGENT_DEFINITIONS.map((d) => d.respondsTo)).toEqual(['mentions', 'mentions', 'mentions']);
  });

  it('reports every builtin with promptIsDefault', () => {
    for (const builtin of BUILTIN_AGENT_DEFINITIONS) {
      expect(builtin.promptIsDefault).toBe(true);
      expect(toAgentSummary(builtin).builtin).toBe(true);
    }
  });
});

const fullInput = (): AgentDefinitionInput => ({
  id: 'planner',
  name: 'Planner',
  color: 'amber',
  harness: 'claude',
  model: 'claude-opus-5',
  mode: 'plan',
  effort: 'high',
  mcpServers: ['syntaur', 'context7'],
  env: { FOO: 'bar' },
  respondsTo: 'mentions',
  default: false,
  description: 'Plans, never edits',
  avatar: '🗺️',
  systemPrompt: 'You plan, you do not edit.',
});

describe('serialize and validate (Task 1)', () => {
  it('serialises frontmatter keys in Decision 1 order', () => {
    const input = fullInput();
    const serialized = serializeAgentDefinition(input);
    const fm = serialized.split('---')[1].trim();
    const keys: string[] = [];
    for (const line of fm.split('\n')) {
      if (/^\s/.test(line)) continue;
      const match = line.match(/^([A-Za-z0-9_]+):/);
      if (match) keys.push(match[1]);
    }
    expect(keys).toEqual([
      'id',
      'name',
      'color',
      'harness',
      'model',
      'mode',
      'effort',
      'mcpServers',
      'env',
      'respondsTo',
      'default',
      'description',
      'avatar',
    ]);
  });

  it('round-trips every field through serialize and parse', () => {
    const input = fullInput();
    const serialized = serializeAgentDefinition(input);
    const def = parseAgentDefinition('planner.md', 'planner', serialized);
    expect(def).toMatchObject({
      id: input.id,
      name: input.name,
      color: input.color,
      harness: input.harness,
      model: input.model,
      mode: input.mode,
      effort: input.effort,
      mcpServers: input.mcpServers,
      env: input.env,
      respondsTo: input.respondsTo,
      default: input.default,
      description: input.description,
      avatar: input.avatar,
      systemPrompt: input.systemPrompt,
      source: 'planner.md',
    });
    expect(validateAgentInput(sandbox, input)).toMatchObject({
      id: input.id,
      systemPrompt: input.systemPrompt,
    });
  });

  it('serialises an empty prompt with no body and reloads with promptIsDefault', () => {
    const input = { ...fullInput(), systemPrompt: '' };
    const serialized = serializeAgentDefinition(input);
    expect(serialized.endsWith('---\n')).toBe(true);
    expect(serialized).not.toContain(BASE_SYSTEM_PROMPT);
    const def = parseAgentDefinition('planner.md', 'planner', serialized);
    expect(def.promptIsDefault).toBe(true);
    expect(def.systemPrompt).toBe(BASE_SYSTEM_PROMPT);
  });

  it('exposes AgentDefinitionError.reason without the file path', () => {
    try {
      parseAgentDefinition('/secret/agents/planner.md', 'planner', 'no frontmatter');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentDefinitionError);
      const e = err as AgentDefinitionError;
      expect(e.reason).toBe('no frontmatter block');
      expect(e.reason).not.toContain('/secret');
      expect(e.message).toContain('/secret');
    }
  });

  it('lists the closed colour set', () => {
    expect(AGENT_COLORS).toEqual(['violet', 'emerald', 'amber', 'sky', 'rose', 'slate']);
  });
});

describe('writeAgentDefinition (Task 1)', () => {
  it('flips the other file default when a new file claims default', async () => {
    await writeAgentDefinition(sandbox, {
      id: 'alpha',
      name: 'Alpha',
      color: 'violet',
      harness: 'claude',
      respondsTo: 'mentions',
      default: true,
      systemPrompt: '',
    });
    await writeAgentDefinition(sandbox, {
      id: 'planner',
      name: 'Planner',
      color: 'amber',
      harness: 'codex',
      respondsTo: 'mentions',
      default: true,
      systemPrompt: 'Plan.',
    });
    const { definitions } = await loadAgentDefinitions(sandbox);
    const defaults = definitions.filter((d) => d.default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.id).toBe('planner');
    const alpha = definitions.find((d) => d.id === 'alpha');
    expect(alpha?.default).toBe(false);
    const alphaRaw = await readDefinitionRaw('alpha');
    expect(alphaRaw).toMatch(/default: false/);
  });

  it('rejects claude override with default false while claude is the default', async () => {
    await expect(
      writeAgentDefinition(sandbox, {
        id: 'claude',
        name: 'Claude',
        color: 'violet',
        harness: 'claude',
        respondsTo: 'mentions',
        default: false,
        systemPrompt: '',
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: '`claude` is the default agent — make another agent the default first',
    });
  });

  it('accepts claude override with default false once another agent is default', async () => {
    await writeAgentDefinition(sandbox, {
      id: 'planner',
      name: 'Planner',
      color: 'amber',
      harness: 'codex',
      respondsTo: 'mentions',
      default: true,
      systemPrompt: '',
    });
    const def = await writeAgentDefinition(sandbox, {
      id: 'claude',
      name: 'Claude',
      color: 'violet',
      harness: 'claude',
      respondsTo: 'mentions',
      default: false,
      systemPrompt: '',
    });
    expect(def.default).toBe(false);
    expect(def.source).toContain('claude.md');
  });

  it('writes a claude override from the builtin with no body when the prompt is default', async () => {
    const builtin = BUILTIN_AGENT_DEFINITIONS.find((d) => d.id === 'claude')!;
    await writeAgentDefinition(sandbox, {
      id: builtin.id,
      name: builtin.name,
      color: builtin.color,
      harness: builtin.harness,
      respondsTo: builtin.respondsTo,
      default: true,
      description: builtin.description,
      systemPrompt: '',
    });
    const raw = await readDefinitionRaw('claude');
    expect(raw.trimEnd()).toMatch(/---\n[\s\S]*---$/);
    expect(raw).not.toContain(BASE_SYSTEM_PROMPT);
    const { definitions } = await loadAgentDefinitions(sandbox);
    const claude = definitions.find((d) => d.id === 'claude');
    expect(claude?.promptIsDefault).toBe(true);
    expect(toAgentSummary(claude!).overridesBuiltin).toBe(true);
  });
});

describe('deleteAgentDefinition (Task 1)', () => {
  it('restores the builtin after deleting an override', async () => {
    await writeAgentDefinition(sandbox, {
      id: 'claude',
      name: 'Custom Claude',
      color: 'violet',
      harness: 'claude',
      respondsTo: 'mentions',
      default: true,
      systemPrompt: 'Custom.',
    });
    const { restoredBuiltin } = await deleteAgentDefinition(sandbox, 'claude');
    expect(restoredBuiltin).toBe(true);
    const { definitions } = await loadAgentDefinitions(sandbox);
    const claude = definitions.find((d) => d.id === 'claude');
    expect(claude?.source).toBeNull();
    expect(claude?.name).toBe('Claude');
  });

  it('refuses to delete a builtin with no file', async () => {
    await expect(deleteAgentDefinition(sandbox, 'codex')).rejects.toMatchObject({
      status: 409,
      message: '`codex` is built in and has no file to delete — create one with the same id to override it',
    });
    expect(await deleteAgentDefinition(sandbox, 'codex').catch((e) => e)).toBeInstanceOf(AgentWriteError);
  });

  it('leaves exactly one default after deleting the default file', async () => {
    await writeAgentDefinition(sandbox, {
      id: 'planner',
      name: 'Planner',
      color: 'amber',
      harness: 'codex',
      respondsTo: 'mentions',
      default: true,
      systemPrompt: '',
    });
    await deleteAgentDefinition(sandbox, 'planner');
    const { definitions } = await loadAgentDefinitions(sandbox);
    expect(definitions.filter((d) => d.default)).toHaveLength(1);
    expect(definitions.find((d) => d.default)?.id).toBe('claude');
  });
});

async function readDefinitionRaw(id: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  return readFile(join(agentsDir(sandbox), `${id}.md`), 'utf-8');
}
