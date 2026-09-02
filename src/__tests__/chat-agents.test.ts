import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BASE_SYSTEM_PROMPT,
  BUILTIN_AGENT_DEFINITIONS,
  agentsDir,
  loadAgentDefinitions,
  parseAgentDefinition,
  resolveAgent,
} from '../chat/agents.js';
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
    expect(definitions.map((d) => d.id)).toEqual(['claude', 'codex']);
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
    expect(definitions.map((d) => d.id)).toEqual(['claude', 'codex', 'planner']);
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
    expect(definitions.map((d) => d.id)).toEqual(['claude', 'codex', 'planner']);
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
    expect(def.name).toBe('planner');
    expect(def.color).toBe('slate');
    expect(def.respondsTo).toBe('all-human');
    expect(def.default).toBe(false);
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
